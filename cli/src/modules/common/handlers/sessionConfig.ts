import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { z } from 'zod'
import { SessionConfigItemSelectorSchema } from '@hapi/protocol/schemas'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { logger } from '@/ui/logger'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { readLiveSessionConfig, type LiveSessionConfig } from '../sessionInventory'
import { readSessionConfigDetail, writeSessionConfigEnabled } from '../sessionConfigDetail'

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

    rpcHandlerManager.registerHandler(RPC_METHODS.GetSessionConfigItem, async (params: unknown) => {
        const selector = SessionConfigItemSelectorSchema.safeParse(params)
        if (!selector.success) return rpcError('Invalid session config')
        try {
            const context = getContext()
            const detail = await readSessionConfigDetail({
                cwd: workingDirectory,
                flavor: context.flavor,
                sessionId: context.sessionId,
                tools: context.tools,
                selector: selector.data,
            })
            if ('error' in detail) return rpcError(detail.error)
            return { success: true, ...detail }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to read session config'))
        }
    })

    rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfigItemEnabled, async (params: unknown) => {
        const parsed = SessionConfigItemSelectorSchema.extend({ enabled: z.boolean() }).safeParse(params)
        if (!parsed.success) return rpcError('Invalid session config')
        try {
            const context = getContext()
            const { enabled, ...selector } = parsed.data
            const result = await writeSessionConfigEnabled({
                cwd: workingDirectory,
                flavor: context.flavor,
                sessionId: context.sessionId,
                tools: context.tools,
                selector,
                enabled,
            })
            if ('error' in result) return rpcError(result.error)
            return { success: true, enabled: result.enabled }
        } catch (error) {
            return rpcError(getErrorMessage(error, 'Failed to update session config'))
        }
    })
}
