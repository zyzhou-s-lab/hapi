import { lazy, Suspense, type ReactNode } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useTrainingSocket, type TrainingSocketState } from '@/hooks/useTrainingSocket'
import { CardFrame, registerWorkCards, type WorkCardContext } from './WorkCardHost'
import type { TrainingSeries } from './trainingSeries'

const TrainingChart = lazy(() => import('./charts/TrainingChart').then((mod) => ({ default: mod.TrainingChart })))

export function TrainingCurvesBody(props: { state: TrainingSocketState }): ReactNode {
    const { t } = useTranslation()
    return (
        <CardFrame title={t('work.trainingCurves')}>
            {props.state.status === 'unavailable' ? <p className="text-sm text-red-600">{props.state.message || t('work.trainingUnavailable')}</p> : null}
            {props.state.finished ? <p className="text-xs text-[var(--app-hint)]">{t('work.trainingFinished')}</p> : null}
            {props.state.series.length === 0 ? <p className="text-sm text-[var(--app-hint)]">{t('work.trainingEmpty')}</p> : (
                <Suspense fallback={<p className="text-sm text-[var(--app-hint)]">{t('work.trainingEmpty')}</p>}>
                    <TrainingChart series={props.state.series} />
                </Suspense>
            )}
        </CardFrame>
    )
}

function TrainingCurvesCard(props: { ctx: WorkCardContext }): ReactNode {
    const { token, baseUrl } = useAppContext()
    const run = props.ctx.slot.args?.run ?? ''
    const state = useTrainingSocket({ baseUrl, token, run })
    return <TrainingCurvesBody state={state} />
}

export function trainingRunVisible(ctx: WorkCardContext): boolean {
    const run = ctx.slot.args?.run ?? ''
    const lineId = ctx.slot.args?.lineId ?? ''
    return run.length > 0 && lineId.length > 0 && ctx.view.kind === 'line' && ctx.view.lineId === lineId
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
