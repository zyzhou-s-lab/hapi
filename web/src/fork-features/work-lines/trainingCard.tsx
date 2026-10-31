import { lazy, Suspense, type ReactNode } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { trainingMessageKey, useTrainingSocket, type TrainingSocketState } from '@/hooks/useTrainingSocket'
import { CardFrame, registerWorkCards, type WorkCardContext } from './WorkCardHost'
import { filterTrainingSeries, trainingMetricsFromArgs, type TrainingSeries } from './trainingSeries'

const TrainingChart = lazy(() => import('./charts/TrainingChart').then((mod) => ({ default: mod.TrainingChart })))

export function TrainingCurvesBody(props: { state: TrainingSocketState, xSource?: TrainingSeries[], run?: string }): ReactNode {
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
                    <TrainingChart series={props.state.series} xSource={props.xSource} run={props.run} />
                </Suspense>
            )}
        </>
    )
}

export function trainingRunVisible(ctx: WorkCardContext): boolean {
    if (ctx.view.kind !== 'line' || ctx.view.lineId.length === 0) return false
    return ctx.slot.args?.lineId === ctx.view.lineId
}

export function trainingRunBound(ctx: WorkCardContext): boolean {
    const run = ctx.slot.args?.run ?? ''
    const lineId = ctx.slot.args?.lineId ?? ''
    return run.length > 0 && ctx.view.kind === 'line' && ctx.view.lineId === lineId
}

function TrainingCurvesCard(props: { ctx: WorkCardContext }): ReactNode {
    const { token, baseUrl } = useAppContext()
    const { t } = useTranslation()
    const bound = trainingRunBound(props.ctx)
    const run = bound ? props.ctx.slot.args?.run ?? '' : ''
    const metrics = trainingMetricsFromArgs(props.ctx.slot.args)
    const state = useTrainingSocket({ baseUrl, token, run })
    const shown = {
        ...state,
        series: filterTrainingSeries(state.series, metrics).filter((row) => !row.id.startsWith('_')).map((row) => ({ ...row, name: `${run} · ${row.name}` })),
    }
    return (
        <CardFrame title={t('work.trainingCurves')}>
            {bound ? <TrainingCurvesBody state={shown} xSource={state.series} run={run} /> : <p className="text-sm text-[var(--app-hint)]">{t('work.trainingUnbound')}</p>}
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
