import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { z } from 'zod'
import { SessionConfigItemSelectorSchema } from '@hapi/protocol/schemas'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { logger } from '@/ui/logger'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { readLiveSessionConfig, type LiveSessionConfig } from '../sessionInventory'
import { readSessionConfigDetail, writeSessionConfigEnabled } from '../sessionConfigDetail'
import type { SessionPromptLive } from '../sessionPrompts'

export type SessionConfigContext = {
    flavor?: string | null
    startingMode?: string | null
    sessionId?: string
    tools?: string[]
    skills?: LiveSessionConfig['skills']
    promptLive?: SessionPromptLive
}

export type SessionConfigResponse = { success: true } & LiveSessionConfig | { success: false; error: string }

export function registerSessionConfigHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    getContext: () => SessionConfigContext = () => ({})
): void {
    rpcHandlerManager.registerHandler<unknown, SessionConfigResponse>(RPC_METHODS.ListSessionConfig, async (params: unknown) => {
        logger.debug('List session config request')
        const parsed = z.object({
            fresh: z.boolean().optional(),
            check: z.string().min(1).max(200).optional(),
        }).safeParse(params ?? {})
        const request = parsed.success ? parsed.data : {}
        try {
            const context = getContext()
            const config = await readLiveSessionConfig({
                cwd: workingDirectory,
                flavor: context.flavor,
                startingMode: context.startingMode,
                sessionId: context.sessionId,
                tools: context.tools,
                skills: context.skills,
                promptLive: context.promptLive,
                fresh: request.fresh,
                check: request.check,
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
                startingMode: context.startingMode,
                promptLive: context.promptLive,
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
