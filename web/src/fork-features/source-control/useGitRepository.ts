import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys, type GitRepositoryQueryKey } from '@/lib/query-keys'
import type {
    GitRepositoryResponse,
    GitRepositoryStatus,
    GitScope
} from '@hapi/protocol/sourceControl'

type GitRepositoryQueryResult = {
    repository: GitRepositoryStatus | null
    error: string | null
}

const GIT_UNAVAILABLE = 'Git status unavailable'

/**
 * One query key for every direct consumer (composer, Files, pickers). The
 * session id stays in the key when `api` is null so cached repository data can
 * still render offline.
 */
export function gitRepositoryQueryKey(
    sessionId: string | null,
    scope: GitScope,
    baseRef?: string
): GitRepositoryQueryKey {
    return queryKeys.gitRepository(sessionId ?? 'unknown', scope, baseRef)
}

function responseError(result: GitRepositoryResponse): string | null {
    if (result.success) return null
    return result.error ?? result.stderr ?? GIT_UNAVAILABLE
}

export function useGitRepository(
    api: ApiClient | null,
    sessionId: string | null,
    scope: GitScope = 'working',
    baseRef?: string
): {
    repository: GitRepositoryStatus | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<GitRepositoryStatus | null>
} {
    const queryClient = useQueryClient()
    const normalizedBaseRef = baseRef?.trim() || undefined
    const query = useQuery<GitRepositoryQueryResult>({
        queryKey: gitRepositoryQueryKey(sessionId, scope, normalizedBaseRef),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const result = await api.getGitRepository(sessionId, {
                details: true,
                scope,
                ...(normalizedBaseRef ? { baseRef: normalizedBaseRef } : {})
            })
            const repository = result.repository ?? null
            const error = responseError(result)
            if (!repository) {
                return { repository: null, error: error ?? (result.success ? 'git_protocol_mismatch' : GIT_UNAVAILABLE) }
            }
            return { repository, error }
        },
        enabled: Boolean(api && sessionId)
    })

    const { refetch: refetchQuery } = query
    const refetch = useCallback(async (): Promise<GitRepositoryStatus | null> => {
        if (!api || !sessionId) {
            return query.data?.error ? null : query.data?.repository ?? null
        }
        // A write can change HEAD, index and worktree, so every cached scope for
        // this session is stale. Mark them all stale, then refresh this scope.
        await queryClient.invalidateQueries({
            queryKey: queryKeys.gitRepositoryAll(sessionId),
            refetchType: 'none'
        })
        const result = await refetchQuery()
        if (result.isError || result.data?.error) {
            return null
        }
        return result.data?.repository ?? null
    }, [api, query.data, queryClient, refetchQuery, sessionId])

    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? GIT_UNAVAILABLE
            : null

    return {
        repository: query.data?.repository ?? null,
        isLoading: query.isLoading,
        error: queryError ?? query.data?.error ?? null,
        refetch
    }
}
