import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useLayoutEffect,
    useSyncExternalStore,
    type ReactNode,
} from 'react'
import type {
    SessionEntityMetaSnapshot,
    SessionEntityStore,
    TimelineEntryRef,
    TurnEntitySnapshot,
} from '@/chat/store/sessionEntityStore'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { ChatBlock } from '@/chat/types'

const SessionEntityStoreContext = createContext<SessionEntityStore | null>(null)

const NOOP_SUBSCRIBE = () => () => {}
const UNDEFINED_SNAPSHOT = (): undefined => undefined

export function SessionEntityStoreProvider(props: {
    store: SessionEntityStore
    children: ReactNode
}) {
    useLayoutEffect(() => {
        props.store.flushNotifications()
    })
    return createElement(SessionEntityStoreContext.Provider, { value: props.store }, props.children)
}

export function useOptionalSessionEntityStore(): SessionEntityStore | null {
    return useContext(SessionEntityStoreContext)
}
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

export function useSessionTurnEntity(
    store: SessionEntityStore,
    id: string
): TurnEntitySnapshot | undefined {
    const subscribe = useCallback(
        (listener: () => void) => store.subscribeEntity(id, listener),
        [store, id]
    )
    const getSnapshot = useCallback(
        () => store.getTurnEntity(id),
        [store, id]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useOptionalSessionTurnEntity(
    id: string | null | undefined
): TurnEntitySnapshot | undefined {
    const store = useContext(SessionEntityStoreContext)
    const subscribe = useCallback(
        (listener: () => void) => {
            if (!store || !id) return () => {}
            return store.subscribeEntity(id, listener)
        },
        [store, id]
    )
    const getSnapshot = useCallback(
        () => {
            if (!store || !id) return undefined
            return store.getTurnEntity(id)
        },
        [store, id]
    )
    return useSyncExternalStore(
        store && id ? subscribe : NOOP_SUBSCRIBE,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT
    )
}

export function useOptionalSessionVisibleEntity(
    id: string | null | undefined
): VisibleChatBlock | undefined {
    const store = useContext(SessionEntityStoreContext)
    const subscribe = useCallback(
        (listener: () => void) => {
            if (!store || !id) return () => {}
            return store.subscribeEntity(id, listener)
        },
        [store, id]
    )
    const getSnapshot = useCallback(
        () => {
            if (!store || !id) return undefined
            return store.getVisibleEntity(id)
        },
        [store, id]
    )
    return useSyncExternalStore(
        store && id ? subscribe : NOOP_SUBSCRIBE,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT
    )
}

export function useOptionalSessionBlockEntity(
    id: string | null | undefined
): ChatBlock | undefined {
    const store = useContext(SessionEntityStoreContext)
    const subscribe = useCallback(
        (listener: () => void) => {
            if (!store || !id) return () => {}
            return store.subscribeEntity(id, listener)
        },
        [store, id]
    )
    const getSnapshot = useCallback(
        () => {
            if (!store || !id) return undefined
            return store.getBlockEntity(id)
        },
        [store, id]
    )
    return useSyncExternalStore(
        store && id ? subscribe : NOOP_SUBSCRIBE,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT
    )
}
