import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

const handlers = new Map<string, (payload?: unknown) => Promise<unknown>>()
const startup: { config: unknown } = { config: null }

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        api: {},
        sessionInfo: { id: 'session-startup', metadata: {} },
        session: {
            sessionId: 'session-startup',
            rpcHandlerManager: {
                registerHandler: (method: string, handler: (payload?: unknown) => Promise<unknown>) => {
                    handlers.set(method, handler)
                },
            },
            updateMetadata: vi.fn((update: (metadata: Record<string, unknown>) => Record<string, unknown>) => update({})),
            getMetadata: () => ({}),
            onUserMessage: vi.fn(),
            onCancelQueuedMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            discardPendingHubPromptEcho: vi.fn(),
            emitMessagesConsumed: vi.fn(),
        },
    })),
    bootstrapExistingSession: vi.fn(),
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => {
        const handler = handlers.get(RPC_METHODS.ListSessionConfig)
        if (!handler) throw new Error('config handler was not registered')
        startup.config = await handler()
        return { url: 'http://127.0.0.1:9', stop: () => undefined, toolNames: [] }
    }),
    toClaudeAllowedHapiMcpTools: (tools: string[]) => tools,
}))

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({ port: 1, token: 't', stop: () => undefined })),
}))

vi.mock('@/modules/common/hooks/generateHookSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/common/hooks/generateHookSettings')>()
    return {
        ...actual,
        generateHookSettingsFile: () => '/tmp/hooks.json',
        cleanupHookSettingsFile: () => undefined,
    }
})

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: () => ({
        registerProcessHandlers: () => undefined,
        cleanup: async () => undefined,
        cleanupAndExit: async () => undefined,
        markCrash: () => undefined,
        setExitCode: () => undefined,
        setArchiveReason: () => undefined,
        setSessionEndReason: () => undefined,
    }),
    createModeChangeHandler: () => () => undefined,
    setControlledByUser: () => undefined,
}))

vi.mock('@/claude/loop', () => ({
    loop: async () => undefined,
}))

vi.mock('@/claude/sdk/metadataExtractor', () => ({
    extractSDKMetadata: async () => ({ slashCommands: [], tools: [], skills: [] }),
    classifyClaudeSlashCatalog: () => ({ skills: [], commands: [] }),
}))


vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: () => undefined,
}))

vi.mock('@/agent/localHandoff', () => ({
    registerLocalHandoffHandler: () => undefined,
}))

import { runClaude } from './runClaude'

describe('runClaude session config during startup', () => {
    const dirs: string[] = []

    afterEach(() => {
        handlers.clear()
        startup.config = null
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    it('answers listSessionConfig before custom prompt state is initialized', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-claude-startup-'))
        dirs.push(cwd)
        await runClaude({ workingDirectory: cwd, startingMode: 'remote', startedBy: 'terminal' })
        const result = startup.config as {
            success?: boolean
            error?: string
            prompts?: { system?: { items?: Array<{ title: string }> } }
        }
        expect(result?.success, JSON.stringify(result)).toBe(true)
        expect(result?.error).toBeUndefined()
        expect(result?.prompts?.system?.items?.[0]?.title).toBe('append-system-prompt')
    })
})
