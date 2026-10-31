import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function presentMachines(machines: readonly (Machine | null | undefined)[] | null | undefined): Machine[] {
    return (machines ?? []).filter((machine): machine is Machine => machine != null && typeof machine.id === 'string' && machine.id.length > 0)
}

export function useMachines(api: ApiClient | null, enabled: boolean): {
    machines: Machine[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.machines,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getMachines()
        },
        enabled: Boolean(api && enabled),
    })

    const machines = useMemo(() => presentMachines(query.data?.machines), [query.data?.machines])
    return {
        machines,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machines' : null,
        refetch: query.refetch,
    }
}
