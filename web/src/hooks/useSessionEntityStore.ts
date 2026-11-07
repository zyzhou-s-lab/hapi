import { useCallback, useSyncExternalStore } from 'react'
import type {
    SessionEntityMetaSnapshot,
    SessionEntityStore,
    TimelineEntryRef,
} from '@/chat/store/sessionEntityStore'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { ChatBlock } from '@/chat/types'

export function useSessionTimelineIndex(store: SessionEntityStore): readonly TimelineEntryRef[] {
    return useSyncExternalStore(store.subscribeTimeline, store.getTimelineIndex, store.getTimelineIndex)
}

export function useSessionEntityMeta(store: SessionEntityStore): SessionEntityMetaSnapshot {
    return useSyncExternalStore(store.subscribeMeta, store.getMeta, store.getMeta)
}

export function useSessionVisibleEntity(
    store: SessionEntityStore,
    id: string
): VisibleChatBlock | undefined {
    const subscribe = useCallback(
        (listener: () => void) => store.subscribeEntity(id, listener),
        [store, id]
    )
    const getSnapshot = useCallback(
        () => store.getVisibleEntity(id),
        [store, id]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionBlockEntity(
    store: SessionEntityStore,
    id: string
): ChatBlock | undefined {
    const subscribe = useCallback(
        (listener: () => void) => store.subscribeEntity(id, listener),
        [store, id]
    )
    const getSnapshot = useCallback(
        () => store.getBlockEntity(id),
        [store, id]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
