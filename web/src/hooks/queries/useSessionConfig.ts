import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionConfigResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionConfig(api: ApiClient | null, sessionId: string | null): {
    config: SessionConfigResponse | null
    error: string | null
    isLoading: boolean
    isFetching: boolean
    refetch: () => Promise<unknown>
} {
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

    return {
        config: query.data?.config ?? null,
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        refetch: query.refetch,
    }
}
