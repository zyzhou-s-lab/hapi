import { memo, type PropsWithChildren, type ReactElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '@/api/client'
import {
    areSessionMetadataSummariesEqual,
    HappyChatProvider,
    useHappyChatHistoryContext,
    useHappyChatSessionStateContext,
    useHappyChatStaticContext,
    useHappyChatTodosContext,
    useOptionalHappyChatHistoryContext,
    useOptionalHappyChatSessionStateContext,
    useOptionalHappyChatStaticContext,
    useOptionalHappyChatTodosContext,
    type HappyChatContextValue,
    type HappyChatHistoryContextValue,
    type HappyChatSessionStateContextValue,
    type HappyChatStaticContextValue,
    type HappyChatTodosContextValue,
} from '@/components/AssistantChat/context'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { I18nProvider } from '@/lib/i18n-context'
import type { Session, SessionMetadataSummary } from '@/types/api'
import type { OlderLoadOutcome } from '@/lib/message-window-store'

let messageProbeSlot: (() => ReactElement) | null = null

vi.mock('@assistant-ui/react', () => ({
    ThreadPrimitive: {
        Root: ({ children }: PropsWithChildren) => <div>{children}</div>,
        Viewport: ({ children }: PropsWithChildren) => <div>{children}</div>,
        Messages: () => (messageProbeSlot ? messageProbeSlot() : null),
        Unstable_MessageById: () => (messageProbeSlot ? messageProbeSlot() : null),
    },
    useAuiState<T>(selector: (state: { thread: { extras: undefined } }) => T): T {
        return selector({ thread: { extras: undefined } })
    },
    unstable_useThreadMessageIds: (): string[] => ['msg-1'],
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({
        machines: [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
}))

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value(this: HTMLElement, options: ScrollToOptions) {
            if (typeof options.top === 'number') {
                this.scrollTop = options.top
            }
        },
    })
})

afterEach(() => {
    messageProbeSlot = null
    cleanup()
})

afterAll(() => {
    if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor)
        return
    }
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

function createMetadataClone(): SessionMetadataSummary {
    return {
        path: '/workspace/hapi',
        host: 'devbox',
        version: '1.2.3',
        name: 'PR3 Context Session',
        os: 'linux',
        summary: {
            text: 'Context split summary',
            updatedAt: 1700000000000,
        },
        machineId: 'machine-1',
        tools: ['Read', 'Edit', 'Bash'],
        flavor: 'claude',
        startingMode: 'remote',
        capabilities: {
            terminal: true,
            conversationHistory: {
                forkCurrent: true,
                forkAtMessage: true,
                rewindToMessage: false,
            },
        },
        conversationHistoryPoints: { 'local-1': true },
        conversationHistoryIndexes: { 'local-1': 0 },
        conversationHistoryTurns: { 'local-1': 'turn-1' },
        conversationHistoryEntryIds: { 'local-1': 'entry-1' },
        conversationHistoryDiverged: false,
        worktree: {
            basePath: '/workspace/hapi',
            branch: 'feat/pr3-context',
            name: 'pr3-context',
            worktreePath: '/workspace/hapi-wt',
            createdAt: 1700000000000,
        },
    }
}

function createSessionClone(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        active: true,
        activeAt: 1700000000000,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        activeTurnStartedAt: null,
        todos: [{ id: 'todo-1', content: 'Split context', status: 'pending', priority: 'high' }],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        resumeWithSessionModel: false,
        ...overrides,
    }
}

