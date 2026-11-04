import { useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionConfigResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

function hasUnprobedUserMcpServer(response: SessionConfigResponse): boolean {
    if (response.mcp?.kind !== 'servers') return false
    return response.mcp.servers.some(
        (server) => server.source === 'user' && server.enabled !== false && server.loaded === undefined,
    )
}

export function useSessionConfig(api: ApiClient | null, sessionId: string | null, flavor?: string | null): {
    config: SessionConfigResponse | null
    error: string | null
    isLoading: boolean
    isFetching: boolean
    refetch: () => Promise<unknown>
    reload: (options?: { fresh?: boolean; check?: string }) => Promise<void>
} {
    const queryClient = useQueryClient()
    const resolvedSessionId = sessionId ?? 'unknown'
    const requestGenRef = useRef(0)
    const useFastProbe = flavor === undefined || flavor === null || flavor.trim().toLowerCase() === 'omp'
    const query = useQuery({
        queryKey: queryKeys.sessionConfig(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const gen = ++requestGenRef.current
            const response = await api.getSessionConfig(sessionId, useFastProbe ? { probe: false } : undefined)
            if (!response.success) {
                return { config: null, error: response.error ?? 'Session config unavailable' }
            }
            if (useFastProbe && hasUnprobedUserMcpServer(response)) {
                void api.getSessionConfig(sessionId).then((probed) => {
                    if (requestGenRef.current !== gen || !probed.success) return
                    queryClient.setQueryData(queryKeys.sessionConfig(resolvedSessionId), {
                        config: probed,
                        error: null,
                    })
                }).catch(() => undefined)
            }
            return { config: response, error: null }
        },
        enabled: Boolean(api && sessionId),
    })
    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? 'Session config unavailable'
            : null

    const reload = async (options?: { fresh?: boolean; check?: string }) => {
        if (!api || !sessionId) return
        const gen = ++requestGenRef.current
        const response = await api.getSessionConfig(sessionId, options)
        if (requestGenRef.current !== gen) return
        queryClient.setQueryData(queryKeys.sessionConfig(resolvedSessionId), response.success
            ? { config: response, error: null }
            : { config: null, error: response.error ?? 'Session config unavailable' })
    }

    return {
        config: query.data?.config ?? null,
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        refetch: query.refetch,
        reload,
    }
}
