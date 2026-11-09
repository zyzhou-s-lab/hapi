import { useMemo } from 'react'
import { summarizeTurnActivity, type TurnPartition, type TurnRow } from './turnBlockModel'
import { useLiveTurnRows } from './useLiveTurnRows'
import { cn } from '@/lib/utils'

export function TurnRailSummary(props: {
    rows: readonly TurnRow[]
    partition: TurnPartition
    streaming: boolean
    activeTodoText?: string | null
    lang: 'en' | 'zh-CN'
}) {
    const rows = useLiveTurnRows(props.rows)
    const summary = useMemo(() => summarizeTurnActivity({ ...props.partition, rows: [...rows] }, {
        activeTodoText: props.activeTodoText, lang: props.lang,
    }), [rows, props.partition, props.activeTodoText, props.lang])
    return <span className={cn('truncate', props.streaming ? 'turn-text-shimmer font-medium' : 'font-normal')}>
        {props.streaming ? summary.workingHeader : summary.completedHeader}
    </span>
}