describe('HappyChatContext split and subscription boundaries', () => {
    it('isolates memoized HappyThread consumers across equivalent metadata, Todo-only, runtime-only, history-only updates, and session identity switch', () => {
        const api = new ApiClient('test-token')
        vi.spyOn(api, 'getHubSettings').mockResolvedValue({
            sessionSummaryContract: false,
            sessionSummaryInChat: false,
        })
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })

        const commits = {
            static: 0,
            todos: 0,
            sessionState: 0,
            history: 0,
        }
        const observed = {
            staticValue: null as HappyChatStaticContextValue | null,
            todosValue: null as HappyChatTodosContextValue | null,
            sessionStateValue: null as HappyChatSessionStateContextValue | null,
            historyValue: null as HappyChatHistoryContextValue | null,
        }

        const StaticConsumer = memo(function StaticConsumer() {
            commits.static += 1
            observed.staticValue = useHappyChatStaticContext()
            return <div data-testid="static-consumer">{observed.staticValue.sessionId}</div>
        })

        const TodosConsumer = memo(function TodosConsumer() {
            commits.todos += 1
            observed.todosValue = useHappyChatTodosContext()
            return <div data-testid="todos-consumer">{observed.todosValue.todos?.length ?? 0}</div>
        })

        const SessionStateConsumer = memo(function SessionStateConsumer() {
            commits.sessionState += 1
            observed.sessionStateValue = useHappyChatSessionStateContext()
            return (
                <div data-testid="session-state-consumer">
                    {String(observed.sessionStateValue.sessionThinking)}
                </div>
            )
        })

        const HistoryConsumer = memo(function HistoryConsumer() {
            commits.history += 1
            observed.historyValue = useHappyChatHistoryContext()
            return (
                <div data-testid="history-consumer">
                    {String(observed.historyValue.historyActionPending)}
                </div>
            )
        })

        const ProbeTree = memo(function ProbeTree() {
            return (
                <div>
                    <StaticConsumer />
                    <TodosConsumer />
                    <SessionStateConsumer />
                    <HistoryConsumer />
                </div>
            )
        })
        messageProbeSlot = () => <ProbeTree />

        const onRefresh = vi.fn()
        const onRetryMessage = vi.fn()
        const onForkConversation = vi.fn(async () => undefined)
        const onRewindConversation = vi.fn(async () => undefined)
        const isLatestCompletedBoundary = vi.fn(() => true)
        const onViewModeChange = vi.fn()
        const onLoadMore = vi.fn(async (): Promise<OlderLoadOutcome> => ({
            kind: 'stopped',
            reason: 'exhausted',
        }))
        const onCancelLoadMore = vi.fn()
        const onOutlineOpenChange = vi.fn()
        const outlineItems: never[] = []

        const initialMetadata = createMetadataClone()
        const initialSession = createSessionClone()

        const buildThreadTree = (overrides: {
            session?: Session
            sessionId?: string
            metadata?: SessionMetadataSummary | null
            disabled?: boolean
            historyActionPending?: boolean
            hasMoreMessages?: boolean
            isSyncingTail?: boolean
            isLoadingMoreMessages?: boolean
        } = {}) => (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <HappyThread
                        api={api}
                        session={overrides.session !== undefined ? overrides.session : initialSession}
                        sessionId={overrides.sessionId ?? 'session-1'}
                        metadata={overrides.metadata !== undefined ? overrides.metadata : initialMetadata}
                        disabled={overrides.disabled ?? false}
                        onRefresh={onRefresh}
                        onRetryMessage={onRetryMessage}
                        historyActionPending={overrides.historyActionPending ?? false}
                        onForkConversation={onForkConversation}
                        onRewindConversation={onRewindConversation}
                        isLatestCompletedBoundary={isLatestCompletedBoundary}
                        messagesWarning={null}
                        hasMoreMessages={overrides.hasMoreMessages ?? true}
                        isLoadingMoreMessages={overrides.isLoadingMoreMessages ?? false}
                        onLoadMore={onLoadMore}
                        onCancelLoadMore={onCancelLoadMore}
                        unseenCount={0}
                        rawMessagesCount={1}
                        normalizedMessagesCount={1}
                        messagesVersion={1}
                        historyVersion={1}
                        forceScrollToken={0}
                        onViewModeChange={onViewModeChange}
                        isSyncingTail={overrides.isSyncingTail ?? false}
                        outlineItems={outlineItems}
                        outlineOpen={false}
                        onOutlineOpenChange={onOutlineOpenChange}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        const { rerender } = render(buildThreadTree())

        expect(commits).toEqual({
            static: 1,
            todos: 1,
            sessionState: 1,
            history: 1,
        })
        const firstMetadataRef = observed.staticValue?.metadata
        expect(firstMetadataRef).toBe(initialMetadata)

        // 1. Equivalent SSE session + deeply cloned metadata copy -> 0 additional commits anywhere
        const clonedMetadata = createMetadataClone()
        expect(clonedMetadata).not.toBe(initialMetadata)
        expect(clonedMetadata.capabilities).not.toBe(initialMetadata.capabilities)
        expect(clonedMetadata.worktree).not.toBe(initialMetadata.worktree)

        const heartbeatSession = createSessionClone({
            seq: 2,
            updatedAt: 1700000005000,
            activeAt: 1700000005000,
            metadataVersion: 2,
            todos: initialSession.todos,
        })

        rerender(buildThreadTree({
            session: heartbeatSession,
            metadata: clonedMetadata,
        }))

        expect(commits).toEqual({
            static: 1,
            todos: 1,
            sessionState: 1,
            history: 1,
        })
        expect(observed.staticValue?.metadata).toBe(firstMetadataRef)

        // 2. Todo-only update -> commits ONLY TodosConsumer
        const nextTodos = [
            { id: 'todo-1', content: 'Split context', status: 'completed' as const, priority: 'high' as const },
            { id: 'todo-2', content: 'Verify commits', status: 'in_progress' as const, priority: 'medium' as const },
        ]
        rerender(buildThreadTree({
            session: createSessionClone({
                seq: 3,
                todos: nextTodos,
            }),
            metadata: createMetadataClone(),
        }))

        expect(commits).toEqual({
            static: 1,
            todos: 2,
            sessionState: 1,
            history: 1,
        })
        expect(observed.todosValue?.todos).toBe(nextTodos)

        // 3. Runtime / SessionState-only update -> commits ONLY SessionStateConsumer
        rerender(buildThreadTree({
            session: createSessionClone({
                seq: 4,
                todos: nextTodos,
                thinking: true,
                activeTurnStartedAt: 1700000010000,
            }),
            metadata: createMetadataClone(),
        }))

        expect(commits).toEqual({
            static: 1,
            todos: 2,
            sessionState: 2,
            history: 1,
        })
        expect(observed.sessionStateValue).toEqual({
            sessionThinking: true,
            activeTurnStartedAt: 1700000010000,
        })

        // 4. History-only updates -> commits ONLY HistoryConsumer
        rerender(buildThreadTree({
            session: createSessionClone({
                seq: 4,
                todos: nextTodos,
                thinking: true,
                activeTurnStartedAt: 1700000010000,
            }),
            metadata: createMetadataClone(),
            historyActionPending: true,
            hasMoreMessages: false,
            isSyncingTail: true,
            isLoadingMoreMessages: true,
        }))

        expect(commits).toEqual({
            static: 1,
            todos: 2,
            sessionState: 2,
            history: 2,
        })
        expect(observed.historyValue).toEqual({
            historyActionPending: true,
            hasMoreMessages: false,
            isSyncingTail: true,
            isLoadingMoreMessages: true,
        })

        // 5. Session identity switch -> commits StaticConsumer with new sessionId and metadata
        const switchedMetadata: SessionMetadataSummary = {
            ...createMetadataClone(),
            path: '/workspace/hapi-switched',
            host: 'prodbox',
        }
        rerender(buildThreadTree({
            session: createSessionClone({
                id: 'session-2',
                todos: nextTodos,
                thinking: true,
                activeTurnStartedAt: 1700000010000,
            }),
            sessionId: 'session-2',
            metadata: switchedMetadata,
            historyActionPending: true,
            hasMoreMessages: false,
            isSyncingTail: true,
            isLoadingMoreMessages: true,
        }))

        expect(commits).toEqual({
            static: 2,
            todos: 2,
            sessionState: 2,
            history: 2,
        })
        expect(observed.staticValue?.sessionId).toBe('session-2')
        expect(observed.staticValue?.metadata).toBe(switchedMetadata)

        queryClient.clear()
    })

    it('stabilizes metadata across all semantic fields and preserves undefined/null distinctions', () => {
        const base = createMetadataClone()
        expect(areSessionMetadataSummariesEqual(base, createMetadataClone())).toBe(true)
        expect(areSessionMetadataSummariesEqual(null, null)).toBe(true)
        expect(areSessionMetadataSummariesEqual(undefined, undefined)).toBe(true)
        expect(areSessionMetadataSummariesEqual(null, undefined)).toBe(false)
        expect(areSessionMetadataSummariesEqual(base, null)).toBe(false)

        // undefined vs null on nullable fields
        expect(
            areSessionMetadataSummariesEqual(
                { ...base, flavor: undefined },
                { ...base, flavor: null }
            )
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(
                { ...base, startingMode: undefined },
                { ...base, startingMode: null }
            )
        ).toBe(false)

        // Nested capabilities changes
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                capabilities: {
                    terminal: false,
                    conversationHistory: {
                        forkCurrent: true,
                        forkAtMessage: true,
                        rewindToMessage: false,
                    },
                },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                capabilities: {
                    terminal: true,
                    conversationHistory: {
                        forkCurrent: true,
                        forkAtMessage: true,
                        rewindToMessage: true,
                    },
                },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(
                { ...base, capabilities: undefined },
                { ...base, capabilities: {} }
            )
        ).toBe(false)

        // Nested summary, tools, worktree, and conversationHistory* maps
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                summary: { text: 'Changed summary', updatedAt: 1700000000000 },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                tools: ['Read', 'Bash'],
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                worktree: {
                    ...base.worktree!,
                    branch: 'feat/other-branch',
                },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                conversationHistoryPoints: { 'local-1': true, 'local-2': true },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(base, {
                ...createMetadataClone(),
                conversationHistoryEntryIds: { 'local-1': 'entry-2' },
            })
        ).toBe(false)
    })

    it('returns null from optional hooks and throws from required hooks when outside HappyChatProvider', () => {
        function OptionalProbe() {
            expect(useOptionalHappyChatStaticContext()).toBeNull()
            expect(useOptionalHappyChatTodosContext()).toBeNull()
            expect(useOptionalHappyChatSessionStateContext()).toBeNull()
            expect(useOptionalHappyChatHistoryContext()).toBeNull()
            return null
        }

        render(<OptionalProbe />)

        function RequiredHookProbe(props: { useHook: () => unknown }) {
            const resolved = props.useHook()
            return <div>{String(Boolean(resolved))}</div>
        }

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        try {
            expect(() => render(<RequiredHookProbe useHook={useHappyChatStaticContext} />)).toThrow(/HappyChatStaticContext/)
            expect(() => render(<RequiredHookProbe useHook={useHappyChatTodosContext} />)).toThrow(/HappyChatTodosContext/)
            expect(() => render(<RequiredHookProbe useHook={useHappyChatSessionStateContext} />)).toThrow(/HappyChatSessionStateContext/)
            expect(() => render(<RequiredHookProbe useHook={useHappyChatHistoryContext} />)).toThrow(/HappyChatHistoryContext/)
        } finally {
            consoleError.mockRestore()
        }
    })

    it('stabilizes metadata directly in HappyChatProvider when value object is recreated', () => {
        const api = new ApiClient('test-token')
        const onRefresh = vi.fn()
        const loadOlderMessagesPreservingScroll = vi.fn(async () => 'terminal-stop' as const)
        let staticCommits = 0
        let staticPlusHistoryCommits = 0

        const StaticConsumer = memo(function StaticConsumer() {
            staticCommits += 1
            const ctx = useHappyChatStaticContext()
            return <div data-testid="direct-static">{ctx.sessionId}</div>
        })

        const StaticAndHistoryConsumer = memo(function StaticAndHistoryConsumer() {
            staticPlusHistoryCommits += 1
            const staticCtx = useHappyChatStaticContext()
            const historyCtx = useHappyChatHistoryContext()
            return (
                <div data-testid="direct-static-history">
                    {staticCtx.sessionId}:{String(historyCtx.historyActionPending)}
                </div>
            )
        })

        const makeValue = (
            overrides: Partial<HappyChatContextValue> & { metadata: SessionMetadataSummary | null }
        ): HappyChatContextValue => ({
            api,
            sessionId: 'session-direct',
            todos: [],
            sessionThinking: false,
            activeTurnStartedAt: null,
            terminalToolDisplayMode: 'compact',
            showSessionSummaryInChat: false,
            disabled: false,
            onRefresh,
            historyActionPending: false,
            hasMoreMessages: false,
            isSyncingTail: false,
            isLoadingMoreMessages: false,
            loadOlderMessagesPreservingScroll,
            ...overrides,
        })

        const { rerender } = render(
            <HappyChatProvider value={makeValue({ metadata: createMetadataClone() })}>
                <StaticConsumer />
                <StaticAndHistoryConsumer />
            </HappyChatProvider>
        )
        expect(staticCommits).toBe(1)
        expect(staticPlusHistoryCommits).toBe(1)

        // Equivalent metadata + Todos + SessionState changes -> neither Static nor Static+History commits
        rerender(
            <HappyChatProvider
                value={makeValue({
                    metadata: createMetadataClone(),
                    todos: [{ id: 't1', content: 'Task', status: 'in_progress', priority: 'high' }],
                    sessionThinking: true,
                    activeTurnStartedAt: 1700000020000,
                })}
            >
                <StaticConsumer />
                <StaticAndHistoryConsumer />
            </HappyChatProvider>
        )
        expect(staticCommits).toBe(1)
        expect(staticPlusHistoryCommits).toBe(1)

        // History change -> StaticAndHistoryConsumer commits, StaticConsumer does not
        rerender(
            <HappyChatProvider
                value={makeValue({
                    metadata: createMetadataClone(),
                    todos: [{ id: 't1', content: 'Task', status: 'in_progress', priority: 'high' }],
                    sessionThinking: true,
                    activeTurnStartedAt: 1700000020000,
                    historyActionPending: true,
                })}
            >
                <StaticConsumer />
                <StaticAndHistoryConsumer />
            </HappyChatProvider>
        )
        expect(staticCommits).toBe(1)
        expect(staticPlusHistoryCommits).toBe(2)

        // Semantic metadata change -> both StaticConsumer and StaticAndHistoryConsumer commit
        rerender(
            <HappyChatProvider
                value={makeValue({
                    metadata: { ...createMetadataClone(), name: 'Renamed' },
                    todos: [{ id: 't1', content: 'Task', status: 'in_progress', priority: 'high' }],
                    sessionThinking: true,
                    activeTurnStartedAt: 1700000020000,
                    historyActionPending: true,
                })}
            >
                <StaticConsumer />
                <StaticAndHistoryConsumer />
            </HappyChatProvider>
        )
        expect(staticCommits).toBe(2)
        expect(staticPlusHistoryCommits).toBe(3)
    })
})
