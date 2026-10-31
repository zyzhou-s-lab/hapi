import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { presentMachines } from '@/hooks/queries/useMachines'

export const agentSkillMachinesQueryKey = ['agent-skill-machines'] as const

export function useAgentSkillMachines(api: ApiClient | null): {
    machines: Machine[]
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        queryKey: agentSkillMachinesQueryKey,
        queryFn: () => api!.getMachines(),
        enabled: Boolean(api)
    })

    const machines = useMemo(() => presentMachines(query.data?.machines), [query.data?.machines])
    return {
        machines,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : null
    }
}
