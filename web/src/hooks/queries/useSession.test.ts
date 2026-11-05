import { createElement, type PropsWithChildren } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import type { SessionSummary } from '@/types/api'
import { isSessionNotFoundError, SESSION_DETAIL_STALE_TIME_MS, useSession } from './useSession'

describe('isSessionNotFoundError', () => {
    it('matches hub 404 session responses', () => {
        expect(isSessionNotFoundError(new Error('HTTP 404 Not Found: {"error":"Session not found"}'))).toBe(true)
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
