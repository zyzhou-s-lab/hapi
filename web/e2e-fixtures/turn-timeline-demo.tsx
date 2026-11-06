import React, { memo, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
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
import { projectSessionTodoSnapshot } from '../src/chat/projections/todoProjection'
import type { TodoItem } from '../src/types/api'

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
        () => partitionTurn([
            { type: 'reasoning', text: `Tail streaming thought tick ${tick}`, status: { type: 'running' } },
            { type: 'text', text: `Tail streaming answer tick ${tick}`, status: { type: 'running' } },
        ], stableMetadata),
        [tick, stableMetadata]
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

function FixtureRouter() {
    const params = new URLSearchParams(window.location.search)
    const fixture = params.get('fixture')
    if (fixture === 'feature-isolation') return <FeatureIsolationFixture />
    if (fixture === 'streaming-isolation') return <StreamingIsolationFixture />
    return <TurnTimelineDemo />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <I18nProvider>
            <FixtureRouter />
        </I18nProvider>
    </React.StrictMode>
)
