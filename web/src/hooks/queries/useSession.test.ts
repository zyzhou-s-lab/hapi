import { createElement, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { applySessionDetailPatch } from '@/lib/sessionPatch'
import type { Session, SessionSummary } from '@/types/api'
import {
    areSessionMetadataSummariesEqual,
    isSessionNotFoundError,
    SESSION_DETAIL_STALE_TIME_MS,
    useSession,
    useSessionComposerConfig,
    useSessionHeaderSlice,
    useSessionRouteState,
    useSessionRunState,
    useSessionTodoSnapshot,
} from './useSession'

describe('isSessionNotFoundError', () => {
    it('matches hub 404 and 410 session responses and status errors', () => {
        expect(isSessionNotFoundError(new Error('HTTP 404 Not Found: {"error":"Session not found"}'))).toBe(true)
        expect(isSessionNotFoundError(new Error('HTTP 410 Gone'))).toBe(true)
        expect(isSessionNotFoundError(Object.assign(new Error('Gone'), { status: 410 }))).toBe(true)
        expect(isSessionNotFoundError(Object.assign(new Error('Not found'), { status: 404 }))).toBe(true)
    })

    it('does not match unrelated errors', () => {
        expect(isSessionNotFoundError(new Error('HTTP 500 Internal Server Error'))).toBe(false)
        expect(isSessionNotFoundError(null)).toBe(false)
    })
})

describe('SESSION_DETAIL_STALE_TIME_MS', () => {
    // SSE patches the cache directly on session-updated events, so the REST
    // endpoint is just a cold-start / reconnect-recovery path.  A long staleTime
    // suppresses focus-refetch and remount-refetch storms — primary lever for
    // the refetch-storm fix (tiann/hapi#884).
    it('is set to a value that suppresses focus/mount refetches', () => {
        expect(SESSION_DETAIL_STALE_TIME_MS).toBeGreaterThanOrEqual(10_000)
    })
})

describe('useSession placeholderData from session list summary', () => {
    it('returns placeholder session immediately from cached session summaries until detail fetch resolves', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })
        const summary: SessionSummary = {
            id: 'sess-1',
            active: true,
            thinking: false,
            activeAt: 1_000,
            updatedAt: 2_000,
            metadata: {
                name: 'Summary Title',
                path: '/work/repo',
                host: 'c1',
                flavor: 'omp',
            },
            metadataVersion: 3,
            agentStateVersion: 4,
            todosUpdatedAt: 0,
            todoProgress: null,
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: 'claude',
            effort: null,
        }
        queryClient.setQueryData(queryKeys.sessions, { sessions: [summary] })

        const { promise: detailPromise, resolve: resolveDetail } = Promise.withResolvers<unknown>()
        const api = {
            getSession: vi.fn().mockReturnValue(detailPromise),
        } as unknown as ApiClient

        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result } = renderHook(() => useSession(api, 'sess-1'), { wrapper })

        expect(result.current.isPlaceholderData).toBe(true)
        expect(result.current.session?.id).toBe('sess-1')
        expect(result.current.session?.metadata?.name).toBe('Summary Title')

        resolveDetail({
            session: {
                id: 'sess-1',
                namespace: 'default',
                seq: 10,
                createdAt: 1_000,
                updatedAt: 2_500,
                active: true,
                activeAt: 1_000,
                metadata: {
                    path: '/work/repo',
                    host: 'c1',
                    name: 'Full Detail Title',
                    supersededBySessionId: 'sess-2',
                },
                metadataVersion: 4,
                agentState: null,
                agentStateVersion: 4,
                thinking: false,
                thinkingAt: 0,
                model: 'claude',
                modelReasoningEffort: null,
                effort: null,
                serviceTier: null,
                resumeWithSessionModel: false,
            },
        })

        await waitFor(() => {
            expect(result.current.isPlaceholderData).toBe(false)
        })
        expect(result.current.session?.metadata?.name).toBe('Full Detail Title')
        expect(result.current.session?.metadata?.supersededBySessionId).toBe('sess-2')
    })
})

