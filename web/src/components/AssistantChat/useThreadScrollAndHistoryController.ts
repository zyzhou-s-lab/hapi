import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { OlderHistoryLoadResult } from '@/components/AssistantChat/context'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import {
    ANCHOR_PIN_MAX_MS,
    applyThreadScrollStatePatch,
    captureScrollAnchor,
    COVERAGE_FAILURE_RETRY_DELAY_MS,
    createInitialAnchorPinState,
    createInitialHistoryLoaderState,
    createInitialScrollSettleState,
    createInitialThreadScrollState,
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
    shouldFollowTailInScrollMode,
    shouldLoadOlderForViewport,
    WHEEL_GESTURE_GAP_MS,
    type AnchorPinState,
    type HistoryLoaderState,
    type HistoryLoadSource,
    type InitialScrollSettleState,
    type PullToLoadState,
    type ThreadScrollState,
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
    timelineStructureKey?: string
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    bottomInsetPx?: number
}) {
    const {
        appliedHistoryVersion,
        isAwaitingMessagesRender,
        isAwaitingHistoryRender,
    } = props
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [pullToLoadState, setPullToLoadState] = useState<PullToLoadState>('idle')
    const pullToLoadStateRef = useRef<PullToLoadState>('idle')
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isSyncingTailRef = useRef(props.isSyncingTail)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onCancelLoadMoreRef = useRef(props.onCancelLoadMore)
    const onViewModeChangeRef = useRef(props.onViewModeChange)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const sessionIdRef = useRef(props.sessionId)

    // Consolidated controller state records:
    // - scrollStateRef: authoritative 3-state scroll machine ('tail-follow' | 'user-reading' | 'pagination-restore')
    // - anchorPinRef: wheel gesture anchor pinning state
    // - initialSettleRef: per-session initial bottom-settling window and timers
    // - historyLoaderRef: older-history loader state, active promise, and retry/coverage timers
    const scrollStateRef = useRef<ThreadScrollState>(createInitialThreadScrollState())
    const anchorPinRef = useRef<AnchorPinState>(createInitialAnchorPinState())
    const initialSettleRef = useRef<InitialScrollSettleState>(createInitialScrollSettleState())
    const historyLoaderRef = useRef<HistoryLoaderState>(createInitialHistoryLoaderState())

    const updateScrollState = useCallback((
        patch: Partial<Omit<ThreadScrollState, 'mode'>>,
        options?: { forceNotifyViewMode?: boolean }
    ): ThreadScrollState => {
        const prev = scrollStateRef.current
        const next = applyThreadScrollStatePatch(prev, patch)
        scrollStateRef.current = next
        if (options?.forceNotifyViewMode || prev.atBottom !== next.atBottom) {
            onViewModeChangeRef.current(next.atBottom ? 'tail' : 'history')
        }
        return next
    }, [])

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
            // content mutation. Stay pinned when in authoritative tail-follow mode.
            if (shouldFollowTailInScrollMode(scrollStateRef.current.mode)) {
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                scrollStateRef.current.lastScrollTop = viewport.scrollTop
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

    const hasSettledInitialScroll = initialSettleRef.current.sessionId === props.sessionId
    const isAwaitingInitialRender = !hasSettledInitialScroll && isAwaitingMessagesRender
    const structureKey = props.timelineStructureKey ?? `${props.rawMessagesCount}:${appliedHistoryVersion}`
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
        return (
            initialSettleRef.current.sessionId === sessionIdRef.current
            && Date.now() < initialSettleRef.current.deadline
        )
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialSettleRef.current.timers) {
            window.clearTimeout(timer)
        }
        initialSettleRef.current.timers = []
    }, [])

    const clearCoverageCheckTimer = useCallback(() => {
        const timer = historyLoaderRef.current.coverageCheckTimer
        if (timer !== null && timer !== undefined) {
            window.clearTimeout(timer)
            historyLoaderRef.current.coverageCheckTimer = null
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        const timer = historyLoaderRef.current.failureRetryTimer
        if (timer !== null && timer !== undefined) {
            window.clearTimeout(timer)
            historyLoaderRef.current.failureRetryTimer = null
        }
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        const resolve = historyLoaderRef.current.pendingResolve
        historyLoaderRef.current.pendingResolve = null
        historyLoaderRef.current.pendingPromise = null
        updateScrollState({ pendingRestore: null })
        resolve?.(result)
    }, [updateScrollState])

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
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        historyLoaderRef.current = {
            ...historyLoaderRef.current,
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
        scrollStateRef,
        anchorPinRef,
        initialSettleRef,
        historyLoaderRef,
        updateScrollState,
        loadOlderFromUserGestureRef,
        needsViewportCoverageRef,
        isInitialScrollSettling,
        clearInitialScrollTimers,
        requestOlderRef,
        cancelActiveHistoryLoad,
        pullToLoadStateRef,
        setPullToLoadState,
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
            scrollStateRef.current.lastScrollTop = viewport.scrollTop
        }
    }, [])

    const handleNestedScrollFollowChange = useCallback((followLatest: boolean) => {
        if (!followLatest) {
            clearInitialScrollTimers()
        }
        updateScrollState({
            autoScrollEnabled: followLatest && scrollStateRef.current.atBottom,
        })
    }, [clearInitialScrollTimers, updateScrollState])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
        updateScrollState({
            autoScrollEnabled: true,
            atBottom: true,
            tailScrollInProgress: Boolean(viewport),
            lastScrollTop: viewport ? viewport.scrollTop : scrollStateRef.current.lastScrollTop,
        })
    }, [updateScrollState])

    // Reset state when session changes
    useLayoutEffect(() => {
        forceScrollTokenRef.current = props.forceScrollToken
        pullToLoadStateRef.current = 'idle'
        setPullToLoadState('idle')
        anchorPinRef.current = createInitialAnchorPinState()
        clearInitialScrollTimers()
        initialSettleRef.current = createInitialScrollSettleState()
        clearCoverageCheckTimer()
        clearFailureRetryTimer()
        const prevResolve = historyLoaderRef.current.pendingResolve
        historyLoaderRef.current = createInitialHistoryLoaderState(historyLoaderRef.current.runId + 1)
        scrollStateRef.current = createInitialThreadScrollState(viewportRef.current?.scrollTop ?? 0)
        onViewModeChangeRef.current('tail')
        prevResolve?.('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearCoverageCheckTimer,
        clearFailureRetryTimer,
    ])

    useLayoutEffect(() => {
        if (
            initialSettleRef.current.sessionId === props.sessionId
            || props.rawMessagesCount === 0
            || isAwaitingInitialRender
            || scrollStateRef.current.pendingRestore
        ) {
            return
        }

        initialSettleRef.current.sessionId = props.sessionId
        updateScrollState(
            {
                autoScrollEnabled: true,
                atBottom: true,
                tailScrollInProgress: false,
                pendingRestore: null,
            },
            { forceNotifyViewMode: true }
        )
        scrollToBottomInstant()

        initialSettleRef.current.deadline = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialSettleRef.current.timers = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialSettleRef.current.sessionId !== props.sessionId
                || !shouldFollowTailInScrollMode(scrollStateRef.current.mode)
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.rawMessagesCount,
        isAwaitingInitialRender,
        scrollToBottomInstant,
        clearInitialScrollTimers,
        updateScrollState,
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
        const delay = getHistoryCoverageRetryDelay(initialSettleRef.current.deadline, Date.now())
        historyLoaderRef.current.coverageCheckTimer = window.setTimeout(() => {
            historyLoaderRef.current.coverageCheckTimer = null
            if (needsViewportCoverage()) {
                void requestOlderRef.current('coverage')
            }
        }, delay)
    }, [clearCoverageCheckTimer, needsViewportCoverage])

    const startHistoryLoadAttempt = useCallback((runId: number): void => {
        const state = historyLoaderRef.current
        if (state.runId !== runId || !state.pendingPromise) {
            return
        }
        const finishStoppedAttempt = (
            current: HistoryLoaderState,
            result: Exclude<OlderHistoryLoadResult, 'loaded'>,
            autoPaused = current.autoPaused
        ) => {
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...historyLoaderRef.current,
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
        updateScrollState({
            autoScrollEnabled: false,
            pendingRestore: {
                runId,
                anchor: captureScrollAnchor(viewport),
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                targetHistoryVersion: null,
                pinOnRestore: state.source === 'user' && anchorPinRef.current.wheelGestureUntil > Date.now()
            }
        })
        historyLoaderRef.current = { ...historyLoaderRef.current, phase: 'loading' }
        void (async () => {
            let outcome: OlderLoadOutcome
            try {
                outcome = await onLoadMoreRef.current((historyVersion) => {
                    const current = historyLoaderRef.current
                    const pending = scrollStateRef.current.pendingRestore
                    if (
                        current.runId !== runId
                        || !current.pendingPromise
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
            if (current.runId !== runId || !current.pendingPromise) {
                return
            }

            if (outcome.kind === 'applied') {
                const pending = scrollStateRef.current.pendingRestore
                if (!pending || pending.runId !== runId) {
                    finishStoppedAttempt(current, 'transient-stop')
                    return
                }
                pending.targetHistoryVersion = outcome.historyVersion
                historyLoaderRef.current = { ...current, phase: 'awaiting-render' }
                return
            }
            updateScrollState({ pendingRestore: null })
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    const retryTimer = window.setTimeout(() => {
                        historyLoaderRef.current.failureRetryTimer = null
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    }, delay)
                    historyLoaderRef.current = {
                        ...current,
                        phase: 'backoff',
                        failureCount,
                        failureRetryTimer: retryTimer
                    }
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
        settlePendingLoad,
        updateScrollState,
    ])
    startHistoryLoadAttemptRef.current = startHistoryLoadAttempt

    const requestOlder = useCallback((source: HistoryLoadSource): Promise<OlderHistoryLoadResult> => {
        const activePromise = historyLoaderRef.current.pendingPromise
        if (activePromise) {
            if (source === 'user') {
                const current = historyLoaderRef.current
                if (current.source !== 'user' || current.autoPaused) {
                    historyLoaderRef.current = {
                        ...current,
                        source: 'user',
                        autoPaused: false
                    }
                }
                if (scrollStateRef.current.pendingRestore && anchorPinRef.current.wheelGestureUntil > Date.now()) {
                    scrollStateRef.current.pendingRestore.pinOnRestore = true
                }
            }
            return activePromise
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
            initialSettleRef.current.deadline = 0
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
        const { promise: loadPromise, resolve: pendingResolve } = Promise.withResolvers<OlderHistoryLoadResult>()
        historyLoaderRef.current = {
            ...historyLoaderRef.current,
            runId,
            phase: 'loading',
            source,
            failureCount: 0,
            autoPaused: source === 'user' ? false : state.autoPaused,
            pendingPromise: loadPromise,
            pendingResolve,
        }
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
            updateScrollState({ autoScrollEnabled: false })
        }
        props.onOutlineOpenChange(false)
    }, [loadOlderForOutline, props.onOutlineOpenChange, updateScrollState])
    useEffect(() => {
        if (
            !props.hasMoreMessages
            || props.isSyncingTail
            || props.isLoadingMoreMessages
            || isAwaitingInitialRender
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
        structureKey,
        appliedHistoryVersion,
        isAwaitingInitialRender,
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
            const anchorPin = anchorPinRef.current
            if (
                viewport
                && anchorPin.until > Date.now()
                && anchorPin.anchor
                && historyLoaderRef.current.phase !== 'loading'
            ) {
                restoreScrollAnchor(viewport, anchorPin.anchor)
                scrollStateRef.current.lastScrollTop = viewport.scrollTop
                return
            }
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep following while the user is at bottom.
            if (shouldFollowTailInScrollMode(scrollStateRef.current.mode)) {
                scrollToBottomInstant()
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (!scrollStateRef.current.pendingRestore && needsViewportCoverage()) {
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
        const pending = scrollStateRef.current.pendingRestore
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
                && (pending.pinOnRestore || anchorPinRef.current.wheelGestureUntil > Date.now())
            ) {
                const startedAt = Date.now()
                anchorPinRef.current.anchor = pending.anchor
                anchorPinRef.current.startedAt = startedAt
                anchorPinRef.current.until = nextPinnedAnchorUntil(
                    startedAt,
                    startedAt,
                    WHEEL_GESTURE_GAP_MS,
                    ANCHOR_PIN_MAX_MS
                )
            } else if (restoredByAnchor) {
                anchorPinRef.current.anchor = null
                anchorPinRef.current.until = 0
                anchorPinRef.current.startedAt = 0
            } else if (!restoredByAnchor) {
                const delta = viewport.scrollHeight - pending.scrollHeight
                viewport.scrollTop = pending.scrollTop + delta
            }
            const loaderState = historyLoaderRef.current
            if (loaderState.runId !== pending.runId || loaderState.phase !== 'awaiting-render') {
                updateScrollState({ pendingRestore: null })
                return
            }
            updateScrollState({
                lastScrollTop: viewport.scrollTop,
                pendingRestore: null,
            })
            clearFailureRetryTimer()
            historyLoaderRef.current = {
                ...historyLoaderRef.current,
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
            !isAwaitingInitialRender
            && props.rawMessagesCount > 0
            && shouldFollowTailInScrollMode(scrollStateRef.current.mode)
        ) {
            scrollToBottomInstant()
        }
    }, [
        structureKey,
        appliedHistoryVersion,
        isAwaitingInitialRender,
        props.rawMessagesCount,
        scrollToBottomInstant,
        settlePendingLoad,
        clearFailureRetryTimer,
        updateScrollState,
    ])

    const bottomInsetPx = props.bottomInsetPx ?? 0
    useLayoutEffect(() => {
        if (shouldFollowTailInScrollMode(scrollStateRef.current.mode)) {
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

