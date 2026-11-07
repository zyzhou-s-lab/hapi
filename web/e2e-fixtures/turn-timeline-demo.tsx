import React, { memo, useCallback, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { TurnTimelineDemo } from '../src/components/AssistantChat/messages/TurnTimelineDemo'
import { TimelineTurnBlockView } from '../src/components/AssistantChat/messages/TimelineTurnBlock'
import { partitionTurn, type TurnContentPart, type TurnPartition } from '../src/components/AssistantChat/messages/turnBlockModel'
import { FeatureErrorBoundary } from '../src/components/FeatureErrorBoundary'
import {
    HappyChatProvider,
    type HappyChatContextValue,
    useOptionalHappyChatSessionStateContext,
    useOptionalHappyChatStaticContext,
    useOptionalHappyChatTodosContext,
} from '../src/components/AssistantChat/context'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { useSessionFlavorModelController } from '../src/components/AssistantChat/composer/useSessionFlavorModelController'
import { SessionStatusPanel } from '../src/components/SessionStatusPanel'
import { TodoPanel } from '../src/fork-features/task-panel/TodoPanel'
import { projectSessionTodoSnapshot } from '../src/chat/projections/todoProjection'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import type { ChatBlock } from '../src/chat/types'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import type { ApiClient } from '../src/api/client'
import type {
    ClaudeEffort,
    CodexModelReasoningEffort,
    CollaborationMode,
    CopilotAgentMode,
    DecryptedMessage,
    PermissionMode,
    ServiceTier,
    Session,
    TodoItem,
} from '../src/types/api'
const ISOLATION_SAMPLE_PARTS: TurnContentPart[] = [
    {
        type: 'reasoning',
        text: 'Inspecting SubturnView peer slots and FeatureErrorBoundary isolation.',
        status: { type: 'complete' },
    },
    {
        type: 'tool-call',
        toolCallId: 'tool-read-1',
        toolName: 'Read',
        status: { type: 'complete' },
        artifact: {
            kind: 'tool-call',
            id: 'block-read-1',
            localId: 'block-read-1',
            createdAt: 1000,
            tool: {
                id: 'tool-read-1',
                name: 'Read',
                state: 'completed',
                input: { file_path: 'web/src/components/FeatureErrorBoundary.tsx' },
                result: 'export class FeatureErrorBoundary ...',
                createdAt: 1000,
                startedAt: 1000,
                completedAt: 1120,
                description: 'Read FeatureErrorBoundary.tsx',
            },
            children: [],
        },
    },
    {
        type: 'tool-call',
        toolCallId: 'tool-todo-1',
        toolName: 'TodoWrite',
        status: { type: 'complete' },
        artifact: {
            kind: 'tool-call',
            id: 'block-todo-1',
            localId: 'block-todo-1',
            createdAt: 1150,
            tool: {
                id: 'tool-todo-1',
                name: 'TodoWrite',
                state: 'completed',
                input: {
                    todos: [
                        { id: '1', content: 'Isolate peer Subturn slots', status: 'completed' },
                        { id: '2', content: 'Verify FeatureErrorBoundary Retry', status: 'in_progress' },
                    ],
                },
                result: 'Updated 2 todos',
                createdAt: 1150,
                startedAt: 1150,
                completedAt: 1250,
                description: 'Update Todo checklist',
            },
            children: [],
        },
    },
    {
        type: 'text',
        text: 'All three peer slots (`turn-rail`, `turn-todo`, `turn-answer`) are isolated with independent error boundaries.',
        status: { type: 'complete' },
    },
]

function MaybeCrashingAnswer(props: { text: string; crash: boolean }) {
    if (props.crash) {
        throw new Error('Simulated turn-answer render failure')
    }
    return <div data-testid="healthy-answer-content">{props.text}</div>
}

function MaybeCrashingTodoPanel(props: { crash: boolean; sessionKey: string }) {
    if (props.crash) {
        throw new Error('Simulated todo-panel render failure')
    }
    return (
        <div
            data-testid="healthy-todo-panel"
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]"
        >
            Docked TodoPanel active for {props.sessionKey}
        </div>
    )
}

