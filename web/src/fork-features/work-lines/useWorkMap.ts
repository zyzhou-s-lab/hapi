import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { WorkMapData } from './deriveWork'

export const workMapKey = ['work', 'map'] as const
export const workCardMapPrefix = ['work', 'card'] as const

export function workCardMapKey(cardId: string) {
    return [...workCardMapPrefix, cardId] as const
}

export function loadWorkCardMap(api: ApiClient, cardId: string): Promise<WorkMapData> {
    const targeted = (api as ApiClient & { getWorkCardMap?: (cardId: string) => Promise<WorkMapData> }).getWorkCardMap
    if (targeted) return targeted(cardId)
    return api.getWorkMap()
}

export function useWorkMap(api: ApiClient | null): {
    map: WorkMapData | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: workMapKey,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getWorkMap()
        },
        enabled: Boolean(api),
    })
    return {
        map: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : null,
        refetch: query.refetch,
    }
}
