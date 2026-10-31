import type { QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { WorkMapData } from './deriveWork'

/** One network read. Cards do not use this key for their own error or retry. */
export const workMapKey = ['work', 'map'] as const

/** Per-card error/retry keys. Not a prefix of other work queries. */
export const workCardMapPrefix = ['work', 'card-map'] as const

export function workCardMapKey(cardId: string) {
    return [...workCardMapPrefix, cardId] as const
}

export function workMapQueryOptions(api: ApiClient | null) {
    return {
        queryKey: workMapKey,
        queryFn: () => {
            if (!api) throw new Error('API unavailable')
            return api.getWorkMap()
        },
        enabled: Boolean(api),
    }
}

export function loadWorkCardMap(api: ApiClient, queryClient: QueryClient): Promise<WorkMapData> {
    const options = workMapQueryOptions(api)
    return queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn })
}
