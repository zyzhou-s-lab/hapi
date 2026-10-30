import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { getSessionListSelectionNavigation } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import { CardFrame, registerWorkCards, type WorkCardContext, type WorkCardDefinition } from './WorkCardHost'
import { workCardMapPrefix } from './useWorkMap'

function Stat(props: { label: string; value: number; detail?: string }): ReactNode {
    return (
        <CardFrame title={props.label}>
            <p className="text-2xl font-semibold text-[var(--app-fg)]">{props.value}</p>
            {props.detail ? <p className="mt-1 text-xs text-[var(--app-hint)]">{props.detail}</p> : null}
        </CardFrame>
    )
}

function modelOf(ctx: WorkCardContext) {
    return ctx.model
}

function statCard(id: string, titleKey: string, value: (ctx: WorkCardContext) => number, detail?: (ctx: WorkCardContext, t: (key: string, params?: Record<string, string | number>) => string) => string): WorkCardDefinition {
    return {
        id,
        titleKey,
        size: 'stat',
        source: { kind: 'work-model' },
        Component: ({ ctx }) => {
            const { t } = useTranslation()
            return <Stat label={t(titleKey)} value={value(ctx)} detail={detail?.(ctx, t)} />
        },
    }
}

function NeedsYouList(props: { ctx: WorkCardContext }): ReactNode {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const dismiss = useMutation({
        mutationFn: async (sessionId: string) => {
            if (!api) throw new Error('API unavailable')
            await api.putWorkDismissed(sessionId, true)
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: workCardMapPrefix })
        },
    })
    const rows = props.ctx.model?.needsYou ?? []
    return (
        <CardFrame title={t('work.needsYouList')}>
            {rows.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('work.needsYouEmpty')}</p> : (
                <ul className="divide-y divide-[var(--app-divider)]">
                    {rows.map((row) => (
                        <li key={row.id} className="flex items-center gap-3 py-2">
                            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(getSessionListSelectionNavigation(row.id))}>
                                <span className="block truncate text-sm text-[var(--app-fg)]">{row.title}</span>
                                <span className="block truncate text-xs text-[var(--app-hint)]">
                                    {row.machineLabel} · {row.directory || t('work.noDirectory')} · {t('work.pendingCount', { count: row.pendingRequestsCount })}
                                </span>
                            </button>
                            <button type="button" className="text-xs text-[var(--app-hint)]" onClick={() => dismiss.mutate(row.id)}>
                                {t('work.ignore')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </CardFrame>
    )
}

registerWorkCards([
    statCard('overview.line-count', 'work.lineCount', (ctx) => modelOf(ctx)?.lineCount ?? 0, (ctx, t) => t('work.lineCountDetail', {
        directories: modelOf(ctx)?.directoryCount ?? 0,
        machines: modelOf(ctx)?.machineCount ?? 0,
    })),
    statCard('overview.needs-you-count', 'work.needsYouCount', (ctx) => modelOf(ctx)?.needsYouCount ?? 0),
    statCard('overview.running-count', 'work.runningCount', (ctx) => modelOf(ctx)?.runningCount ?? 0),
    statCard('overview.inbox-count', 'work.inboxCount', (ctx) => modelOf(ctx)?.inboxCount ?? 0),
    {
        id: 'overview.needs-you-list',
        titleKey: 'work.needsYouList',
        size: 'full',
        source: { kind: 'work-model' },
        Component: ({ ctx }) => <NeedsYouList ctx={ctx} />,
    },
])
