import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useOptionalSessionEntityStore } from '@/hooks/useSessionEntityStore'
import { useOptionalHappyChatStaticContext } from '@/components/AssistantChat/context'
import { resolveLiveToolRow, type TurnRow } from './turnBlockModel'

/** Row/summary consumers overlay live payloads on their layout's row identities. */
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
