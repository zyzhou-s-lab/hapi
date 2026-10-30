import { useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useSessions } from '@/hooks/queries/useSessions'
import { WorkCardHost } from './WorkCardHost'
import './workbenchCards'
import { workMapQueryOptions } from './useWorkMap'
import { defaultWorkSearch, type WorkSearch } from './workSearch'

export function Workbench(props: { search: WorkSearch }): ReactNode {
    const { api } = useAppContext()
    const { sessions } = useSessions(api)
    const { t } = useTranslation()
    const navigate = useNavigate()
    const mapQuery = useQuery(workMapQueryOptions(api))
    const map = mapQuery.data ?? null
    useEffect(() => {
        if (!map) return
        const next = defaultWorkSearch(props.search, map.lines.map((line) => line.id))
        if (!next) return
        void navigate({ to: '/work', search: next, replace: true })
    }, [map, navigate, props.search.inbox, props.search.line])
    const view = props.search.line
        ? { kind: 'line' as const, lineId: props.search.line }
        : props.search.inbox
            ? { kind: 'inbox' as const }
            : { kind: 'line' as const, lineId: '' }
    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="flex items-center justify-between px-4 py-3">
                <h2 className="text-base font-semibold text-[var(--app-fg)]">{t('work.workbenchTitle')}</h2>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <WorkCardHost surface="workbench" view={view} sessions={sessions} api={api} />
            </div>
        </div>
    )
}
