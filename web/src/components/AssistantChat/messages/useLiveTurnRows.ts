import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useOptionalSessionEntityStore } from '@/hooks/useSessionEntityStore'
import { useOptionalHappyChatStaticContext } from '@/components/AssistantChat/context'
import {
    deriveTurnRowsTitle,
    resolveLiveToolRow,
    summarizeTurnActivity,
    type TurnDisplayStepRow,
    type TurnActionCounts,
    type TurnPartition,
    type TurnRow,
} from './turnBlockModel'
import { projectSubagentActivities } from './subagentActivity'

function stepTools(row: TurnDisplayStepRow) {
    if (row.kind === 'activity' || row.kind === 'coalesced') return row.toolRows
    if (row.kind === 'subagent') return row.activity.tools
    return row.kind === 'tool' ? [row] : []
}

export function useLiveTurnRows(rows: readonly TurnRow[]): readonly TurnRow[] {
    const store = useOptionalSessionEntityStore()
    const metadata = useOptionalHappyChatStaticContext()?.metadata ?? null
    const subscribe = useCallback((listener: () => void) => {
        if (!store) return () => {}
        const ids = new Set(rows.flatMap((row) => row.kind === 'tool' ? [row.block.id] : row.kind === 'text' || row.kind === 'reasoning' ? row.blockId ? [row.blockId] : [] : [row.block.id]))
        const unsubscribe = [...ids].map((id) => store.subscribeEntity(id, listener))
        return () => { for (const dispose of unsubscribe) dispose() }
    }, [store, rows])
    const getSnapshot = useMemo(() => {
        let previous = rows
        return () => {
            if (!store) return rows
            let changed = false
            const next = rows.map((row, index): TurnRow => {
                const old = previous[index] ?? row
                if (row.kind === 'tool') {
                    const block = store.getBlockEntity(row.block.id)
                    const live = block?.kind === 'tool-call' ? resolveLiveToolRow(row, block, metadata) : row
                    if (old.kind === 'tool' && old.block === live.block) return old
                    changed = true
                    return live
                }
                if (row.kind === 'reasoning' || row.kind === 'text') {
                    const entity = row.blockId ? store.getVisibleEntity(row.blockId) : undefined
                    const text = entity && 'text' in entity ? entity.text.trim() : row.text
                    if ((old.kind === 'text' || old.kind === 'reasoning') && old.text === text) return old
                    changed = true
                    return { ...row, text }
                }
                return old
            })
            if (changed) previous = next
            return previous
        }
    }, [store, rows, metadata])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useLiveTurnStepRows(stepRows: readonly TurnDisplayStepRow[]): readonly TurnDisplayStepRow[] {
    const store = useOptionalSessionEntityStore()
    const metadata = useOptionalHappyChatStaticContext()?.metadata ?? null
    const subscribe = useCallback((listener: () => void) => {
        if (!store) return () => {}
        const ids = new Set<string>()
        for (const row of stepRows) {
            for (const tool of stepTools(row)) ids.add(tool.block.id)
        }
        if (ids.size === 0) return () => {}
        const unsubscribe = [...ids].map((id) => store.subscribeEntity(id, listener))
        return () => {
            for (const dispose of unsubscribe) dispose()
        }
    }, [store, stepRows])
    const getSnapshot = useMemo(() => {
        let previous = stepRows
        return () => {
            if (!store) return stepRows
            let changed = false
            const next = stepRows.map((row, index): TurnDisplayStepRow => {
                const old = previous[index] ?? row
                if (row.kind === 'activity' || row.kind === 'subagent') {
                    const original = stepTools(row)
                    const oldTools = stepTools(old)
                    const liveTools = original.map((toolRow, toolIndex) => {
                        const block = store.getBlockEntity(toolRow.block.id)
                        const live = block?.kind === 'tool-call' ? resolveLiveToolRow(toolRow, block, metadata) : toolRow
                        return oldTools[toolIndex]?.block === live.block ? oldTools[toolIndex]! : live
                    })
                    if (liveTools.every((tool, toolIndex) => tool === oldTools[toolIndex])) return old
                    changed = true
                    if (row.kind === 'activity') return { ...row, toolRows: liveTools }
                    const projected = projectSubagentActivities(liveTools)
                    const activity = [...projected.activityByAnchorKey.values()].flat().find((task) => task.taskId === row.activity.taskId)
                    return activity ? { ...row, activity } : { ...row, activity: { ...row.activity, tools: liveTools } }
                }
                if (row.kind === 'tool') {
                    const block = store.getBlockEntity(row.block.id)
                    const live = block?.kind === 'tool-call' ? resolveLiveToolRow(row, block, metadata) : row
                    if (old.kind === 'tool' && old.block === live.block && old.error === live.error && old.permission === live.permission) {
                        return old
                    }
                    changed = true
                    return live
                }
                return old
            })
            if (changed) previous = next
            return previous
        }
    }, [store, stepRows, metadata])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useLiveTurnSummary(
    rows: readonly TurnRow[],
    partition: TurnPartition,
    options: {
        activeTodoText?: string | null
        lang: 'en' | 'zh-CN'
    }
): {
    workingHeader: string
    completedHeader: string
    counts: TurnActionCounts
} {
    const store = useOptionalSessionEntityStore()
    const metadata = useOptionalHappyChatStaticContext()?.metadata ?? null
    const activeTodoText = options.activeTodoText
    const lang = options.lang
    const subscribe = useCallback((listener: () => void) => {
        if (!store) return () => {}
        const lastStepRow = [...rows].reverse().find((row) => !(row.kind === 'text' && row.trailing))
        const ids = new Set<string>()
        for (const row of rows) {
            if (row.kind === 'tool') {
                ids.add(row.block.id)
            }
        }
        if (lastStepRow?.kind === 'reasoning' && lastStepRow.blockId) {
            ids.add(lastStepRow.blockId)
        }
        const unsubscribe = [...ids].map((id) => store.subscribeEntity(id, listener))
        return () => {
            for (const dispose of unsubscribe) dispose()
        }
    }, [store, rows])
    const getSnapshot = useMemo(() => {
        let previous: {
            workingHeader: string
            completedHeader: string
            counts: TurnActionCounts
        } | null = null
        return () => {
            const liveRows = !store
                ? rows
                : rows.map((row): TurnRow => {
                    if (row.kind === 'tool') {
                        const block = store.getBlockEntity(row.block.id)
                        return block?.kind === 'tool-call' ? resolveLiveToolRow(row, block, metadata) : row
                    }
                    if (row.kind === 'reasoning' && row.blockId) {
                        const entity = store.getVisibleEntity(row.blockId)
                        const text = entity && 'text' in entity ? entity.text.trim() : row.text
                        return text === row.text ? row : { ...row, text }
                    }
                    return row
                })
            const hasExplicitPartitionTitle = Boolean(
                partition.title && partition.title !== deriveTurnRowsTitle(rows)
            )
            const liveTitle = hasExplicitPartitionTitle
                ? partition.title
                : deriveTurnRowsTitle(liveRows)
            const next = summarizeTurnActivity(
                { ...partition, rows: [...liveRows], title: liveTitle },
                { activeTodoText, lang }
            )
            if (
                previous
                && previous.workingHeader === next.workingHeader
                && previous.completedHeader === next.completedHeader
            ) {
                return previous
            }
            previous = next
            return next
        }
    }, [store, rows, partition, metadata, activeTodoText, lang])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
