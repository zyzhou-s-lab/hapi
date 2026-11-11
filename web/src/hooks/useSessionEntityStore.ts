import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from 'react'
import type {
    SessionEntityMetaSnapshot,
    SessionEntityStore,
    SessionEntityStoreSnapshot,
    TurnHeaderSnapshot,
    TurnLayoutSnapshot,
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

/** Subscribe to the selected domain value without exposing whole snapshots to a surface. */
export function useSessionEntitySelector<T>(
    store: SessionEntityStore,
    selector: (snapshot: SessionEntityStoreSnapshot) => T,
    isEqual: (a: T, b: T) => boolean = Object.is
): T {
    const getSnapshot = useMemo(() => {
        let current: { snapshot: SessionEntityStoreSnapshot; value: T } | undefined
        return () => {
            const snapshot = store.getSnapshot()
            if (current?.snapshot === snapshot) return current.value
            const selected = selector(snapshot)
            const value = current && isEqual(current.value, selected) ? current.value : selected
            current = { snapshot, value }
            return value
        }
    }, [store, selector, isEqual])
    return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useSessionTimelineSelector<T>(
    store: SessionEntityStore,
    selector: (snapshot: SessionEntityStoreSnapshot) => T,
    isEqual: (a: T, b: T) => boolean = Object.is
): T {
    const getSnapshot = useMemo(() => {
        let current: { snapshot: SessionEntityStoreSnapshot; value: T } | undefined
        return () => {
            const snapshot = store.getSnapshot()
            if (current?.snapshot === snapshot) return current.value
            const selected = selector(snapshot)
            const value = current && isEqual(current.value, selected) ? current.value : selected
            current = { snapshot, value }
            return value
        }
    }, [store, selector, isEqual])
    return useSyncExternalStore(store.subscribeTimeline, getSnapshot, getSnapshot)
}

export function useSessionMetaSelector<T>(
    store: SessionEntityStore,
    selector: (meta: SessionEntityMetaSnapshot) => T,
    isEqual: (a: T, b: T) => boolean = Object.is
): T {
    const getSnapshot = useMemo(() => {
        let current: { meta: SessionEntityMetaSnapshot; value: T } | undefined
        return () => {
            const meta = store.getMeta()
            if (current?.meta === meta) return current.value
            const selected = selector(meta)
            const value = current && isEqual(current.value, selected) ? current.value : selected
            current = { meta, value }
            return value
        }
    }, [store, selector, isEqual])
    return useSyncExternalStore(store.subscribeMeta, getSnapshot, getSnapshot)
}

export function useOptionalSessionTurnLayout(id: string | null | undefined): TurnLayoutSnapshot | undefined {
    const store = useContext(SessionEntityStoreContext)
    const subscribe = useCallback((listener: () => void) => (
        store && id ? store.subscribeEntity(`layout:${id}`, listener) : () => {}
    ), [store, id])
    const getSnapshot = useCallback(() => store && id ? store.getTurnLayout(id) : undefined, [store, id])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
export function useSessionTurnHeader(
    store: SessionEntityStore,
    id: string
): TurnHeaderSnapshot | undefined {
    const subscribe = useCallback(
        (listener: () => void) => store.subscribeEntity(`header:${id}`, listener),
        [store, id]
    )
    const getSnapshot = useCallback(
        () => store.getTurnHeader(id),
        [store, id]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useOptionalSessionTurnHeader(
    id: string | null | undefined
): TurnHeaderSnapshot | undefined {
    const store = useContext(SessionEntityStoreContext)
    const subscribe = useCallback(
        (listener: () => void) => (
            store && id ? store.subscribeEntity(`header:${id}`, listener) : () => {}
        ),
        [store, id]
    )
    const getSnapshot = useCallback(
        () => (store && id ? store.getTurnHeader(id) : undefined),
        [store, id]
    )
    return useSyncExternalStore(
        store && id ? subscribe : NOOP_SUBSCRIBE,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT,
        store && id ? getSnapshot : UNDEFINED_SNAPSHOT
    )
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
