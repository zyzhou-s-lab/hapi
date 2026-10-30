import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { logger } from '@/ui/logger'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { readLiveSessionConfig, type LiveSessionConfig } from '../sessionInventory'

export type SessionConfigContext = {
    flavor?: string | null
    startingMode?: string | null
    sessionId?: string
    tools?: string[]
    skills?: LiveSessionConfig['skills']
}

export type SessionConfigResponse = { success: true } & LiveSessionConfig | { success: false; error: string }

export function registerSessionConfigHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    getContext: () => SessionConfigContext = () => ({})
): void {
    rpcHandlerManager.registerHandler<Record<string, never>, SessionConfigResponse>(RPC_METHODS.ListSessionConfig, async () => {
        logger.debug('List session config request')
        try {
            const context = getContext()
            const config = await readLiveSessionConfig({
                cwd: workingDirectory,
                flavor: context.flavor,
                startingMode: context.startingMode,
                sessionId: context.sessionId,
                tools: context.tools,
                skills: context.skills,
            })
            return { success: true, ...config }
        } catch (error) {
            logger.debug('Failed to read session config:', error)
            return rpcError(getErrorMessage(error, 'Failed to read session config'))
        }
    })
}
