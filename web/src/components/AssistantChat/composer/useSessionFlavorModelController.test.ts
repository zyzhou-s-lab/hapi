import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { CursorModelSummary, Session } from '@/types/api'
import { useSessionFlavorModelController } from './useSessionFlavorModelController'

const mocks = vi.hoisted(() => ({
    hapticNotification: vi.fn(),
    abortSession: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setCollaborationMode: vi.fn(async () => {}),
    setCopilotAgentMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setResumeWithSessionModel: vi.fn(async () => {}),
    setModelReasoningEffort: vi.fn(async () => {}),
    setServiceTier: vi.fn(async () => {}),
    setEffort: vi.fn(async () => {}),
    switchCcSwitchProvider: vi.fn(async () => 'session-1'),
    refreshOmpModels: vi.fn(async () => {}),
    refetchOmpModels: vi.fn(async () => {}),
    refetchOmpThinking: vi.fn(async () => {}),
    agyModelsState: {
        availableModels: [] as Array<{ modelId: string; name?: string }>,
        currentModelId: null as string | null,
        isLoading: false,
        error: null as string | null,
        refetch: vi.fn(),
    },
    codexModelsState: {
        collaborationModeSupported: false,
        models: [] as Array<{
            id: string
            model: string
            displayName: string
            description: string
            isDefault: boolean
            defaultReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
            supportedReasoningEfforts: string[]
            serviceTiers?: string[]
        }>,
        error: null as string | null,
    },
    cursorModelsState: {
        availableModels: [] as CursorModelSummary[],
        cliModelSkus: [] as CursorModelSummary[],
        currentModelId: null as string | null,
        error: null as string | null,
        isLoading: false,
    },
    machineCursorModelsState: {
        availableModels: [] as CursorModelSummary[],
        cliModelSkus: [] as CursorModelSummary[],
        error: null as string | null,
        isLoading: false,
    },
    opencodeModelsState: {
        availableModels: [] as Array<{ modelId: string; name?: string }>,
        error: null as string | null,
    },
    ompModelsState: {
        availableModels: [] as Array<{ provider: string; modelId: string; name: string }>,
        currentModel: null as { provider: string; modelId: string } | null,
        error: null as string | null,
        isRefreshing: false,
        isFetching: false,
    },
    ompThinkingState: {
        state: null as {
            supportedLevels: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>
            supportsThinking: boolean
            configured?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
        } | null,
        options: [] as Array<{ value: string | null; label: string }>,
        error: null as string | null,
    },
    grokModelsState: {
        availableModels: [] as Array<{ modelId: string; name?: string }>,
        error: null as string | null,
    },
    copilotModelsState: {
        availableModels: [] as Array<{ modelId: string; name?: string }>,
        error: null as string | null,
    },
    piModelsState: {
        availableModels: [] as Array<{ provider: string; modelId: string; name?: string; contextWindow?: number }>,
        error: null as string | null,
    },
    ccSwitchProvidersState: {
        available: false,
        providers: [] as Array<{ id: string; name: string }>,
        currentProviderId: null as string | null,
    },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: mocks.hapticNotification,
            impact: vi.fn(),
            selection: vi.fn(),
        },
    }),
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        abortSession: mocks.abortSession,
        switchSession: mocks.switchSession,
        setPermissionMode: mocks.setPermissionMode,
        setCollaborationMode: mocks.setCollaborationMode,
        setCopilotAgentMode: mocks.setCopilotAgentMode,
        setModel: mocks.setModel,
        setResumeWithSessionModel: mocks.setResumeWithSessionModel,
        setModelReasoningEffort: mocks.setModelReasoningEffort,
        setServiceTier: mocks.setServiceTier,
        setEffort: mocks.setEffort,
    }),
}))

vi.mock('@/hooks/mutations/useCcSwitchProvider', () => ({
    useCcSwitchProvider: () => ({
        switchProvider: mocks.switchCcSwitchProvider,
    }),
}))

vi.mock('@/hooks/queries/useAgyModels', () => ({
    useAgyModels: () => mocks.agyModelsState,
}))

vi.mock('@/hooks/queries/useCodexModels', () => ({
    useCodexModels: () => mocks.codexModelsState,
}))

vi.mock('@/hooks/queries/useCursorModels', () => ({
    useCursorModels: () => mocks.cursorModelsState,
}))

vi.mock('@/hooks/queries/useCursorModelsForMachine', () => ({
    useCursorModelsForMachine: () => mocks.machineCursorModelsState,
}))

vi.mock('@/hooks/queries/useOpencodeModels', () => ({
    useOpencodeModels: () => mocks.opencodeModelsState,
}))

vi.mock('@/hooks/queries/useOpencodeReasoningEffortOptions', () => ({
    useOpencodeReasoningEffortOptions: () => ({ options: [], error: null }),
}))

