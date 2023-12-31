import * as dns from 'dns'

import React, {useState, useContext, useEffect} from 'react'
import {Box, Newline, Text} from 'ink'

import {Task, TaskState} from './Task'
import {getStackId, NessContext} from '../context'
import {
  cleanupHostedZoneRecords,
  deleteHostedZoneRecords,
  deployStack,
  getCertificateArn,
  getCloudFormationFailureReason,
  getDistribution,
  getHostedZone,
  getHostedZoneARecord,
  getHostedZoneNameservers,
  getStack,
  invalidateDistribution,
  syncLocalToS3,
} from '../providers/aws'
import {delay} from '../utils'
import * as events from '../utils/events'
import {generateCsp} from '../utils/csp'
import {buildNextApp, NextBuild} from '../utils/next'

export const Deploy: React.FunctionComponent = () => {
  const context = useContext(NessContext)
  const [domainDeployed, setDomainDeployed] = useState(false)
  const [webDeployed, setWebDeployed] = useState(false)
  const [webAssetsPushed, setWebAssetsPushed] = useState(false)
  const [aliasDeployed, setAliasDeployed] = useState(false)
  const [webRedeployed, setWebRedeployed] = useState(false)

  const [error, setError] = useState<string>()

  const [siteUrl, setSiteUrl] = useState<string>()
  const [nameservers, setNameservers] = useState<string[]>()
  const [domainOutputs, setDomainOutputs] = useState<Record<string, string>>()
  const [webOutputs, setWebOutputs] = useState<Record<string, string>>()
  const [needsRedeploy, setNeedsRedeploy] = useState(true)
  const [dnsValidated, setDnsValidated] = useState(false)
  const [nextBuild, setNextBuild] = useState<NextBuild>()
  const {settings, framework} = context
  const {domain, dir, csp, verbose} = settings || {}

  const hasCustomDomain = domain !== undefined
  const isNextJs = framework && framework.name === 'next'

  const track = async (event: string, detail = '') => {
    await events.emit({
      event,
      command: 'deploy',
      detail,
      domain: domain || '',
      options: settings || {},
    })
  }

  const handleError = async (stack: string, error: string) => {
    const reason = await getCloudFormationFailureReason(getStackId(stack))
    setError(`${error}${reason ? `:\n\n${reason}` : ''}`)
  }

  const deployDomain: () => Promise<TaskState> = async () => {
    try {
      const zone = await getHostedZone(domain!)
      const stack = await getStack('domain', {Name: domain, ExistingHostedZoneId: zone?.id})
      const outputs = await deployStack({stack})
      setDomainOutputs(outputs)
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      return TaskState.Failure
    }

    return TaskState.Success
  }

  const handleDomainDeployed = async (state: TaskState) => {
    if (state === TaskState.Failure) {
      await handleError('domain', 'Failed to create your custom domain')
      return
    }

    setDomainDeployed(true)
  }

  const deploySupportStack: () => Promise<Record<string, string> | undefined> = async () => {
    try {
      const stack = await getStack('support', {})
      const outputs = await deployStack({stack})
      return outputs
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      return undefined
    }
  }

  const deployWeb: () => Promise<TaskState> = async () => {
    const {
      BucketName: supportBucket,
      DefaultCachePolicyArn,
      ImageCachePolicyArn,
      StaticCachePolicyArn,
      ImageOriginRequestPolicyArn,
    } = (await deploySupportStack()) || {}
    const webStackId = await getStackId('web')

    const certificateArn = domain ? await getCertificateArn(domain) : undefined
    const existingDistribution = domain ? await getDistribution(domain) : undefined
    const needsRedeploy = certificateArn === undefined || existingDistribution !== undefined

    if (needsRedeploy) setNeedsRedeploy(needsRedeploy)

    // For next, we need to build lambdas for @edge deploy
    let nextBuildLocal = nextBuild
    if (isNextJs && !nextBuildLocal) {
      nextBuildLocal = await buildNextApp()
      setNextBuild(nextBuildLocal)

      await syncLocalToS3({
        dir: nextBuildLocal.lambdaBuildDir,
        bucket: supportBucket,
        prefix: `${webStackId}/`,
        prune: true,
        verbose: verbose,
      })
    }

    const getLambdaPath = (base: string | undefined): string | undefined => {
      return base ? `${webStackId}/${base}` : undefined
    }

    try {
      const stack = await getStack('web', {
        DomainName: domain,
        RedirectSubDomainNameWithDot: settings?.redirectWww ? 'www.' : undefined,
        DefaultRootObject: isNextJs ? '' : settings?.indexDocument,
        DefaultErrorObject: settings?.spa ? settings?.indexDocument : settings?.errorDocument,
        DefaultErrorResponseCode: settings?.spa ? '200' : '404',
        ExistingCertificate: certificateArn,
        IncludeCloudFrontAlias: existingDistribution || !certificateArn ? 'false' : 'true',
        ContentSecurityPolicy: csp && csp !== 'auto' ? csp : await generateCsp(dir!),
        LambdaBucket: supportBucket,
        DefaultCachePolicyArn,
        ImageCachePolicyArn,
        StaticCachePolicyArn,
        ImageOriginRequestPolicyArn,
        IsNextJs: String(isNextJs),
        NextJsDefaultLambdaKey: isNextJs
          ? getLambdaPath(nextBuildLocal?.defaultLambdaPath)
          : undefined,
        NextJsImageLambdaKey: isNextJs ? getLambdaPath(nextBuildLocal?.imageLambdaPath) : undefined,
        NextJsApiLambdaKey: isNextJs ? getLambdaPath(nextBuildLocal?.apiLambdaPath) : undefined,
        NextJsImagePath: isNextJs ? nextBuildLocal?.imagePath : undefined,
        NextJsDataPath: isNextJs ? nextBuildLocal?.dataPath : undefined,
        NextJsBasePath: isNextJs ? nextBuildLocal?.basePath : undefined,
        NextJsStaticPath: isNextJs ? nextBuildLocal?.staticPath : undefined,
        NextJsApiPath: isNextJs ? nextBuildLocal?.apiPath : undefined,
        NextJsRegenerationLambdaKey: isNextJs
          ? getLambdaPath(nextBuildLocal?.regenerationLambdaPath)
          : undefined,
      })

      const outputs = await deployStack({stack})
      setWebOutputs(outputs)
      setSiteUrl(outputs.URL)
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      return TaskState.Failure
    }

    return TaskState.Success
  }

  const handleWebDeployed = async (state: TaskState) => {
    if (state === TaskState.Failure) {
      await handleError('web', 'Failed to deploy your site')
      return
    }

    setWebDeployed(true)
  }

  const pushWebAssets: () => Promise<TaskState> = async () => {
    const bucket = webOutputs!.BucketName
    const push = async (options: {
      dir: string
      prune?: boolean
      cacheControl?: string
      prefix?: string
    }) => syncLocalToS3({...options, bucket, verbose: verbose})

    try {
      if (nextBuild) {
        const {assets} = nextBuild

        Object.keys(assets).forEach(async (key) => {
          const {path: assetPath, cacheControl, prefix} = assets[key]
          await push({dir: assetPath, cacheControl, prefix})
        })
      } else {
        await push({dir: dir!, prune: true})
      }

      if (webOutputs?.DistributionId) {
        await invalidateDistribution(
          webOutputs.DistributionId,
          nextBuild?.invalidationPaths || undefined,
        )
      }
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      return TaskState.Failure
    }

    return TaskState.Success
  }

  const handleWebAssetsPushed = async (state: TaskState) => {
    if (state === TaskState.Failure) {
      setError('Failed to push assets to S3')
      return
    }

    setWebAssetsPushed(true)
  }

  const handleWebRedeployed = async (state: TaskState) => {
    if (state === TaskState.Failure) {
      await handleError('web', 'Failed to point custom domain at your site')
      return
    }

    setWebRedeployed(true)
  }

  const deployAlias: () => Promise<TaskState> = async () => {
    try {
      const hostedZoneId = domainOutputs?.HostedZoneId!
      const aRecord = await getHostedZoneARecord(hostedZoneId, domain)

      // We have to do this the first time we deploy since we dropped the CDK
      if (aRecord && aRecord.AliasTarget?.DNSName !== `${webOutputs?.DistributionDomainName}.`) {
        await deleteHostedZoneRecords(hostedZoneId, [aRecord])
      }

      const stack = await getStack('alias', {
        DomainStack: domainOutputs?.StackName,
        WebStack: webOutputs?.StackName,
        RedirectSubDomainNameWithDot: settings?.redirectWww ? 'www.' : undefined,
      })

      await deployStack({stack})

      // We need to cleanup the record created by ACM when validating the cert
      await cleanupHostedZoneRecords(hostedZoneId)
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      return TaskState.Failure
    }

    return TaskState.Success
  }

  const handleAliasDeployed = async (state: TaskState) => {
    if (state === TaskState.Failure) {
      await handleError('alias', 'Failed to setup SSL for your custom domain')
      return
    }

    setAliasDeployed(true)
  }

  const validateDns = async (): Promise<TaskState> => {
    if (!hasCustomDomain) return TaskState.Skipped

    while (true) {
      try {
        const records = await dns.promises.resolveTxt(`ness.${domain!}`)
        if (records.flat().find((r) => r.toLowerCase().includes('ness'))) {
          return TaskState.Success
        }
      } catch (error) {
        if (error instanceof Error) {
          track('error', error.message)
        }
      } finally {
        await delay(1000)
      }

      if (!nameservers) {
        const {hostedZoneId} = domainOutputs || {}
        if (!hostedZoneId) return TaskState.Failure

        const nameservers = await getHostedZoneNameservers(hostedZoneId)
        setNameservers(nameservers)
      }
    }
  }

  const onDnsValidated = () => {
    setDnsValidated(true)
  }

  const finished =
    webDeployed &&
    webAssetsPushed &&
    (!hasCustomDomain || webRedeployed || (!needsRedeploy && aliasDeployed))

  useEffect(() => {
    track('started')
  }, [])

  useEffect(() => {
    if (finished) track('finished')
  }, [finished])

  return (
    <Box flexDirection='column'>
      <Task
        name='Deploying web infrastructure'
        note='☕ this could take a while'
        action={deployWeb}
        onComplete={handleWebDeployed}
      />
      {webDeployed && (
        <Task
          name={`Publishing '${dir}' directory to AWS`}
          action={pushWebAssets}
          onComplete={handleWebAssetsPushed}
        />
      )}
      {hasCustomDomain && (
        <Task
          name={`Setting up custom domain (${domain})`}
          action={deployDomain}
          onComplete={handleDomainDeployed}
          persist={false}
        />
      )}
      {domainDeployed && (
        <Task
          name='Validating custom domain DNS'
          action={validateDns}
          persist={false}
          onComplete={onDnsValidated}
        />
      )}
      {nameservers && !dnsValidated && (
        <Box paddingTop={1} paddingLeft={2}>
          <Text color='gray'>
            Configure your domain registrar with the following nameservers:
            <Newline />
            <Newline />
            <Text color='cyan'>{nameservers.join('\n')}</Text>
          </Text>
        </Box>
      )}
      {webDeployed && dnsValidated && (
        <Task
          name='Setting up SSL'
          action={deployAlias}
          onComplete={handleAliasDeployed}
          success='Finalizing custom domain'
          persist={!needsRedeploy}
        />
      )}
      {aliasDeployed && needsRedeploy && (
        <Task name='Finalizing custom domain' action={deployWeb} onComplete={handleWebRedeployed} />
      )}
      {finished && (
        <Box paddingTop={1}>
          <Text>
            <Text>🎉 Site successfully deployed:</Text>
            <Newline />
            <Text>{siteUrl}</Text>
          </Text>
        </Box>
      )}
      {error && (
        <Box paddingTop={1}>
          <Text color='red'>{error}</Text>
        </Box>
      )}
    </Box>
  )
}