function FeatureIsolationFixture() {
    const [crashAnswer, setCrashAnswer] = useState(false)
    const [crashTodoPanel, setCrashTodoPanel] = useState(false)
    const [sessionKey, setSessionKey] = useState('session-alpha')
    const partition = useMemo(() => partitionTurn(ISOLATION_SAMPLE_PARTS, null), [])

    return (
        <div className="min-h-screen bg-[var(--app-bg)] p-6 text-[var(--app-fg)]" data-testid="feature-isolation-fixture">
            <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        data-testid="toggle-crash-answer"
                        onClick={() => setCrashAnswer((v) => !v)}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                    >
                        {crashAnswer ? 'Heal Answer Slot' : 'Crash Answer Slot'}
                    </button>
                    <button
                        type="button"
                        data-testid="toggle-crash-todo-panel"
                        onClick={() => setCrashTodoPanel((v) => !v)}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                    >
                        {crashTodoPanel ? 'Heal TodoPanel' : 'Crash TodoPanel'}
                    </button>
                    <button
                        type="button"
                        data-testid="switch-session-reset-key"
                        onClick={() => {
                            setCrashAnswer(false)
                            setCrashTodoPanel(false)
                            setSessionKey((k) => (k === 'session-alpha' ? 'session-beta' : 'session-alpha'))
                        }}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                    >
                        Switch Session ({sessionKey})
                    </button>
                </div>

                <TimelineTurnBlockView
                    partition={partition}
                    streaming={false}
                    durationMs={1250}
                    initiallyOpen={false}
                    renderTrailingText={(text) => <MaybeCrashingAnswer text={text} crash={crashAnswer} />}
                />

                <FeatureErrorBoundary name="todo-panel" resetKey={sessionKey}>
                    <MaybeCrashingTodoPanel crash={crashTodoPanel} sessionKey={sessionKey} />
                </FeatureErrorBoundary>
            </div>
        </div>
    )
}

const MemoizedTurnView = memo(TimelineTurnBlockView)

const HistoricalFixtureTurn = memo(function HistoricalFixtureTurn(props: { index: number; partition: TurnPartition }) {
    const staticCtx = useOptionalHappyChatStaticContext()
    const renderCountRef = useRef(0)
    renderCountRef.current += 1

    return (
        <div
            data-testid={`fixture-turn-${props.index}`}
            data-is-tail="false"
            data-render-count={String(renderCountRef.current)}
            data-session-id={staticCtx?.sessionId ?? ''}
        >
            <MemoizedTurnView
                partition={props.partition}
                streaming={false}
                durationMs={800}
                initiallyOpen={false}
            />
        </div>
    )
})

function TailFixtureTurn(props: { index: number; partition: TurnPartition }) {
    const staticCtx = useOptionalHappyChatStaticContext()
    const sessionStateCtx = useOptionalHappyChatSessionStateContext()
    const todosCtx = useOptionalHappyChatTodosContext()
    const renderCountRef = useRef(0)
    renderCountRef.current += 1

    const streaming = Boolean(sessionStateCtx?.sessionThinking)
    const activeTodoText = streaming
        ? projectSessionTodoSnapshot(todosCtx?.todos).activeLabel
        : null

    return (
        <div
            data-testid={`fixture-turn-${props.index}`}
            data-is-tail="true"
            data-render-count={String(renderCountRef.current)}
            data-session-id={staticCtx?.sessionId ?? ''}
            data-active-todo={activeTodoText ?? ''}
        >
            <MemoizedTurnView
                partition={props.partition}
                streaming={streaming}
                durationMs={1200}
                initiallyOpen={true}
                activeTodoText={activeTodoText}
                fallbackTodos={todosCtx?.todos ?? null}
            />
        </div>
    )
}