vi.mock('@/hooks/queries/useOmpModels', () => ({
    useOmpModels: () => ({
        ...mocks.ompModelsState,
        refresh: mocks.refreshOmpModels,
        refetch: mocks.refetchOmpModels,
    }),
}))

vi.mock('@/hooks/queries/useOmpThinkingOptions', () => ({
    useOmpThinkingOptions: () => ({
        ...mocks.ompThinkingState,
        refetch: mocks.refetchOmpThinking,
    }),
}))

vi.mock('@/hooks/queries/useGrokModels', () => ({
    useGrokModels: () => mocks.grokModelsState,
}))

vi.mock('@/hooks/queries/useGrokReasoningEffortOptions', () => ({
    useGrokReasoningEffortOptions: () => ({ options: [], error: null }),
}))

vi.mock('@/hooks/queries/useCopilotModels', () => ({
    useCopilotModels: () => mocks.copilotModelsState,
}))

vi.mock('@/hooks/queries/usePiModels', () => ({
    usePiModels: () => mocks.piModelsState,
}))

vi.mock('@/hooks/queries/useCcSwitchProviders', () => ({
    useCcSwitchProviders: () => mocks.ccSwitchProvidersState,
}))

function createBaseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1_000,
        updatedAt: 2_000,
        active: true,
        activeAt: 2_000,
        thinking: false,
        thinkingAt: 0,
        permissionMode: 'default',
        modelMode: 'default',
        model: null,
        metadata: {
            path: '/workspace',
            host: 'c1',
            flavor: 'claude',
        },
        agentState: {
            controlledByUser: false,
        },
        todos: [],
        ...overrides,
    } as Session
}