describe('domain-specific session selector hooks', () => {
    function createFullSession(overrides: Partial<Session> = {}): Session {
        return {
            id: 'sess-domain',
            namespace: 'default',
            seq: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            active: true,
            activeAt: 1_000,
            metadata: {
                path: '/work/repo',
                host: 'c1',
                name: 'Domain Session',
                flavor: 'claude',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            activeTurnId: null,
            activeTurnStartedAt: null,
            lifecycleState: 'idle',
            backgroundTaskCount: 0,
            todos: [],
            model: 'claude-3-7-sonnet',
            modelReasoningEffort: null,
            effort: null,
            serviceTier: null,
            resumeWithSessionModel: false,
            ...overrides,
        }
    }

    it('isolates runState, todos, header, and composerConfig subscriptions across SSE patches', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    retry: false,
                    staleTime: SESSION_DETAIL_STALE_TIME_MS,
                },
            },
        })
        const initial = createFullSession()
        queryClient.setQueryData(queryKeys.session('sess-domain'), { session: initial })
        const api = {
            getSession: vi.fn().mockResolvedValue({ session: initial }),
        } as unknown as ApiClient
        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        let runStateRenders = 0
        let todoRenders = 0
        let headerRenders = 0
        let composerRenders = 0

        const { result } = renderHook(
            () => {
                const runState = useSessionRunState(api, 'sess-domain', initial)
                const todos = useSessionTodoSnapshot(api, 'sess-domain', initial)
                const header = useSessionHeaderSlice(api, 'sess-domain', initial, initial.metadata)
                const composer = useSessionComposerConfig(api, 'sess-domain', initial)
                return { runState, todos, header, composer }
            },
            { wrapper }
        )

        const runHook = renderHook(
            () => {
                runStateRenders += 1
                return useSessionRunState(api, 'sess-domain', initial)
            },
            { wrapper }
        )
        const todoHook = renderHook(
            () => {
                todoRenders += 1
                return useSessionTodoSnapshot(api, 'sess-domain', initial)
            },
            { wrapper }
        )
        const headerHook = renderHook(
            () => {
                headerRenders += 1
                return useSessionHeaderSlice(api, 'sess-domain', initial, initial.metadata)
            },
            { wrapper }
        )
        const composerHook = renderHook(
            () => {
                composerRenders += 1
                return useSessionComposerConfig(api, 'sess-domain', initial)
            },
            { wrapper }
        )

        expect(runStateRenders).toBe(1)
        expect(todoRenders).toBe(1)
        expect(headerRenders).toBe(1)
        expect(composerRenders).toBe(1)
        const queryEntry = queryClient.getQueryCache().find({ queryKey: queryKeys.session('sess-domain') })
        expect(queryEntry?.getObserversCount()).toBeGreaterThan(0)

        // Patch only todos -> only todoHook re-renders
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-domain'),
                (old) => {
                    if (!old) return old
                    const next = applySessionDetailPatch(old.session, {
                        updatedAt: 2_000,
                        todos: {
                            version: 2,
                            value: [{ id: 't-1', content: 'Ship fix', status: 'in_progress', priority: 'high' }],
                        },
                    })
                    return next ? { session: next } : old
                }
            )
        })
        await waitFor(() => {
            expect(todoHook.result.current?.todos).toHaveLength(1)
        })
        expect(todoRenders).toBe(2)
        expect(runStateRenders).toBe(1)
        expect(headerRenders).toBe(1)
        expect(composerRenders).toBe(1)

        // Patch only thinking/runState -> only runHook re-renders
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-domain'),
                (old) => {
                    if (!old) return old
                    const next = applySessionDetailPatch(old.session, {
                        updatedAt: 3_000,
                        thinking: true,
                        activeTurnId: 'turn-1',
                        lifecycleState: 'thinking',
                    })
                    return next ? { session: next } : old
                }
            )
        })

        await waitFor(() => {
            expect(runHook.result.current?.thinking).toBe(true)
        })
        expect(runHook.result.current?.activeTurnId).toBe('turn-1')
        expect(runStateRenders).toBe(2)
        expect(todoRenders).toBe(2)
        expect(headerRenders).toBe(1)
        expect(composerRenders).toBe(1)

        // Patch only composer permissionMode -> only composerHook re-renders
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-domain'),
                (old) => {
                    if (!old) return old
                    const next = applySessionDetailPatch(old.session, {
                        updatedAt: 4_000,
                        permissionMode: 'auto',
                    })
                    return next ? { session: next } : old
                }
            )
        })

        await waitFor(() => {
            expect(composerHook.result.current?.permissionMode).toBe('auto')
        })
        expect(composerRenders).toBe(2)
        expect(runStateRenders).toBe(2)
        expect(todoRenders).toBe(2)
        expect(headerRenders).toBe(1)
        expect(headerHook.result.current?.metadata?.name).toBe('Domain Session')
        expect(result.current.header?.metadata?.name).toBe('Domain Session')
    })

    it('resets stabilized metadata immediately when switching sessionId', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    retry: false,
                    staleTime: SESSION_DETAIL_STALE_TIME_MS,
                },
            },
        })
        const sessionA = createFullSession({
            id: 'sess-a',
            metadata: { path: '/work/a', host: 'c1', name: 'Session A' },
        })
        const sessionB = createFullSession({
            id: 'sess-b',
            metadata: null,
        })
        queryClient.setQueryData(queryKeys.session('sess-a'), { session: sessionA })
        queryClient.setQueryData(queryKeys.session('sess-b'), { session: sessionB })
        const api = {
            getSession: vi.fn(),
        } as unknown as ApiClient
        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result, rerender } = renderHook(
            ({ session }: { session: Session }) =>
                useSessionHeaderSlice(api, session.id, session, session.metadata),
            {
                initialProps: { session: sessionA },
                wrapper,
            }
        )

        expect(result.current?.sessionId).toBe('sess-a')
        expect(result.current?.metadata?.name).toBe('Session A')

        rerender({ session: sessionB })

        expect(result.current?.sessionId).toBe('sess-b')
        expect(result.current?.metadata).toBeNull()
    })

    it('useSessionRouteState ignores thinking, updatedAt, seq, todos, agentState, and summary.updatedAt patches while reacting to title, supersede, and resume changes', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    retry: false,
                    staleTime: SESSION_DETAIL_STALE_TIME_MS,
                },
            },
        })
        const initial = createFullSession({
            id: 'sess-route',
            metadata: {
                path: '/work/route',
                host: 'c1',
                name: 'Initial Title',
                summary: { text: 'Initial summary', updatedAt: 1_000 },
                flavor: 'claude',
                claudeSessionId: 'claude-1',
            },
        })
        queryClient.setQueryData(queryKeys.session('sess-route'), { session: initial })
        const api = {
            getSession: vi.fn().mockResolvedValue({ session: initial }),
        } as unknown as ApiClient
        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        let routeRenders = 0
        const routeHook = renderHook(
            () => {
                routeRenders += 1
                return useSessionRouteState(api, 'sess-route')
            },
            { wrapper }
        )

        expect(routeRenders).toBe(1)
        const firstSessionRef = routeHook.result.current.session
        expect(firstSessionRef?.id).toBe('sess-route')
        expect(firstSessionRef?.metadata?.name).toBe('Initial Title')

        // Patch streaming/runtime fields: thinking, thinkingAt, updatedAt, seq, todos, agentState, and summary.updatedAt (same text)
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-route'),
                (old) => {
                    if (!old) return old
                    return {
                        session: {
                            ...old.session,
                            seq: 42,
                            updatedAt: 9_000,
                            thinking: true,
                            thinkingAt: 8_500,
                            activeTurnId: 'turn-stream',
                            lifecycleState: 'thinking',
                            todos: [{ id: 't1', content: 'Streaming', status: 'in_progress', priority: 'high' }],
                            todosUpdatedAt: 9_000,
                            agentState: { controlledByUser: false },
                            agentStateVersion: 5,
                            metadata: old.session.metadata
                                ? {
                                    ...old.session.metadata,
                                    summary: { text: 'Initial summary', updatedAt: 9_000 },
                                    ompThinking: { thinkingLevel: 'high', configured: true, resolved: true },
                                }
                                : null,
                        },
                    }
                }
            )
        })

        expect(routeRenders).toBe(1)
        expect(routeHook.result.current.session).toBe(firstSessionRef)

        // Patch route title (metadata.name) -> notifies observer
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-route'),
                (old) => {
                    if (!old) return old
                    return {
                        session: {
                            ...old.session,
                            metadata: old.session.metadata
                                ? { ...old.session.metadata, name: 'Renamed Title' }
                                : null,
                        },
                    }
                }
            )
        })

        await waitFor(() => {
            expect(routeHook.result.current.session?.metadata?.name).toBe('Renamed Title')
        })
        expect(routeRenders).toBe(2)

        // Patch supersede (metadata.supersededBySessionId) -> notifies observer
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-route'),
                (old) => {
                    if (!old) return old
                    return {
                        session: {
                            ...old.session,
                            metadata: old.session.metadata
                                ? { ...old.session.metadata, supersededBySessionId: 'sess-next' }
                                : null,
                        },
                    }
                }
            )
        })

        await waitFor(() => {
            expect(routeHook.result.current.session?.metadata?.supersededBySessionId).toBe('sess-next')
        })
        expect(routeRenders).toBe(3)

        // Patch resume readiness (active + cursorSessionId) -> notifies observer
        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-route'),
                (old) => {
                    if (!old) return old
                    return {
                        session: {
                            ...old.session,
                            active: false,
                            metadata: old.session.metadata
                                ? {
                                    ...old.session.metadata,
                                    flavor: 'cursor',
                                    cursorSessionId: 'cursor-chat-99',
                                    cursorSessionProtocol: 'acp',
                                    cursorMigrationState: 'prompt_pending',
                                }
                                : null,
                        },
                    }
                }
            )
        })

        await waitFor(() => {
            expect(routeHook.result.current.session?.active).toBe(false)
        })
        expect(routeHook.result.current.session?.metadata?.cursorSessionId).toBe('cursor-chat-99')
        expect(routeHook.result.current.session?.metadata?.cursorMigrationState).toBe('prompt_pending')
        expect(routeRenders).toBe(4)
    })

    it('useSessionRouteState provides cold placeholder from sessions list and evicts 404/410 from sessions cache', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    staleTime: SESSION_DETAIL_STALE_TIME_MS,
                },
            },
        })
        const summary: SessionSummary = {
            id: 'sess-404',
            active: false,
            activeAt: 1_000,
            updatedAt: 1_500,
            metadata: {
                path: '/repo/gone',
                host: 'c1',
                name: 'Gone Session',
                flavor: 'claude',
            },
            metadataVersion: 1,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            todosUpdatedAt: undefined,
            pendingRequestsCount: 0,
            model: 'claude-3-7-sonnet',
        }
        queryClient.setQueryData(queryKeys.sessions, { sessions: [summary] })

        const { promise: detailPromise, reject: rejectDetail } = Promise.withResolvers<{ session: Session }>()
        const getSession = vi.fn().mockImplementation(() => detailPromise)
        const api = { getSession } as unknown as ApiClient
        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result } = renderHook(() => useSessionRouteState(api, 'sess-404'), { wrapper })

        expect(result.current.isPlaceholderData).toBe(true)
        expect(result.current.session?.id).toBe('sess-404')
        expect(result.current.session?.metadata?.name).toBe('Gone Session')
        expect(result.current.notFound).toBe(false)

        act(() => {
            rejectDetail(new Error('HTTP 404 Not Found: {"error":"Session not found"}'))
        })

        await waitFor(() => {
            expect(result.current.notFound).toBe(true)
        })
        expect(result.current.session).toBeNull()
        expect(result.current.isPlaceholderData).toBe(false)
        expect(getSession).toHaveBeenCalledTimes(1)
        const remainingSessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        expect(remainingSessions?.sessions).toEqual([])
    })

    it('preserves ompThinking, pi models, prompt cache, and ccSwitch settings across metadata equality and composer slice', async () => {
        const baseMeta: NonNullable<Session['metadata']> = {
            path: '/work/repo',
            host: 'c1',
            flavor: 'omp',
            ompThinking: { thinkingLevel: 'medium', configured: true, resolved: true },
            piSelectedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
            piAvailableModels: [
                { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', reasoning: true, contextWindow: 200_000 },
            ],
            ccSwitchProviderId: 'provider-1',
        }
        expect(areSessionMetadataSummariesEqual(baseMeta, { ...baseMeta })).toBe(true)
        expect(
            areSessionMetadataSummariesEqual(baseMeta, {
                ...baseMeta,
                ompThinking: { thinkingLevel: 'high', configured: true, resolved: true },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(baseMeta, {
                ...baseMeta,
                piSelectedModel: { provider: 'openai', modelId: 'gpt-5' },
            })
        ).toBe(false)
        expect(
            areSessionMetadataSummariesEqual(baseMeta, {
                ...baseMeta,
                ccSwitchProviderId: 'provider-2',
            })
        ).toBe(false)

        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false, staleTime: SESSION_DETAIL_STALE_TIME_MS },
            },
        })
        const initial = createFullSession({
            id: 'sess-composer-meta',
            metadata: baseMeta,
        })
        queryClient.setQueryData(queryKeys.session('sess-composer-meta'), { session: initial })
        const api = {
            getSession: vi.fn().mockResolvedValue({ session: initial }),
        } as unknown as ApiClient
        const wrapper = ({ children }: PropsWithChildren) =>
            createElement(QueryClientProvider, { client: queryClient }, children)

        const { result } = renderHook(
            () => ({
                header: useSessionHeaderSlice(api, 'sess-composer-meta', initial, initial.metadata),
                composer: useSessionComposerConfig(api, 'sess-composer-meta', initial),
            }),
            { wrapper }
        )

        expect(result.current.composer?.ompThinking?.thinkingLevel).toBe('medium')
        expect(result.current.composer?.piSelectedModel?.modelId).toBe('claude-sonnet-4')
        expect(result.current.composer?.ccSwitchProviderId).toBe('provider-1')

        act(() => {
            queryClient.setQueryData<{ session: Session } | undefined>(
                queryKeys.session('sess-composer-meta'),
                (old) => {
                    if (!old) return old
                    return {
                        session: {
                            ...old.session,
                            updatedAt: 5_000,
                            metadata: {
                                ...baseMeta,
                                ompThinking: { thinkingLevel: 'high', configured: true, resolved: true },
                                piSelectedModel: { provider: 'openai', modelId: 'gpt-5' },
                                ccSwitchProviderId: 'provider-2',
                            },
                        },
                    }
                }
            )
        })

        await waitFor(() => {
            expect(result.current.composer?.ompThinking?.thinkingLevel).toBe('high')
        })
        expect(result.current.composer?.piSelectedModel?.modelId).toBe('gpt-5')
        expect(result.current.composer?.ccSwitchProviderId).toBe('provider-2')
        expect(result.current.header?.metadata?.ccSwitchProviderId).toBe('provider-2')
    })
})