function StreamingIsolationFixture() {
    const [todos, setTodos] = useState<TodoItem[]>([
        { id: 't1', content: 'Step 1: Static context setup', status: 'completed' },
        { id: 't2', content: 'Step 2: Streaming tick 0', status: 'in_progress' },
    ])
    const [sessionThinking, setSessionThinking] = useState(true)
    const [tick, setTick] = useState(0)
    const [lifecycleStep, setLifecycleStep] = useState<'default' | 'execution_only' | 'tool_running' | 'final_answer'>('default')

    const noopRefresh = useMemo(() => () => {}, [])
    const noopLoadOlder = useMemo(() => async () => 'terminal-stop' as const, [])
    const fakeApi = useMemo(() => ({}) as HappyChatContextValue['api'], [])

    // Intentionally pass a freshly allocated metadata object on every render so
    // HappyChatProvider's useStableSessionMetadata is exercised in real browser ticks.
    const providerValue: HappyChatContextValue = {
        api: fakeApi,
        sessionId: 'session-stream-iso',
        metadata: { path: '/workspace/hapi', host: 'c1' },
        todos,
        sessionThinking,
        activeTurnStartedAt: 1000,
        terminalToolDisplayMode: 'collapsed',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: noopRefresh,
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: noopLoadOlder,
    }

    const stableMetadata = useMemo(() => ({ path: '/workspace/hapi', host: 'c1' }), [])

    const historicalPartitions = useMemo(
        () => Array.from({ length: 5 }, (_, idx) =>
            partitionTurn([
                { type: 'reasoning', text: `Historical turn ${idx} reasoning`, status: { type: 'complete' } },
                { type: 'text', text: `Historical turn ${idx} final answer`, status: { type: 'complete' } },
            ], stableMetadata)
        ),
        [stableMetadata]
    )

    const tailPartition = useMemo(
        () => {
            if (lifecycleStep === 'execution_only') {
                return partitionTurn([
                    { type: 'text', text: 'Pre-tool commentary (phase=execution)', status: { type: 'running' }, phase: 'execution' },
                ], stableMetadata)
            }
            if (lifecycleStep === 'tool_running') {
                return partitionTurn([
                    { type: 'text', text: 'Pre-tool commentary (phase=execution)', status: { type: 'complete' }, phase: 'execution' },
                    {
                        type: 'tool-call',
                        toolCallId: 'tool-lc-1',
                        toolName: 'Bash',
                        status: { type: 'running' },
                        artifact: {
                            block: {
                                kind: 'tool-call',
                                id: 'tool-lc-1',
                                createdAt: 1100,
                                children: [],
                                tool: {
                                    name: 'Bash',
                                    input: { command: 'bun typecheck' },
                                    state: 'running',
                                    createdAt: 1100,
                                    startedAt: 1100,
                                    completedAt: null,
                                    description: 'Running typecheck',
                                },
                            },
                        },
                    },
                ], stableMetadata)
            }
            if (lifecycleStep === 'final_answer') {
                return partitionTurn([
                    { type: 'text', text: 'Pre-tool commentary (phase=execution)', status: { type: 'complete' }, phase: 'execution' },
                    {
                        type: 'tool-call',
                        toolCallId: 'tool-lc-1',
                        toolName: 'Bash',
                        status: { type: 'complete' },
                        artifact: {
                            block: {
                                kind: 'tool-call',
                                id: 'tool-lc-1',
                                createdAt: 1100,
                                children: [],
                                tool: {
                                    name: 'Bash',
                                    input: { command: 'bun typecheck' },
                                    state: 'completed',
                                    createdAt: 1100,
                                    startedAt: 1100,
                                    completedAt: 1200,
                                    description: 'Running typecheck',
                                    result: 'Done in 1.2s',
                                },
                            },
                        },
                    },
                    { type: 'text', text: 'All checks passed (phase=final_answer)', status: { type: 'complete' }, phase: 'final_answer' },
                ], stableMetadata)
            }
            return partitionTurn([
                { type: 'reasoning', text: `Tail streaming thought tick ${tick}`, status: { type: 'running' } },
                { type: 'text', text: `Tail streaming answer tick ${tick}`, status: { type: 'running' } },
            ], stableMetadata)
        },
        [lifecycleStep, tick, stableMetadata]
    )

    return (
        <HappyChatProvider value={providerValue}>
            <div className="min-h-screen bg-[var(--app-bg)] p-6 text-[var(--app-fg)]" data-testid="streaming-isolation-fixture">
                <div className="mx-auto max-w-3xl space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            data-testid="advance-todo-tick"
                            onClick={() => {
                                const next = tick + 1
                                setTick(next)
                                setTodos([
                                    { id: 't1', content: 'Step 1: Static context setup', status: 'completed' },
                                    { id: 't2', content: `Step 2: Streaming tick ${next}`, status: 'in_progress' },
                                ])
                            }}
                            className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                        >
                            Advance Streaming + Todo Tick ({tick})
                        </button>
                        <button
                            type="button"
                            data-testid="toggle-session-thinking"
                            onClick={() => setSessionThinking((v) => !v)}
                            className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                        >
                            Toggle Thinking ({String(sessionThinking)})
                        </button>
                        <button
                            type="button"
                            data-testid="advance-lifecycle-step"
                            onClick={() => {
                                setLifecycleStep((prev) => {
                                    if (prev === 'default') return 'execution_only'
                                    if (prev === 'execution_only') return 'tool_running'
                                    if (prev === 'tool_running') return 'final_answer'
                                    return 'default'
                                })
                            }}
                            className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs font-medium"
                        >
                            Lifecycle Step ({lifecycleStep})
                        </button>
                    </div>

                    {historicalPartitions.map((part, idx) => (
                        <HistoricalFixtureTurn key={idx} index={idx} partition={part} />
                    ))}
                    <TailFixtureTurn index={5} partition={tailPartition} />
                </div>
            </div>
        </HappyChatProvider>
    )
}

const fixtureQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
})

type DemoFlavor = 'omp' | 'cursor' | 'pi' | 'codex' | 'claude'

function ComposerFlavorSettingsInner() {
    const [flavor, setFlavor] = useState<DemoFlavor>('omp')
    const ompModelsRefreshedRef = useRef(false)
    const [model, setModel] = useState<string | null>(null)
    const [effort, setEffort] = useState<ClaudeEffort | null>('medium')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexModelReasoningEffort | null>('medium')
    const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
    const [serviceTier, setServiceTier] = useState<ServiceTier>('standard')
    const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>('default')
    const [copilotAgentMode, setCopilotAgentMode] = useState<CopilotAgentMode>('default')
    const [resumeWithSessionModel, setResumeWithSessionModel] = useState(false)
    const [piSelectedModel, setPiSelectedModel] = useState<{ provider: string; modelId: string } | null>({
        provider: 'openai',
        modelId: 'gpt-5.4',
    })

    const isPiGenerating = flavor === 'pi'

    const session = useMemo<Session>(() => ({
        id: `session-composer-flavor-${flavor}`,
        namespace: 'default',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        active: flavor !== 'claude',
        activeAt: 1_700_000_000_000,
        model,
        effort,
        modelReasoningEffort,
        permissionMode,
        serviceTier,
        collaborationMode,
        copilotAgentMode,
        resumeWithSessionModel,
        metadata: {
            path: '/workspace/hapi',
            host: 'c1',
            machineId: 'machine-c1',
            flavor,
            piSelectedModel: flavor === 'pi' ? piSelectedModel : undefined,
        } as Session['metadata'],
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
        },
        agentStateVersion: 1,
        thinking: isPiGenerating,
        thinkingAt: isPiGenerating ? 1_700_000_000_000 : 0,
        todos: [
            { id: '1', content: 'Phase 1:1 (completed) · Align CSS @layer cascade', status: 'completed', priority: 'high' },
            { id: '2', content: 'Phase 1:2 (in_progress) · Verify SubturnView slots and floating dock', status: 'in_progress', priority: 'high' },
            { id: '3', content: 'Phase 1:3 (blocked) · Paused fallback verification task', status: 'blocked', priority: 'medium' },
        ],
    }), [
        collaborationMode,
        copilotAgentMode,
        effort,
        flavor,
        isPiGenerating,
        model,
        modelReasoningEffort,
        permissionMode,
        piSelectedModel,
        resumeWithSessionModel,
        serviceTier,
    ])

    const fakeApi = useMemo<ApiClient>(() => {
        const cursorSkus = [
            { modelId: 'sonnet-4.5', name: 'Claude 4.5 Sonnet' },
            { modelId: 'sonnet-4.5-thinking', name: 'Claude 4.5 Sonnet Thinking' },
            { modelId: 'gpt-5.2', name: 'GPT-5.2' },
            { modelId: 'gpt-5.2-high', name: 'GPT-5.2 High' },
        ]
        const ompList = [
            { provider: 'anthropic', modelId: 'claude-opus-4-6', name: 'claude-opus-4-6' },
            { provider: 'openai', modelId: 'gpt-5.4', name: 'gpt-5.4' },
        ]
        return {
            getSessionOmpModels: async () => ({
                success: true,
                availableModels: ompModelsRefreshedRef.current ? ompList : [],
                currentModel: null,
            }),
            refreshSessionOmpModels: async () => {
                ompModelsRefreshedRef.current = true
                return {
                    success: true,
                    availableModels: ompList,
                    currentModel: null,
                }
            },
            getSessionOmpThinkingOptions: async () => ({
                success: true,
                options: [
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                ],
                state: {
                    supportedLevels: ['low', 'medium', 'high'],
                    supportsThinking: true,
                    configured: 'medium',
                },
            }),
            getSessionCursorModels: async () => ({
                success: true,
                availableModels: cursorSkus,
                cliModelSkus: cursorSkus,
                currentModelId: 'sonnet-4.5',
            }),
            getMachineCursorModels: async () => ({
                success: true,
                availableModels: cursorSkus,
                cliModelSkus: cursorSkus,
                currentModelId: 'sonnet-4.5',
            }),
            callPiEndpoint: async () => ({
                success: true,
                availableModels: [
                    {
                        provider: 'anthropic',
                        modelId: 'claude-sonnet-4-5',
                        name: 'Claude Sonnet 4.5',
                        reasoning: true,
                        contextWindow: 200_000,
                        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
                    },
                    {
                        provider: 'openai',
                        modelId: 'gpt-5.4',
                        name: 'GPT-5.4',
                        reasoning: true,
                        contextWindow: 200_000,
                        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
                    },
                ],
                currentModelId: 'gpt-5.4',
            }),
            getMachineCodexModels: async () => ({
                models: [
                    {
                        id: 'gpt-5.3-codex',
                        model: 'gpt-5.3-codex',
                        displayName: 'gpt-5.3-codex',
                        description: 'Codex 5.3',
                        isDefault: true,
                        defaultReasoningEffort: 'medium',
                        supportedReasoningEfforts: ['low', 'medium', 'high'],
                    },
                    {
                        id: 'gpt-5.4',
                        model: 'gpt-5.4',
                        displayName: 'gpt-5.4',
                        description: 'GPT-5.4',
                        isDefault: false,
                        defaultReasoningEffort: 'medium',
                        supportedReasoningEfforts: ['low', 'medium', 'high'],
                        serviceTiers: ['standard', 'fast'],
                    },
                ],
            }),
            getSessionCodexModels: async () => ({ models: [] }),
            getMachineCcSwitchProviders: async () => ({
                available: false,
                providers: [],
                currentProviderId: null,
            }),
            setModel: async (_sessionId: string, next: { provider: string; modelId: string } | string | null) => {
                if (typeof next === 'object' && next !== null && 'provider' in next) {
                    setPiSelectedModel(next)
                    setModel(next.modelId)
                    return
                }
                setModel(next)
            },
            setEffort: async (_sessionId: string, next: string | null) => {
                setEffort((next as ClaudeEffort | null) ?? null)
            },
            setModelReasoningEffort: async (_sessionId: string, next: string | null) => {
                setModelReasoningEffort((next as CodexModelReasoningEffort | null) ?? null)
            },
            setPermissionMode: async (_sessionId: string, next: PermissionMode) => {
                setPermissionMode(next)
            },
            setServiceTier: async (_sessionId: string, next: string | null) => {
                setServiceTier((next as ServiceTier | null) ?? 'standard')
            },
            setCollaborationMode: async (_sessionId: string, next: CollaborationMode) => {
                setCollaborationMode(next)
            },
            setCopilotAgentMode: async (_sessionId: string, next: CopilotAgentMode) => {
                setCopilotAgentMode(next)
            },
            setResumeWithSessionModel: async (_sessionId: string, next: boolean) => {
                setResumeWithSessionModel(next)
            },
            abortSession: async () => {},
            switchSession: async () => {},
        } as unknown as ApiClient
    }, [])

    const flavorController = useSessionFlavorModelController({
        api: fakeApi,
        session,
        onRefresh: () => {},
    })

    const runtime = useHappyRuntime({
        session,
        blocks: [],
        messagesVersion: 1,
        historyVersion: 1,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {},
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="min-h-screen bg-[var(--app-bg)] p-6 text-[var(--app-fg)]" data-testid="composer-flavor-fixture">
                <div className="mx-auto flex max-w-3xl flex-col gap-6">
                    <SessionStatusPanel
                        data={{
                            goal: {
                                objective: 'Verify PR 1-5 rearchitectured components with main 96e3a282 styles',
                                status: 'active',
                                timeUsedSeconds: 145,
                            },
                            tasks: session.todos ?? [],
                            subagents: [
                                {
                                    id: 'agent-pr45',
                                    title: 'PR45Steady',
                                    state: 'working',
                                    detail: 'Auditing SubturnView open state and floating dock geometry',
                                    startedAt: 1_700_000_000_000,
                                    endedAt: null,
                                },
                            ],
                            terminals: [],
                            undiscoveredTerminalCount: 0,
                            possibleTerminalCommands: [],
                        }}
                    />
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                            {(['omp', 'cursor', 'pi', 'codex', 'claude'] as const).map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    data-testid={`switch-flavor-${item}`}
                                    onClick={() => {
                                        setFlavor(item)
                                        if (item === 'cursor') {
                                            setModel('sonnet-4.5')
                                        } else if (item === 'omp') {
                                            setModel(null)
                                        } else if (item === 'codex') {
                                            setModel('gpt-5.3-codex')
                                        } else if (item === 'pi') {
                                            setModel('gpt-5.4')
                                        } else if (item === 'claude') {
                                            setModel('sonnet')
                                        }
                                    }}
                                    className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                        flavor === item
                                            ? 'border-[var(--app-link)] bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                            : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)]'
                                    }`}
                                >
                                    Flavor: {item}
                                </button>
                            ))}
                        </div>
                        <div
                            data-testid="composer-flavor-state"
                            className="grid grid-cols-2 gap-2 font-mono text-xs text-[var(--app-hint)] sm:grid-cols-3"
                        >
                            <span data-testid="state-flavor">flavor={flavor}</span>
                            <span data-testid="state-model">model={model ?? 'auto'}</span>
                            <span data-testid="state-effort">effort={effort ?? 'auto'}</span>
                            <span data-testid="state-variant">variant={flavorController.selectedModelVariant ?? 'none'}</span>
                            <span data-testid="state-permission">perm={permissionMode}</span>
                            <span data-testid="state-tier">tier={serviceTier ?? 'standard'}</span>
                            <span data-testid="state-pi">
                                pi={piSelectedModel ? `${piSelectedModel.provider}:${piSelectedModel.modelId}` : 'none'}
                            </span>
                            <span data-testid="state-resume">resume={String(resumeWithSessionModel)}</span>
                        </div>
                    </div>
                    <div className="flex flex-col gap-0 pt-56" data-testid="composer-dock-stack">
                        <div className="px-3">
                            <FeatureErrorBoundary name="todo-panel" resetKey={session.id}>
                                <TodoPanel
                                    sessionId={session.id}
                                    todos={session.todos}
                                    sessionThinking={session.thinking}
                                />
                            </FeatureErrorBoundary>
                        </div>

                        <HappyComposer
                            sessionId={session.id}
                            disabled={false}
                            allowSendWhenInactive={!session.active}
                            thinking={session.thinking}
                            contextSize={110_000}
                            contextModel="gpt-5.4"
                            flavorController={flavorController}
                        />
                    </div>
                </div>
            </div>
        </AssistantRuntimeProvider>
    )
}

function ComposerFlavorSettingsFixture() {
    return (
        <QueryClientProvider client={fixtureQueryClient}>
            <ComposerFlavorSettingsInner />
        </QueryClientProvider>
    )
}

function buildTurnMessages(prefix: string, count: number, startSeq: number, startCreatedAt: number): DecryptedMessage[] {
    const result: DecryptedMessage[] = []
    for (let i = 0; i < count; i += 1) {
        const turnIndex = startSeq + i
        const userCreatedAt = startCreatedAt + i * 2000
        const agentCreatedAt = userCreatedAt + 900
        result.push({
            id: `${prefix}-user-${turnIndex}`,
            seq: turnIndex * 2,
            localId: `${prefix}-user-${turnIndex}`,
            createdAt: userCreatedAt,
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: `[${prefix} #${turnIndex}] Audit scroll anchor and turn structure for module ${turnIndex}`,
                },
            },
        })
        result.push({
            id: `${prefix}-agent-${turnIndex}`,
            seq: turnIndex * 2 + 1,
            localId: `${prefix}-agent-${turnIndex}`,
            createdAt: agentCreatedAt,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: `${prefix}-uuid-${turnIndex}`,
                        message: {
                            role: 'assistant',
                            model: 'claude-opus-4-6',
                            content: [
                                {
                                    type: 'thinking',
                                    thinking: `Checking direct-child message anchor invariant for turn ${turnIndex}.`,
                                },
                                {
                                    type: 'text',
                                    text: `Completed verification for **Turn ${turnIndex}** (${prefix}). Direct child selector \`.happy-thread-messages > [id]\` and sibling share capture remain intact.\n\n\`\`\`ts\nexport const turnId = "${prefix}-${turnIndex}"\n\`\`\``,
                                },
                            ],
                        },
                    },
                },
            },
        })
    }
    return result
}

