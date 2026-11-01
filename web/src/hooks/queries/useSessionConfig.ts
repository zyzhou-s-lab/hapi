import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionConfigResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionConfig(api: ApiClient | null, sessionId: string | null): {
    config: SessionConfigResponse | null
    error: string | null
    isLoading: boolean
    isFetching: boolean
    refetch: () => Promise<unknown>
    reload: (options?: { fresh?: boolean; check?: string }) => Promise<void>
} {
    const queryClient = useQueryClient()
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.sessionConfig(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.getSessionConfig(sessionId)
            if (!response.success) {
                return { config: null, error: response.error ?? 'Session config unavailable' }
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
        const response = await api.getSessionConfig(sessionId, options)
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