describe('useSessionFlavorModelController', () => {
    const api = {} as ApiClient
    const onRefresh = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.agyModelsState = {
            availableModels: [],
            currentModelId: null,
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }
        mocks.codexModelsState = { collaborationModeSupported: false, models: [], error: null }
        mocks.cursorModelsState = {
            availableModels: [],
            cliModelSkus: [],
            currentModelId: null,
            error: null,
            isLoading: false,
        }
        mocks.machineCursorModelsState = {
            availableModels: [],
            cliModelSkus: [],
            error: null,
            isLoading: false,
        }
        mocks.opencodeModelsState = { availableModels: [], error: null }
        mocks.ompModelsState = {
            availableModels: [],
            currentModel: null,
            error: null,
            isRefreshing: false,
            isFetching: false,
        }
        mocks.ompThinkingState = { state: null, options: [], error: null }
        mocks.grokModelsState = { availableModels: [], error: null }
        mocks.copilotModelsState = { availableModels: [], error: null }
        mocks.piModelsState = { availableModels: [], error: null }
        mocks.ccSwitchProvidersState = { available: false, providers: [], currentProviderId: null }
    })

    it('exposes onRefreshModels and thinking effort options for active OMP sessions even when models list is empty', async () => {
        mocks.ompThinkingState = {
            state: {
                supportedLevels: ['low', 'medium', 'high'],
                supportsThinking: true,
                configured: 'high',
            },
            options: [
                { value: 'off', label: 'Off' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
            ],
            error: null,
        }
        const session = createBaseSession({
            metadata: { path: '/workspace', host: 'c1', flavor: 'omp' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.agentFlavor).toBe('omp')
        expect(result.current.onRefreshModels).toBeTypeOf('function')
        expect(result.current.availableModelOptions).toEqual([])
        expect(result.current.availableEffortOptions?.map((opt) => opt.value)).toEqual([
            'off',
            'low',
            'medium',
            'high',
        ])

        await act(async () => {
            result.current.onRefreshModels?.()
            await result.current.onEffortChange?.('medium')
        })

        expect(mocks.refreshOmpModels).toHaveBeenCalledOnce()
        expect(mocks.setEffort).toHaveBeenCalledWith('medium')
        expect(mocks.refetchOmpThinking).toHaveBeenCalled()
    })

    it('derives Cursor dual-step base and variant selectors and resolves variants per base', () => {
        const skus: CursorModelSummary[] = [
            { modelId: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
            { modelId: 'claude-4.5-sonnet-thinking', name: 'Claude 4.5 Sonnet Thinking' },
            { modelId: 'gpt-5.2', name: 'GPT-5.2' },
            { modelId: 'gpt-5.2-high', name: 'GPT-5.2 High' },
        ]
        mocks.cursorModelsState = {
            availableModels: skus,
            cliModelSkus: skus,
            currentModelId: 'claude-4.5-sonnet-thinking',
            error: null,
            isLoading: false,
        }
        const session = createBaseSession({
            model: 'claude-4.5-sonnet-thinking',
            metadata: { path: '/workspace', host: 'c1', flavor: 'cursor' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.agentFlavor).toBe('cursor')
        expect(result.current.selectedModelBase).toBe('claude-4.5-sonnet')
        expect(result.current.selectedModelVariant).toBe('claude-4.5-sonnet-thinking')
        const variants = result.current.resolveModelVariantsForBase?.('claude-4.5-sonnet')
        expect(variants?.map((v) => v.value)).toEqual([
            'claude-4.5-sonnet',
            'claude-4.5-sonnet-thinking',
        ])
    })

    it('routes Pi provider-qualified model changes through setModel and exposes piContextWindow', async () => {
        mocks.piModelsState = {
            availableModels: [
                { provider: 'anthropic', modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000 },
                { provider: 'openai', modelId: 'gpt-5', name: 'GPT-5', contextWindow: 400_000 },
            ],
            error: null,
        }
        const session = createBaseSession({
            thinking: true,
            model: 'gpt-5',
            metadata: {
                path: '/workspace',
                host: 'c1',
                flavor: 'pi',
                piSelectedModel: { provider: 'openai', modelId: 'gpt-5' },
            } as Session['metadata'],
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.piContextWindow).toBe(400_000)
        expect(result.current.piSelectedModel).toEqual({ provider: 'openai', modelId: 'gpt-5' })
        expect(result.current.availableModelOptions).toBeUndefined()

        await act(async () => {
            await result.current.onModelChange?.({
                provider: 'anthropic',
                modelId: 'claude-sonnet-4-5',
            })
        })

        expect(mocks.setModel).toHaveBeenCalledWith({
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
        })
    })

    it('clears unsupported Codex reasoning effort before model switch and exposes fast mode on gpt-5.4', async () => {
        mocks.codexModelsState = {
            collaborationModeSupported: true,
            models: [
                {
                    id: 'gpt-5.4',
                    model: 'gpt-5.4',
                    displayName: 'GPT-5.4',
                    description: 'Flagship Codex model',
                    isDefault: true,
                    defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: ['low', 'medium'],
                    serviceTiers: ['standard', 'fast'],
                },
            ],
            error: null,
        }
        const session = createBaseSession({
            model: 'gpt-5.4',
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast',
            metadata: { path: '/workspace', host: 'c1', flavor: 'codex' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.effectiveCodexServiceTier).toBe('fast')
        expect(result.current.onServiceTierChange).toBeTypeOf('function')

        await act(async () => {
            await result.current.onModelChange?.('gpt-5.4')
        })

        expect(mocks.setModelReasoningEffort).toHaveBeenCalledWith(null)
        expect(mocks.setModel).toHaveBeenCalledWith('gpt-5.4')
    })

    it('exposes live AGY model options and enables onModelChange for active AGY sessions', () => {
        mocks.agyModelsState = {
            availableModels: [
                { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
                { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
            ],
            currentModelId: null,
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }
        const session = createBaseSession({
            model: 'gemini-pro-orchestrator',
            metadata: { path: '/workspace', host: 'c1', machineId: 'machine-1', flavor: 'agy' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.availableModelOptions).toEqual([
            { value: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
            { value: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
        ])
        expect(result.current.onModelChange).toBeTypeOf('function')
    })

    it('returns an empty AGY model list while live AGY models are loading', () => {
        mocks.agyModelsState = {
            availableModels: [],
            currentModelId: null,
            isLoading: true,
            error: null,
            refetch: vi.fn(),
        }
        const session = createBaseSession({
            model: 'gemini-pro-orchestrator',
            metadata: { path: '/workspace', host: 'c1', machineId: 'machine-1', flavor: 'agy' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.availableModelOptions).toEqual([])
        expect(result.current.onModelChange).toBeTypeOf('function')
    })

    it('disables onModelChange for inactive AGY sessions', () => {
        const session = createBaseSession({
            active: false,
            model: 'gemini-pro-orchestrator',
            metadata: { path: '/workspace', host: 'c1', machineId: 'machine-1', flavor: 'agy' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.onModelChange).toBeUndefined()
    })

    it('groups AGY multi-variant models into families and sends effort atomically on switch', async () => {
        mocks.agyModelsState = {
            availableModels: [
                { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
                { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
                { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
            ],
            currentModelId: null,
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }
        const session = createBaseSession({
            model: 'gemini-4-argon-medium',
            effort: null,
            metadata: { path: '/workspace', host: 'c1', machineId: 'machine-1', flavor: 'agy' },
        })

        const { result } = renderHook(() =>
            useSessionFlavorModelController({ api, session, onRefresh })
        )

        expect(result.current.model).toBe('gemini-4-argon')
        expect(result.current.effort).toBe('medium')
        expect(result.current.availableModelOptions).toEqual([
            { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
            { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
        ])
        expect(result.current.availableEffortOptions).toEqual([
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
        ])

        await act(async () => {
            await result.current.onEffortChange?.('high')
        })
        expect(mocks.setModel).toHaveBeenCalledWith('gemini-4-argon', { effort: 'high' })

        await act(async () => {
            await result.current.onModelChange?.('gpt-oss-120b-medium')
        })
        expect(mocks.setModel).toHaveBeenCalledWith('gpt-oss-120b-medium', { effort: null })
    })
})
