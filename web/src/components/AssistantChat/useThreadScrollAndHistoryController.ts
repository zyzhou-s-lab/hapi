import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { OlderHistoryLoadResult } from '@/components/AssistantChat/context'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import {
    ANCHOR_PIN_MAX_MS,
    captureScrollAnchor,
    COVERAGE_FAILURE_RETRY_DELAY_MS,
    getHistoryCoverageRetryDelay,
    getVisibleTurnBoundaryId,
    INITIAL_SCROLL_SETTLE_DELAYS_MS,
    INITIAL_SCROLL_SETTLE_MS,
    isTopTurnHeadlessAssistant,
    loadUntilVisibleBoundaryChanges,
    locateOutlineTargetMessage,
    MAX_COVERAGE_LOAD_RETRIES,
    MESSAGE_ANCHOR_SELECTOR,
    nextPinnedAnchorUntil,
    restoreScrollAnchor,
    shouldLoadOlderForViewport,
    WHEEL_GESTURE_GAP_MS,
    type HistoryLoaderState,
    type HistoryLoadSource,
    type PendingScrollRestore,
    type PullToLoadState,
    type ScrollAnchor,
} from '@/components/AssistantChat/threadScrollHelpers'
import { useThreadViewportEvents } from '@/components/AssistantChat/useThreadViewportEvents'

