import { lazy, Suspense, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { trainingMessageKey, useTrainingSocket, type TrainingSocketState } from '@/hooks/useTrainingSocket'
import { CardFrame, registerWorkCards, type WorkCardContext } from './WorkCardHost'
import { workbenchLayout } from './defaultLayouts'
import { bindTrainingSlot, mergeLayout } from './layout'
import type { TrainingSeries } from './trainingSeries'

const TrainingChart = lazy(() => import('./charts/TrainingChart').then((mod) => ({ default: mod.TrainingChart })))

export function TrainingCurvesBody(props: { state: TrainingSocketState }): ReactNode {
    const { t } = useTranslation()
    const statusKey = props.state.status === 'reconnecting' && !props.state.message
        ? 'work.trainingReconnecting'
        : props.state.status === 'reconnecting' || props.state.status === 'unavailable'
            ? trainingMessageKey(props.state.message)
            : null
    return (
        <>
            {statusKey ? <p className="text-sm text-red-600">{t(statusKey)}</p> : null}
            {props.state.status === 'reconnecting' && props.state.message ? <p className="text-xs text-[var(--app-hint)]">{t('work.trainingReconnecting')}</p> : null}
            {props.state.finished ? <p className="text-xs text-[var(--app-hint)]">{t('work.trainingFinished')}</p> : null}
            {props.state.series.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('work.trainingEmpty')}</p> : (
                <Suspense fallback={<p className="text-sm text-[var(--app-hint)]">{t('work.trainingEmpty')}</p>}>
                    <TrainingChart series={props.state.series} />
                </Suspense>
            )}
        </>
    )
}

export function trainingRunVisible(ctx: WorkCardContext): boolean {
    return ctx.view.kind === 'line' && ctx.view.lineId.length > 0
}

export function trainingRunBound(ctx: WorkCardContext): boolean {
    const run = ctx.slot.args?.run ?? ''
    const lineId = ctx.slot.args?.lineId ?? ''
    return run.length > 0 && ctx.view.kind === 'line' && ctx.view.lineId === lineId
}

function TrainingCurvesCard(props: { ctx: WorkCardContext }): ReactNode {
    const { api, token, baseUrl } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const bound = trainingRunBound(props.ctx)
    const run = bound ? props.ctx.slot.args?.run ?? '' : ''
    const state = useTrainingSocket({ baseUrl, token, run })
    const runs = useQuery({
        queryKey: ['work', 'training-runs'],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return api.listTrainingRuns()
        },
        enabled: Boolean(api),
    })
    const [selected, setSelected] = useState(props.ctx.slot.args?.run ?? '')
    const lineId = props.ctx.view.kind === 'line' ? props.ctx.view.lineId : ''
    const save = async () => {
        if (!api || !selected || !lineId) return
        const saved = await api.getWorkLayout('workbench')
        const base = mergeLayout(saved.source === 'saved' ? saved.layout : null, workbenchLayout)
        await api.putWorkLayout('workbench', bindTrainingSlot(base, lineId, selected))
        await queryClient.invalidateQueries({ queryKey: ['work', 'layout', 'workbench'] })
    }
    return (
        <CardFrame title={t('work.trainingCurves')}>
            <form className="mb-3 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save() }}>
                <label className="text-xs text-[var(--app-hint)]">
                    {t('work.trainingPickRun')}
                    <select className="ml-2 rounded border border-[var(--app-divider)] bg-transparent px-2 py-1 text-sm text-[var(--app-fg)]" value={selected} onChange={(event) => setSelected(event.target.value)}>
                        <option value="">{t('work.trainingPickRun')}</option>
                        {(runs.data?.runs ?? []).map((item) => <option key={item.run} value={item.run}>{item.run}</option>)}
                    </select>
                </label>
                <button type="submit" className="text-sm text-[var(--app-link)]" disabled={!selected}>{t('work.trainingUseRun')}</button>
            </form>
            {bound ? <TrainingCurvesBody state={state} /> : null}
        </CardFrame>
    )
}

registerWorkCards([{
    id: 'example.training-curves',
    titleKey: 'work.trainingCurves',
    size: 'main',
    source: { kind: 'training' },
    visible: trainingRunVisible,
    Component: ({ ctx }) => <TrainingCurvesCard ctx={ctx} />,
}])

export type { TrainingSeries }
