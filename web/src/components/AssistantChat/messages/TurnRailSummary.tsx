import type { TurnPartition, TurnRow } from './turnBlockModel'
import { useLiveTurnSummary } from './useLiveTurnRows'
import { cn } from '@/lib/utils'

export function TurnRailSummary(props: {
    rows: readonly TurnRow[]
    partition: TurnPartition
    streaming: boolean
    activeTodoText?: string | null
    lang: 'en' | 'zh-CN'
}) {
    const summary = useLiveTurnSummary(props.rows, props.partition, {
        activeTodoText: props.activeTodoText,
        lang: props.lang,
    })
    return <span className={cn('truncate', props.streaming ? 'turn-text-shimmer font-medium' : 'font-normal')}>
        {props.streaming ? summary.workingHeader : summary.completedHeader}
    </span>
}