function ThreadScrollAnchorsFixture() {
    const [messages, setMessages] = useState<DecryptedMessage[]>(() =>
        buildTurnMessages('initial', 10, 10, 1_700_000_100_000)
    )
    const [hasMore, setHasMore] = useState(true)
    const [historyGeneration, setHistoryGeneration] = useState(1)
    const [messagesVersion, setMessagesVersion] = useState(1)

    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const out = []
        for (const msg of messages) {
            const next = normalizeDecryptedMessage(msg)
            if (next) out.push(next)
        }
        return out
    }, [messages])

    const reduced = useMemo(() => reduceChatBlocks(normalizedMessages, null, {}), [normalizedMessages])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    blocksByIdRef.current = reconciled.byId

    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: hasMore }),
        [reconciled.blocks, hasMore]
    )

    const session = useMemo<Session>(() => ({
        id: 'session-thread-scroll-anchors',
        namespace: 'default',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_200_000,
        active: true,
        activeAt: 1_700_000_200_000,
        metadata: {
            path: '/workspace/hapi',
            host: 'c1',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        todos: [],
    }), [])

    const runtime = useHappyRuntime({
        session,
        blocks: visibleBlocks,
        messagesVersion,
        historyVersion: historyGeneration,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {},
    })

    const handleLoadMore = useCallback(async (onBeforeApply?: (historyVersion: number) => boolean) => {
        if (!hasMore) {
            return {
                kind: 'stopped' as const,
                reason: 'exhausted' as const,
            }
        }
        const nextHistoryVersion = historyGeneration + 1
        if (onBeforeApply && !onBeforeApply(nextHistoryVersion)) {
            return {
                kind: 'stopped' as const,
                reason: 'invalidated' as const,
            }
        }
        const older = buildTurnMessages('older', 4, 1, 1_700_000_010_000)
        setMessages((prev) => [...older, ...prev])
        setHasMore(false)
        setHistoryGeneration(nextHistoryVersion)
        setMessagesVersion((v) => v + 1)
        return {
            kind: 'applied' as const,
            historyVersion: nextHistoryVersion,
            hasMore: false,
            addedRenderableCount: older.length,
        }
    }, [hasMore, historyGeneration])

    const fakeApi = useMemo(() => ({
        getHubSettings: async () => ({ sessionSummaryInChat: false }),
        fetchVoiceBackend: async () => ({ backend: null, backends: [] }),
    }) as unknown as ApiClient, [])

    return (
        <QueryClientProvider client={fixtureQueryClient}>
            <AssistantRuntimeProvider runtime={runtime}>
                <div className="flex h-screen min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]" data-testid="thread-scroll-anchors-fixture">
                    <div className="flex shrink-0 items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-xs">
                        <div className="flex items-center gap-2">
                            <span className="font-semibold">PR 5 HappyThread Scroll and Anchor Fixture</span>
                            <span data-testid="thread-message-count" className="font-mono text-[var(--app-hint)]">
                                blocks={visibleBlocks.length} hasMore={String(hasMore)}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                data-testid="prepend-older-history"
                                onClick={() => {
                                    void handleLoadMore()
                                }}
                                className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1 font-medium"
                            >
                                Prepend Older History
                            </button>
                        </div>
                    </div>
                    <HappyThread
                        api={fakeApi}
                        session={session}
                        sessionId={session.id}
                        metadata={session.metadata}
                        disabled={false}
                        onRefresh={() => {}}
                        onViewModeChange={() => {}}
                        isSyncingTail={false}
                        messagesWarning={null}
                        hasMoreMessages={hasMore}
                        isLoadingMoreMessages={false}
                        onLoadMore={handleLoadMore}
                        onCancelLoadMore={() => {}}
                        unseenCount={0}
                        rawMessagesCount={messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={messagesVersion}
                        historyVersion={historyGeneration}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={() => {}}
                    />
                </div>
            </AssistantRuntimeProvider>
        </QueryClientProvider>
    )
}

function FixtureRouter() {
    const params = new URLSearchParams(window.location.search)
    const fixture = params.get('fixture')
    if (fixture === 'feature-isolation') return <FeatureIsolationFixture />
    if (fixture === 'streaming-isolation') return <StreamingIsolationFixture />
    if (fixture === 'composer-flavor-settings') return <ComposerFlavorSettingsFixture />
    if (fixture === 'thread-scroll-anchors') return <ThreadScrollAnchorsFixture />
    return <TurnTimelineDemo />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <I18nProvider>
            <FixtureRouter />
        </I18nProvider>
    </React.StrictMode>
)