export function useThreadScrollAndHistoryController(props: {
    sessionId: string
    isLoadingMoreMessages: boolean
    hasMoreMessages: boolean
    isSyncingTail: boolean
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    onViewModeChange: (mode: 'tail' | 'history') => void
    forceScrollToken: number
    rawMessagesCount: number
    messagesVersion: number
    appliedMessagesVersion: number
    appliedHistoryVersion: number
    isAwaitingMessagesRender: boolean
    isAwaitingHistoryRender: boolean
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    bottomInsetPx?: number
}) {
    const {
        appliedMessagesVersion,
        appliedHistoryVersion,
        isAwaitingMessagesRender,
        isAwaitingHistoryRender,
    } = props
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [pullToLoadState, setPullToLoadState] = useState<PullToLoadState>('idle')
    const pullToLoadStateRef = useRef<PullToLoadState>('idle')
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const wheelGestureUntilRef = useRef(0)
    const pinnedAnchorRef = useRef<ScrollAnchor | null>(null)
    const pinnedAnchorUntilRef = useRef(0)
    const pinnedAnchorStartedAtRef = useRef(0)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isSyncingTailRef = useRef(props.isSyncingTail)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onCancelLoadMoreRef = useRef(props.onCancelLoadMore)
    const pendingLoadPromiseRef = useRef<Promise<OlderHistoryLoadResult> | null>(null)
    const pendingLoadResolveRef = useRef<((value: OlderHistoryLoadResult) => void) | null>(null)
    const coverageCheckTimerRef = useRef<number | null>(null)
    const failureRetryTimerRef = useRef<number | null>(null)
    const tailScrollInProgressRef = useRef(false)
    const historyLoaderRef = useRef<HistoryLoaderState>({
        runId: 0,
        phase: 'idle',
        source: null,
        failureCount: 0,
        autoPaused: false
    })

    useLayoutEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const updateScrollbarGutter = () => {
            const supportsStableBothEdges = typeof CSS !== 'undefined'
                && typeof CSS.supports === 'function'
                && CSS.supports('scrollbar-gutter: stable both-edges')
            const gutter = supportsStableBothEdges
                ? Math.max(0, (viewport.offsetWidth - viewport.clientWidth) / 2)
                : 0
            viewport.style.setProperty('--chat-scroll-gutter-inline', `${gutter}px`)
            // Keyboard and safe-area changes shrink the viewport without a
            // content mutation. Stay pinned when the user was already at the tail.
            if (
                autoScrollEnabledRef.current
                && atBottomRef.current
                && !pendingScrollRef.current
            ) {
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                lastScrollTopRef.current = viewport.scrollTop
            }
        }

        updateScrollbarGutter()
        if (typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(updateScrollbarGutter)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [])
    const requestOlderRef = useRef<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>(
        () => Promise.resolve('transient-stop')
    )
    const loadOlderFromUserGestureRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false))
    const startHistoryLoadAttemptRef = useRef<(runId: number) => void>(() => {})
    const needsViewportCoverageRef = useRef<() => boolean>(() => false)
    const atBottomRef = useRef(true)
    const onViewModeChangeRef = useRef(props.onViewModeChange)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const initialScrollSessionRef = useRef<string | null>(null)
    const initialScrollDeadlineRef = useRef(0)
    const initialScrollTimersRef = useRef<number[]>([])

    // Smart scroll state: enabled only while the user is intentionally at the bottom.
    const autoScrollEnabledRef = useRef(true)
    useLayoutEffect(() => {
        onViewModeChangeRef.current = props.onViewModeChange
        hasMoreMessagesRef.current = props.hasMoreMessages
        isSyncingTailRef.current = props.isSyncingTail
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        onLoadMoreRef.current = props.onLoadMore
    }, [
        props.hasMoreMessages,
        props.isLoadingMoreMessages,
        props.isSyncingTail,
        props.onLoadMore,
        props.onViewModeChange
    ])
    useEffect(() => {
        onCancelLoadMoreRef.current = props.onCancelLoadMore
    }, [props.onCancelLoadMore])

    useEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    const isInitialScrollSettling = useCallback(() => {
        return initialScrollSessionRef.current === sessionIdRef.current && Date.now() < initialScrollDeadlineRef.current
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        initialScrollTimersRef.current = []
    }, [])

    const clearCoverageCheckTimer = useCallback(() => {
        if (coverageCheckTimerRef.current !== null) {
            window.clearTimeout(coverageCheckTimerRef.current)
            coverageCheckTimerRef.current = null
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        if (failureRetryTimerRef.current !== null) {
            window.clearTimeout(failureRetryTimerRef.current)
            failureRetryTimerRef.current = null
        }
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        const resolve = pendingLoadResolveRef.current
        pendingScrollRef.current = null
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        resolve?.(result)
    }, [])

    const cancelActiveHistoryLoad = useCallback(() => {
        const state = historyLoaderRef.current
        // `awaiting-render` is pre-armed by onBeforeApply and published with an
        // immediate store notification, so browser input cannot observe the
        // old DOM after trimming. Only network/backoff work is cancellable.
        if (
            state.source === 'consumer'
            || (state.phase !== 'loading' && state.phase !== 'backoff')
        ) {
            return
        }
        onCancelLoadMoreRef.current()
        isLoadingMoreRef.current = false
        pendingScrollRef.current = null
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = {
            ...state,
            runId: state.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: true
        }
        settlePendingLoad('transient-stop')
    }, [clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    useThreadViewportEvents({
        viewportRef,
        lastScrollTopRef,
        autoScrollEnabledRef,
        atBottomRef,
        onViewModeChangeRef,
        loadOlderFromUserGestureRef,
        pendingScrollRef,
        pinnedAnchorUntilRef,
        pinnedAnchorRef,
        pinnedAnchorStartedAtRef,
        historyLoaderRef,
        needsViewportCoverageRef,
        isInitialScrollSettling,
        initialScrollDeadlineRef,
        clearInitialScrollTimers,
        requestOlderRef,
        tailScrollInProgressRef,
        cancelActiveHistoryLoad,
        pullToLoadStateRef,
        setPullToLoadState,
        wheelGestureUntilRef,
        pendingLoadPromiseRef,
        hasMoreMessagesRef,
        isSyncingTailRef,
        isLoadingMoreRef,
    })

    const scrollToBottomInstant = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
            for (let pass = 0; pass < 2; pass += 1) {
                const targetTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                if (targetTop - viewport.scrollTop <= 1) {
                    break
                }
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
            }
            lastScrollTopRef.current = viewport.scrollTop
        }
    }, [])

    const handleNestedScrollFollowChange = useCallback((followLatest: boolean) => {
        if (!followLatest) {
            clearInitialScrollTimers()
        }
        autoScrollEnabledRef.current = followLatest && atBottomRef.current
    }, [clearInitialScrollTimers])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            tailScrollInProgressRef.current = true
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
            lastScrollTopRef.current = viewport.scrollTop
        }
        autoScrollEnabledRef.current = true
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onViewModeChangeRef.current('tail')
        }
    }, [])

    // Reset state when session changes
    useLayoutEffect(() => {
        autoScrollEnabledRef.current = true
        tailScrollInProgressRef.current = false
        lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        forceScrollTokenRef.current = props.forceScrollToken
        pendingScrollRef.current = null
        pullToLoadStateRef.current = 'idle'
        setPullToLoadState('idle')
        historyLoaderRef.current = {
            runId: historyLoaderRef.current.runId + 1,
            phase: 'idle',
            source: null,
            failureCount: 0,
            autoPaused: false
        }
        initialScrollSessionRef.current = null
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        settlePendingLoad('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        settlePendingLoad
    ])

    useLayoutEffect(() => {
        if (
            initialScrollSessionRef.current === props.sessionId
            || props.rawMessagesCount === 0
            || isAwaitingMessagesRender
            || pendingScrollRef.current
        ) {
            return
        }

        initialScrollSessionRef.current = props.sessionId
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        onViewModeChangeRef.current('tail')
        scrollToBottomInstant()

        initialScrollDeadlineRef.current = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialScrollTimersRef.current = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialScrollSessionRef.current !== props.sessionId
                || !autoScrollEnabledRef.current
                || pendingScrollRef.current
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.rawMessagesCount,
        props.messagesVersion,
        appliedMessagesVersion,
        isAwaitingMessagesRender,
        scrollToBottomInstant,
        clearInitialScrollTimers
    ])

    useEffect(() => {
        return () => {
            historyLoaderRef.current.runId += 1
            clearInitialScrollTimers()
            clearCoverageCheckTimer()
            clearFailureRetryTimer()
            settlePendingLoad('transient-stop')
        }
    }, [clearInitialScrollTimers, clearCoverageCheckTimer, clearFailureRetryTimer, settlePendingLoad])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])


    const needsViewportCoverage = useCallback((): boolean => {
        const viewport = viewportRef.current
        const sentinel = topSentinelRef.current
        if (!viewport || !sentinel) {
            return false
        }
        const viewportRect = viewport.getBoundingClientRect()
        const sentinelRect = sentinel.getBoundingClientRect()
        return shouldLoadOlderForViewport({
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewportTop: viewportRect.top,
            sentinelTop: sentinelRect.top,
            sentinelBottom: sentinelRect.bottom
        })
    }, [])
    needsViewportCoverageRef.current = needsViewportCoverage

    const scheduleCoverageAfterSettling = useCallback(() => {
        clearCoverageCheckTimer()
        if (historyLoaderRef.current.autoPaused) {
            return
        }
        const delay = getHistoryCoverageRetryDelay(initialScrollDeadlineRef.current, Date.now())
        coverageCheckTimerRef.current = window.setTimeout(() => {
            coverageCheckTimerRef.current = null
            if (needsViewportCoverage()) {
                void requestOlderRef.current('coverage')
            }
        }, delay)
    }, [clearCoverageCheckTimer, needsViewportCoverage])

    const startHistoryLoadAttempt = useCallback((runId: number): void => {
        const state = historyLoaderRef.current
        if (state.runId !== runId || !pendingLoadPromiseRef.current) {
            return
        }
        const finishStoppedAttempt = (
            current: HistoryLoaderState,
            result: Exclude<OlderHistoryLoadResult, 'loaded'>,
            autoPaused = current.autoPaused
        ) => {
            clearFailureRetryTimer()
            pendingScrollRef.current = null
            historyLoaderRef.current = {
                ...current,
                phase: 'idle',
                source: null,
                failureCount: 0,
                autoPaused
            }
            settlePendingLoad(result)
            if (
                result === 'transient-stop'
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
            ) {
                scheduleCoverageAfterSettling()
            }
        }

        const viewport = viewportRef.current
        if (!viewport) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (
            state.source !== 'consumer'
            && !needsViewportCoverage()
            && !(state.source === 'user' && isTopTurnHeadlessAssistant(viewport))
        ) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (isSyncingTailRef.current || isLoadingMoreRef.current) {
            finishStoppedAttempt(state, 'transient-stop')
            return
        }
        if (!hasMoreMessagesRef.current) {
            finishStoppedAttempt(state, 'terminal-stop', true)
            return
        }

        clearFailureRetryTimer()
        pendingScrollRef.current = {
            runId,
            anchor: captureScrollAnchor(viewport),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            targetHistoryVersion: null,
            pinOnRestore: state.source === 'user' && wheelGestureUntilRef.current > Date.now()
        }
        autoScrollEnabledRef.current = false
        historyLoaderRef.current = { ...state, phase: 'loading' }

        void (async () => {
            let outcome: OlderLoadOutcome
            try {
                outcome = await onLoadMoreRef.current((historyVersion) => {
                    const current = historyLoaderRef.current
                    const pending = pendingScrollRef.current
                    if (
                        current.runId !== runId
                        || !pendingLoadPromiseRef.current
                        || !pending
                        || pending.runId !== runId
                    ) {
                        return false
                    }
                    pending.targetHistoryVersion = historyVersion
                    historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                    return true
                })
            } catch (error) {
                outcome = {
                    kind: 'failed',
                    error: error instanceof Error
                        ? error
                        : new Error('Failed to load older messages')
                }
            }

            const current = historyLoaderRef.current
            if (current.runId !== runId || !pendingLoadPromiseRef.current) {
                return
            }

            if (outcome.kind === 'applied') {
                const pending = pendingScrollRef.current
                if (!pending || pending.runId !== runId) {
                    finishStoppedAttempt(current, 'transient-stop')
                    return
                }
                pending.targetHistoryVersion = outcome.historyVersion
                historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                return
            }

            pendingScrollRef.current = null
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    historyLoaderRef.current = {
                        ...current,
                        phase: 'backoff',
                        failureCount
                    }
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    failureRetryTimerRef.current = window.setTimeout(() => {
                        failureRetryTimerRef.current = null
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    }, delay)
                    return
                }
                finishStoppedAttempt(current, 'terminal-stop', true)
                return
            }

            const terminalStop = outcome.reason === 'epoch-reset'
                || outcome.reason === 'exhausted'
                || outcome.reason === 'unavailable'
            finishStoppedAttempt(
                current,
                terminalStop ? 'terminal-stop' : 'transient-stop',
                terminalStop ? true : current.autoPaused
            )
        })()
    }, [
        clearFailureRetryTimer,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        settlePendingLoad
    ])
    startHistoryLoadAttemptRef.current = startHistoryLoadAttempt

    const requestOlder = useCallback((source: HistoryLoadSource): Promise<OlderHistoryLoadResult> => {
        if (pendingLoadPromiseRef.current) {
            if (source === 'user') {
                const current = historyLoaderRef.current
                if (current.source !== 'user' || current.autoPaused) {
                    historyLoaderRef.current = {
                        ...current,
                        source: 'user',
                        autoPaused: false
                    }
                }
                if (pendingScrollRef.current && wheelGestureUntilRef.current > Date.now()) {
                    pendingScrollRef.current.pinOnRestore = true
                }
            }
            return pendingLoadPromiseRef.current
        }

        let state = historyLoaderRef.current
        if (source === 'coverage') {
            if (state.autoPaused) {
                return Promise.resolve('terminal-stop')
            }
            if (isInitialScrollSettling() || !needsViewportCoverage()) {
                return Promise.resolve('transient-stop')
            }
        } else {
            // Explicit consumers must not be swallowed by the initial
            // scroll-to-bottom settling window.
            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            if (source === 'user' && state.autoPaused) {
                state = { ...state, autoPaused: false }
                historyLoaderRef.current = state
            }
        }

        if (
            state.phase !== 'idle'
            || isSyncingTailRef.current
            || isLoadingMoreRef.current
            || !viewportRef.current
        ) {
            return Promise.resolve('transient-stop')
        }
        if (!hasMoreMessagesRef.current) {
            return Promise.resolve('terminal-stop')
        }

        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        const runId = state.runId + 1
        historyLoaderRef.current = {
            runId,
            phase: 'loading',
            source,
            failureCount: 0,
            autoPaused: source === 'user' ? false : state.autoPaused
        }
        const loadPromise = new Promise<OlderHistoryLoadResult>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        startHistoryLoadAttemptRef.current(runId)
        return loadPromise
    }, [
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
        clearInitialScrollTimers,
        isInitialScrollSettling,
        needsViewportCoverage
    ])
    requestOlderRef.current = requestOlder

    const loadOlderFromConsumer = useCallback((): Promise<OlderHistoryLoadResult> => {
        return requestOlder('consumer')
    }, [requestOlder])

    const loadOlderForOutline = useCallback(async (): Promise<boolean> => {
        return await loadOlderFromConsumer() === 'loaded'
    }, [loadOlderFromConsumer])

    const loadOlderUntilVisible = useCallback(async (): Promise<boolean> => {
        const viewport = viewportRef.current
        if (!viewport) {
            return false
        }
        return loadUntilVisibleBoundaryChanges({
            getVisibleBoundary: () => getVisibleTurnBoundaryId(viewport),
            isTopTurnIncomplete: () => isTopTurnHeadlessAssistant(viewport),
            hasMoreMessages: () => (
                hasMoreMessagesRef.current
                && needsViewportCoverageRef.current()
            ),
            loadOlder: async () => await requestOlder('user') === 'loaded',
            maxPages: 8
        })
    }, [requestOlder])

    const loadOlderFromUserGesture = useCallback(async (): Promise<boolean> => {
        const viewport = viewportRef.current
        if (viewport?.querySelector(`${MESSAGE_ANCHOR_SELECTOR}[data-hapi-message-role]`)) {
            return await loadOlderUntilVisible()
        }
        return await requestOlder('user') === 'loaded'
    }, [loadOlderUntilVisible, requestOlder])
    loadOlderFromUserGestureRef.current = loadOlderFromUserGesture

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const target = await locateOutlineTargetMessage({
            targetMessageId: item.targetMessageId,
            findTarget: (anchorId) => document.getElementById(anchorId),
            hasMoreMessages: () => hasMoreMessagesRef.current,
            loadOlderPreservingScroll: loadOlderForOutline
        })
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' })
            autoScrollEnabledRef.current = false
        }
        props.onOutlineItemClick?.(item)
        props.onOutlineOpenChange(false)
    }, [loadOlderForOutline, props.onOutlineItemClick, props.onOutlineOpenChange])

    useEffect(() => {
        if (
            !props.hasMoreMessages
            || props.isSyncingTail
            || props.isLoadingMoreMessages
            || isAwaitingMessagesRender
            || isAwaitingHistoryRender
        ) {
            clearCoverageCheckTimer()
            return
        }
        if (!needsViewportCoverage()) {
            return
        }
        if (isInitialScrollSettling()) {
            scheduleCoverageAfterSettling()
            return
        }
        void requestOlderRef.current('coverage')
    }, [
        props.hasMoreMessages,
        props.isSyncingTail,
        props.isLoadingMoreMessages,
        props.messagesVersion,
        appliedMessagesVersion,
        isAwaitingMessagesRender,
        isAwaitingHistoryRender,
        isInitialScrollSettling,
        needsViewportCoverage,
        scheduleCoverageAfterSettling,
        clearCoverageCheckTimer
    ])

    useEffect(() => {
        const content = contentRef.current
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            const viewport = viewportRef.current
            if (
                viewport
                && pinnedAnchorUntilRef.current > Date.now()
                && pinnedAnchorRef.current
                && historyLoaderRef.current.phase !== 'loading'
            ) {
                restoreScrollAnchor(viewport, pinnedAnchorRef.current)
                lastScrollTopRef.current = viewport.scrollTop
                return
            }
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep following while the user is at bottom.
            if (
                autoScrollEnabledRef.current
                && atBottomRef.current
                && !pendingScrollRef.current
            ) {
                scrollToBottomInstant()
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (!pendingScrollRef.current && needsViewportCoverage()) {
                if (isInitialScrollSettling()) {
                    scheduleCoverageAfterSettling()
                } else {
                    void requestOlderRef.current('coverage')
                }
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [
        scrollToBottomInstant,
        isInitialScrollSettling,
        needsViewportCoverage,
        scheduleCoverageAfterSettling
    ])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            if (
                pending.targetHistoryVersion === null
                || appliedHistoryVersion < pending.targetHistoryVersion
            ) {
                return
            }
            const restoredByAnchor = pending.anchor ? restoreScrollAnchor(viewport, pending.anchor) : false
            if (
                restoredByAnchor
                && pending.anchor
                && !hasMoreMessagesRef.current
                && viewport.scrollTop > 0
                && (pending.pinOnRestore || wheelGestureUntilRef.current > Date.now())
            ) {
                const startedAt = Date.now()
                pinnedAnchorRef.current = pending.anchor
                pinnedAnchorStartedAtRef.current = startedAt
                pinnedAnchorUntilRef.current = nextPinnedAnchorUntil(
                    startedAt,
                    startedAt,
                    WHEEL_GESTURE_GAP_MS,
                    ANCHOR_PIN_MAX_MS
                )
            } else if (restoredByAnchor) {
                pinnedAnchorRef.current = null
                pinnedAnchorUntilRef.current = 0
                pinnedAnchorStartedAtRef.current = 0
            } else if (!restoredByAnchor) {
                const delta = viewport.scrollHeight - pending.scrollHeight
                viewport.scrollTop = pending.scrollTop + delta
            }
            const loaderState = historyLoaderRef.current
            if (loaderState.runId !== pending.runId || loaderState.phase !== 'awaiting-render') {
                pendingScrollRef.current = null
                return
            }
            lastScrollTopRef.current = viewport.scrollTop
            pendingScrollRef.current = null
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...loaderState,
                phase: 'idle',
                source: null,
                failureCount: 0,
                // Only keep automatic coverage paused when the completed load
                // still leaves the viewport inside the preload margin. Once
                // anchor restoration places the viewport below the preload
                // zone, scrolling back up into the preload zone may preload.
                autoPaused: needsViewportCoverageRef.current()
            }
            settlePendingLoad('loaded')
            return
        }
        if (
            !isAwaitingMessagesRender
            && props.rawMessagesCount > 0
            && atBottomRef.current
            && autoScrollEnabledRef.current
        ) {
            scrollToBottomInstant()
        }
    }, [
        appliedMessagesVersion,
        appliedHistoryVersion,
        isAwaitingMessagesRender,
        props.rawMessagesCount,
        scrollToBottomInstant,
        settlePendingLoad,
        clearFailureRetryTimer
    ])

    const bottomInsetPx = props.bottomInsetPx ?? 0
    useLayoutEffect(() => {
        if (pendingScrollRef.current) return
        if (atBottomRef.current && autoScrollEnabledRef.current) {
            scrollToBottomInstant()
        }
    }, [bottomInsetPx, scrollToBottomInstant])

    return {
        viewportRef,
        contentRef,
        topSentinelRef,
        pullToLoadState,
        bottomInsetPx,
        handleNestedScrollFollowChange,
        loadOlderFromConsumer,
        loadOlderUntilVisible,
        scrollToBottom,
        handleOutlineSelect,
    }
}

