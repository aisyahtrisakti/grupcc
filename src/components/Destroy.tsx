import React, {useContext, useState} from 'react'
import {Box, Text} from 'ink'
import {Task, TaskState} from './Task'
import {getStackId, NessContext} from '../context'
import {
  clearS3Bucket,
  deleteCloudFormationStack,
  deployStack,
  getCloudFormationFailureReason,
  getCloudFormationStackOutputs,
  getStack,
} from '../providers/aws'
import * as events from '../utils/events'
import {generateCsp} from '../utils/csp'

export const Destroy: React.FunctionComponent = () => {
  const context = useContext(NessContext)
  const {settings} = context
  const {domain, dir, csp} = settings || {}

  const [error, setError] = useState<string>()

  const track = async (event: string, detail = '') => {
    await events.emit({
      event,
      command: 'destroy',
      detail,
      domain: domain || '',
      options: settings || {},
    })
  }

  const handleError = async (stack: string, error: string) => {
    const reason = await getCloudFormationFailureReason(getStackId(stack))
    setError(`${error}${reason ? `:\n\n${reason}` : ''}`)
  }

  const destroy: () => Promise<TaskState> = async () => {
    track('started')

    const webStack = getStackId('web')

    const webStackOutputs = await getCloudFormationStackOutputs(webStack)
    if (!webStackOutputs) {
      setError("Couldn't find site. Are you sure you've deployed (from this branch)?")
      return TaskState.Failure
    }

    try {
      await clearS3Bucket(webStackOutputs!.BucketName)
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
    }

    // We first have to deploy the web stack without the certificate so that it
    // removes the dependency on the alias stack.
    const stack = await getStack('web', {
      DomainName: domain,
      RedirectSubDomainNameWithDot: settings?.redirectWww ? 'www.' : undefined,
      DefaultRootObject: settings?.indexDocument,
      DefaultErrorObject: settings?.spa ? settings?.indexDocument : settings?.errorDocument,
      DefaultErrorResponseCode: settings?.spa ? '200' : '404',
      IncludeCloudFrontAlias: 'false',
      ContentSecurityPolicy: csp && csp !== 'auto' ? csp : await generateCsp(dir!),
    })

    await deployStack({stack})

    try {
      await deleteCloudFormationStack(getStackId('alias'))
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      handleError('alias', 'Unable to delete site')
      return TaskState.Failure
    }

    // We first have to delete so that it goes to DELETE_FAILED, then we can
    // specify the resources to retain (the edge lambdas)
    try {
      await deleteCloudFormationStack(webStack)
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
    }

    try {
      await deleteCloudFormationStack(webStack, ['ViewerRequestFunction', 'OriginResponseFunction'])
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      handleError('web', 'Unable to delete site')
      return TaskState.Failure
    }

    try {
      await deleteCloudFormationStack(getStackId('domain'))
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      handleError('domain', 'Unable to delete site')
      return TaskState.Failure
    }

    try {
      await deleteCloudFormationStack(getStackId('support'))
    } catch (error) {
      if (error instanceof Error) {
        track('error', error.message)
      }
      handleError('support', 'Unable to delete site')
      return TaskState.Failure
    }

    track('finished')

    return TaskState.Success
  }

  return (
    <Box flexDirection='column'>
      <Task name='Destroying site' note='☕ this could take a while' action={destroy} />

      {error && (
        <Box paddingTop={1}>
          <Text color='red'>{error}</Text>
        </Box>
      )}
    </Box>
  )
}
