import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import {
    ModelRefusalToastConsumer,
    SessionEntityStoreIngestionBridge,
    useSessionChatPipeline,
} from '@/components/sessionChatHelpers'
import {
    SessionStatusSlot,
    useSessionMentionTooltipResolver,
} from '@/components/AssistantChat/SessionChatSurfaces'
import { I18nProvider } from '@/lib/i18n-context'
import { appendOptimisticMessage, clearMessageWindow } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { ToastProvider, useToast } from '@/lib/toast-context'
import type { DecryptedMessage, Session, SessionSummary } from '@/types/api'

afterEach(() => {
    cleanup()
    clearMessageWindow('sess-iso-1')
})

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sess-iso-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        active: true,
        activeAt: 1_700_000_000_000,
        metadata: {
            path: '/workspace/hapi',
            host: 'c1',
            name: 'Initial Title',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: 'claude-sonnet-4-5',
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        resumeWithSessionModel: false,
        ...overrides,
    }
}

describe('SessionChat surface isolation and imperative ingestion bridge', () => {
    it('ingests message-window and session query cache updates into entityStore without re-rendering the shell', () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: Infinity } },
        })
        const initialSession = makeSession()
        queryClient.setQueryData(queryKeys.session('sess-iso-1'), { session: initialSession })

        let shellRenders = 0
        let capturedStore: import('@/chat/store/sessionEntityStore').SessionEntityStore | null = null

        function TestShell() {
            shellRenders += 1
            const { entityStore } = useSessionChatPipeline({
                sessionId: 'sess-iso-1',
                hasMoreMessages: false,
            })
            capturedStore = entityStore
            return (
                <>
                    <SessionEntityStoreIngestionBridge
                        sessionId="sess-iso-1"
                        hasMoreMessages={false}
                        entityStore={entityStore}
                    />
                    <SessionStatusSlot entityStore={entityStore} />
                </>
            )
        }

        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <TestShell />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(shellRenders).toBe(1)
        expect(capturedStore).not.toBeNull()

        // Updating header/todo/composer/backgroundTaskCount in QueryClient must NOT re-render TestShell
        act(() => {
            queryClient.setQueryData(queryKeys.session('sess-iso-1'), {
                session: makeSession({
                    backgroundTaskCount: 2,
                    todos: [{ id: 't1', content: 'Task 1', status: 'in_progress', priority: 'high' }],
                    metadata: {
                        path: '/workspace/hapi',
                        host: 'c1',
                        name: 'Renamed Session',
                        flavor: 'claude',
                    },
                }),
            })
        })

        expect(shellRenders).toBe(1)

        // Streaming messages into message-window-store updates entityStore imperatively with 0 shell re-renders
        const userMsg: DecryptedMessage = {
            id: 'm-user-1',
            seq: 1,
            localId: 'm-user-1',
            createdAt: 1000,
            invokedAt: 1000,
            status: 'sent',
            content: {
                role: 'user',
                content: { type: 'text', text: 'Hello' },
            },
        }
        act(() => {
            appendOptimisticMessage('sess-iso-1', userMsg)
        })

        expect(shellRenders).toBe(1)
        expect(capturedStore!.getSnapshot().visibleMessages).toHaveLength(1)
    })

    it('emits model refusal fallback toast from ModelRefusalToastConsumer without re-rendering the shell', () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: Infinity } },
        })
        let shellRenders = 0
        let latestToastTitles: string[] = []

        function ToastProbe() {
            const { toasts } = useToast()
            latestToastTitles = toasts.map((toast) => toast.title)
            return <div data-testid="toast-count">{toasts.length}</div>
        }

        const refusalMessages: DecryptedMessage[] = [{
            id: 'msg-refusal-1',
            seq: 1,
            localId: null,
            createdAt: 2000,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'system',
                        subtype: 'model_refusal_fallback',
                        uuid: 'sys-refusal-1',
                        direction: 'retry',
                        trigger: 'refusal',
                        originalModel: 'claude-fable-5[1m]',
                        content: 'Switched to fallback model.',
                    },
                },
            },
        }]

        function RefusalShell() {
            shellRenders += 1
            const { entityStore } = useSessionChatPipeline({
                sessionId: 'sess-refusal',
                messages: refusalMessages,
                hasMoreMessages: false,
            })
            return (
                <>
                    <ModelRefusalToastConsumer entityStore={entityStore} sessionId="sess-refusal" />
                    <ToastProbe />
                </>
            )
        }

        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <RefusalShell />
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(shellRenders).toBe(1)
        expect(screen.getByTestId('toast-count').textContent).toBe('1')
        expect(latestToastTitles).toHaveLength(1)
    })

    it('resolves @session mention tooltips from QueryClient cache on demand without subscribing to queryKeys.sessions', () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: Infinity } },
        })
        const getSessions = vi.fn(async () => ({ sessions: [] as SessionSummary[] }))
        const api = { getSessions } as unknown as ApiClient

        let consumerRenders = 0
        let resolveTooltip: ((id: string, title: string) => unknown) | null = null

        function MentionProbe() {
            consumerRenders += 1
            resolveTooltip = useSessionMentionTooltipResolver(api)
            return null
        }

        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <MentionProbe />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(consumerRenders).toBe(1)

        // Cold cache miss triggers background fetchQuery without re-rendering MentionProbe
        const coldResult = resolveTooltip!('sess-other', 'Other Session') as { session: SessionSummary | null }
        expect(coldResult.session).toBeNull()
        expect(getSessions).toHaveBeenCalledTimes(1)

        // Updating queryKeys.sessions in QueryClient must NOT re-render MentionProbe
        const summary: SessionSummary = {
            id: 'sess-other',
            active: true,
            thinking: true,
            activeAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            metadata: {
                path: '/workspace/other',
                host: 'c1',
                name: 'Other Session Title',
                flavor: 'claude',
            },
            metadataVersion: 1,
            agentStateVersion: 1,
            todosUpdatedAt: 0,
            todoProgress: null,
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: 'claude-sonnet-4-5',
            modelReasoningEffort: null,
            effort: null,
        }
        act(() => {
            queryClient.setQueryData(queryKeys.sessions, { sessions: [summary] })
        })

        expect(consumerRenders).toBe(1)
        const warmResult = resolveTooltip!('sess-other', 'Other Session') as { session: SessionSummary | null }
        expect(warmResult.session?.id).toBe('sess-other')
    })
})
