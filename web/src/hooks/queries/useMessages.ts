import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    activateMessageWindow,
    cancelOlderMessageLoad,
    captureMessageWindowScope,
    getMessageWindowScopeVersion,
    fetchOlderMessages,
    getMessageWindowState,
    setMessageViewMode,
    subscribeMessageWindow,
    syncTailMessages,
    type MessageViewMode,
    type MessageWindowState,
    type OlderLoadOutcome,
} from '@/lib/message-window-store'

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    hasMore: false,
    oldestSeq: null,
    newestSeq: null,
    epoch: null,
    isSyncingTail: false,
    isLoadingMore: false,
    warning: null,
    viewMode: 'tail',
    messagesVersion: 0,
    historyVersion: 0,
    tailRevision: 0,
}

export type MessageWindowControlsState = {
    sessionId: string
    hasMessages: boolean
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    viewMode: MessageViewMode
    historyVersion: number
}

export type MessageWindowControls = {
    hasMessages: boolean
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    viewMode: MessageViewMode
    historyVersion: number
    loadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    cancelLoadMore: () => void
    refetch: () => Promise<void>
    setViewMode: (mode: MessageViewMode) => void
}

export const EMPTY_CONTROLS_STATE: MessageWindowControlsState = {
    sessionId: 'unknown',
    hasMessages: false,
    warning: null,
    isSyncingTail: false,
    isLoadingMore: false,
    hasMore: false,
    viewMode: 'tail',
    historyVersion: 0,
}

export function selectMessageWindowControlsState(state: MessageWindowState): MessageWindowControlsState {
    return {
        sessionId: state.sessionId,
        hasMessages: state.messages.length > 0,
        warning: state.warning,
        isSyncingTail: state.isSyncingTail,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        viewMode: state.viewMode,
        historyVersion: state.historyVersion,
    }
}

export function areMessageWindowControlsStatesEqual(
    a: MessageWindowControlsState | null | undefined,
    b: MessageWindowControlsState | null | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.sessionId === b.sessionId
        && a.hasMessages === b.hasMessages
        && a.warning === b.warning
        && a.isSyncingTail === b.isSyncingTail
        && a.isLoadingMore === b.isLoadingMore
        && a.hasMore === b.hasMore
        && a.viewMode === b.viewMode
        && a.historyVersion === b.historyVersion
}

function useMessageWindowLifecycleAndActions(api: ApiClient | null, sessionId: string | null) {
    const version = getMessageWindowScopeVersion()
    const isScopeCurrent = useMemo(captureMessageWindowScope, [version])
    useLayoutEffect(() => {
        if (api && sessionId && isScopeCurrent()) {
            activateMessageWindow(sessionId)
        }
    }, [api, sessionId, isScopeCurrent])

    useEffect(() => {
        if (api && sessionId && isScopeCurrent()) {
            void syncTailMessages(api, sessionId)
        }
    }, [api, sessionId, isScopeCurrent])

    const loadMore = useCallback(async (onBeforeApply?: (historyVersion: number) => boolean) => {
        if (!isScopeCurrent()) return { kind: 'stopped', reason: 'invalidated' } as const
        if (!api || !sessionId) {
            return { kind: 'stopped', reason: 'unavailable' } as const
        }
        return await fetchOlderMessages(api, sessionId, { onBeforeApply })
    }, [api, sessionId, isScopeCurrent])

    const cancelLoadMore = useCallback(() => {
        if (api && sessionId && isScopeCurrent()) {
            cancelOlderMessageLoad(sessionId)
        }
    }, [api, sessionId, isScopeCurrent])

    const refetch = useCallback(async () => {
        if (!api || !sessionId || !isScopeCurrent()) return
        await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    }, [api, sessionId, isScopeCurrent])

    const setViewMode = useCallback((mode: MessageViewMode) => {
        if (!api || !sessionId || !isScopeCurrent()) return
        const previousMode = getMessageWindowState(sessionId).viewMode
        setMessageViewMode(sessionId, mode)
        if (mode === 'tail' && previousMode !== 'tail' && api) {
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
    }, [api, sessionId, isScopeCurrent])

    return {
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode,
    }
}

export function useMessages(api: ApiClient | null, sessionId: string | null): {
    messages: DecryptedMessage[]
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    tailRevision: number
    loadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    cancelLoadMore: () => void
    refetch: () => Promise<void>
    setViewMode: (mode: MessageViewMode) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) return () => {}
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => api && sessionId ? getMessageWindowState(sessionId) : EMPTY_STATE, [api, sessionId]),
        () => EMPTY_STATE
    )

    const { loadMore, cancelLoadMore, refetch, setViewMode } = useMessageWindowLifecycleAndActions(api, sessionId)

    return {
        messages: state.messages,
        warning: state.warning,
        isSyncingTail: state.isSyncingTail,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        viewMode: state.viewMode,
        messagesVersion: state.messagesVersion,
        historyVersion: state.historyVersion,
        tailRevision: state.tailRevision,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode,
    }
}

export function useMessageWindowControls(
    api: ApiClient | null,
    sessionId: string | null
): MessageWindowControls {
    const snapshotRef = useRef<MessageWindowControlsState | null>(null)
    const getSnapshot = useCallback((): MessageWindowControlsState => {
        if (!api || !sessionId) {
            return EMPTY_CONTROLS_STATE
        }
        const next = selectMessageWindowControlsState(getMessageWindowState(sessionId))
        if (areMessageWindowControlsStatesEqual(snapshotRef.current, next) && snapshotRef.current) {
            return snapshotRef.current
        }
        snapshotRef.current = next
        return next
    }, [api, sessionId])

    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) return () => {}
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        getSnapshot,
        () => EMPTY_CONTROLS_STATE
    )

    const { loadMore, cancelLoadMore, refetch, setViewMode } = useMessageWindowLifecycleAndActions(api, sessionId)

    return {
        hasMessages: state.hasMessages,
        warning: state.warning,
        isSyncingTail: state.isSyncingTail,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        viewMode: state.viewMode,
        historyVersion: state.historyVersion,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode,
    }
}
