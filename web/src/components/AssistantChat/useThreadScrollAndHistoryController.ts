import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { OlderHistoryLoadResult } from '@/components/AssistantChat/context'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import {
    ANCHOR_PIN_MAX_MS,
    applyThreadScrollStatePatch,
    captureScrollAnchor,
    clearOlderLoadRetry,
    COVERAGE_FAILURE_RETRY_DELAY_MS,
    createInitialAnchorPinState,
    createInitialHistoryLoaderState,
    createInitialScrollSettleState,
    createInitialThreadScrollState,
    getVisibleTurnBoundaryId,
    INITIAL_SCROLL_SETTLE_MS,
    isTopTurnHeadlessAssistant,
    loadUntilVisibleBoundaryChanges,
    locateOutlineTargetMessage,
    MANUAL_SCROLL_EPSILON_PX,
    MAX_COVERAGE_LOAD_RETRIES,
    MESSAGE_ANCHOR_SELECTOR,
    nextPinnedAnchorUntil,
    restoreScrollAnchor,
    scheduleOlderLoadRetry,
    shouldFollowTailInScrollMode,
    shouldFollowTailInScrollPhase,
    shouldLoadOlderForViewport,
    WHEEL_GESTURE_GAP_MS,
    type AnchorPinState,
    type HistoryLoaderState,
    type HistoryLoadSource,
    type InitialScrollSettleState,
    type PullToLoadState,
    type ThreadScrollPhase,
    type ThreadScrollState,
    type ThreadScrollStatePatch,
} from '@/components/AssistantChat/threadScrollHelpers'
import { useThreadViewportEvents } from '@/components/AssistantChat/useThreadViewportEvents'
import { revealThreadEntry } from '@/fork-features/thread-windowing/useThreadEntryWindow'

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
    const outlineNavigationRef = useRef(0)

    // Consolidated controller state records:
    // - scrollStateRef: authoritative 4-phase scroll machine ('INITIAL_PINNING' | 'PINNED_FOLLOW' | 'USER_SCROLLED' | 'PREPENDING_HISTORY')
    // - anchorPinRef: wheel gesture anchor pinning state
    // - initialSettleRef: per-session initial bottom-pinning window
    // - historyLoaderRef: older-history loader state and active promise
    const scrollStateRef = useRef<ThreadScrollState>(createInitialThreadScrollState())
    const anchorPinRef = useRef<AnchorPinState>(createInitialAnchorPinState())
    const initialSettleRef = useRef<InitialScrollSettleState>(createInitialScrollSettleState())
    const historyLoaderRef = useRef<HistoryLoaderState>(createInitialHistoryLoaderState())
    const lastPinnedBottomScrollTopRef = useRef(0)

    const restoreViewportOverflowAnchor = useCallback((pending = scrollStateRef.current.pendingRestore) => {
        const viewport = viewportRef.current
        if (viewport && pending?.previousOverflowAnchor !== undefined) {
            viewport.style.overflowAnchor = pending.previousOverflowAnchor
        }
    }, [])

    const updateScrollState = useCallback((
        patch: ThreadScrollStatePatch,
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
                if (typeof viewport.scrollTo === 'function') {
                    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                } else {
                    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                }
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

    useLayoutEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    const isInitialScrollSettling = useCallback(() => {
        const isSettling = (
            initialSettleRef.current.sessionId === sessionIdRef.current
            && Date.now() < initialSettleRef.current.deadline
        )
        if (!isSettling && scrollStateRef.current.phase === 'INITIAL_PINNING') {
            scrollStateRef.current = applyThreadScrollStatePatch(scrollStateRef.current, {
                isInitialPinning: false,
            })
        }
        return isSettling
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        const coverageTimer = historyLoaderRef.current.coverageCheckTimer
        if (coverageTimer !== null && coverageTimer !== undefined) {
            window.clearTimeout(coverageTimer)
            historyLoaderRef.current.coverageCheckTimer = null
        }
        initialSettleRef.current.deadline = 0
        initialSettleRef.current.timers = []
        if (scrollStateRef.current.phase === 'INITIAL_PINNING') {
            scrollStateRef.current = applyThreadScrollStatePatch(scrollStateRef.current, {
                isInitialPinning: false,
            })
        }
    }, [])

    const clearFailureRetryTimer = useCallback(() => {
        clearOlderLoadRetry(historyLoaderRef.current)
    }, [])

    const settlePendingLoad = useCallback((result: OlderHistoryLoadResult) => {
        const resolve = historyLoaderRef.current.pendingResolve
        historyLoaderRef.current.pendingResolve = null
        historyLoaderRef.current.pendingPromise = null
        restoreViewportOverflowAnchor()
        updateScrollState({ pendingRestore: null })
        resolve?.(result)
    }, [restoreViewportOverflowAnchor, updateScrollState])
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
    }, [clearFailureRetryTimer, settlePendingLoad])

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
            if (typeof viewport.scrollTo === 'function') {
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                for (let pass = 0; pass < 2; pass += 1) {
                    const targetTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                    if (targetTop - viewport.scrollTop <= 1) {
                        break
                    }
                    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
                }
            } else {
                viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
            }
            scrollStateRef.current.lastScrollTop = viewport.scrollTop
            lastPinnedBottomScrollTopRef.current = viewport.scrollTop
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
            if (typeof viewport.scrollTo === 'function') {
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
            } else {
                viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
            }
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
        sessionIdRef.current = props.sessionId
        forceScrollTokenRef.current = props.forceScrollToken
        pullToLoadStateRef.current = 'idle'
        setPullToLoadState('idle')
        anchorPinRef.current = createInitialAnchorPinState()
        clearInitialScrollTimers()
        initialSettleRef.current = createInitialScrollSettleState()
        clearFailureRetryTimer()
        restoreViewportOverflowAnchor()
        const prevResolve = historyLoaderRef.current.pendingResolve
        historyLoaderRef.current = createInitialHistoryLoaderState(historyLoaderRef.current.runId + 1)
        const initialScrollTop = viewportRef.current?.scrollTop ?? 0
        lastPinnedBottomScrollTopRef.current = initialScrollTop
        scrollStateRef.current = createInitialThreadScrollState(initialScrollTop)
        onViewModeChangeRef.current('tail')
        prevResolve?.('transient-stop')
    }, [
        props.sessionId,
        clearInitialScrollTimers,
        clearFailureRetryTimer,
        restoreViewportOverflowAnchor,
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

        clearInitialScrollTimers()
        initialSettleRef.current.sessionId = props.sessionId
        initialSettleRef.current.deadline = Date.now() + INITIAL_SCROLL_SETTLE_MS
        initialSettleRef.current.timers = []
        updateScrollState(
            {
                autoScrollEnabled: true,
                atBottom: true,
                tailScrollInProgress: false,
                pendingRestore: null,
                isInitialPinning: true,
            },
            { forceNotifyViewMode: true }
        )
        scrollToBottomInstant()
        const runId = historyLoaderRef.current.runId
        const sessionId = props.sessionId
        const deadline = initialSettleRef.current.deadline
        const phase = scrollStateRef.current.phase
        const timer = window.setTimeout(() => {
            const loader = historyLoaderRef.current
            if (loader.coverageCheckTimer !== timer) return
            loader.coverageCheckTimer = null
            if (
                loader.runId !== runId
                || sessionIdRef.current !== sessionId
                || initialSettleRef.current.sessionId !== sessionId
                || initialSettleRef.current.deadline !== deadline
                || scrollStateRef.current.phase !== phase
                || isInitialScrollSettling()
            ) {
                return
            }
            if (
                loader.phase === 'idle'
                && !loader.autoPaused
                && !scrollStateRef.current.pendingRestore
                && needsViewportCoverageRef.current()
            ) {
                void requestOlderRef.current('coverage')
            }
        }, Math.max(0, deadline - Date.now()))
        historyLoaderRef.current.coverageCheckTimer = timer
    }, [
        props.sessionId,
        props.rawMessagesCount,
        isAwaitingInitialRender,
        clearInitialScrollTimers,
        isInitialScrollSettling,
        scrollToBottomInstant,
        updateScrollState,
    ])

    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        const handleViewportScrollDuringInitialPin = () => {
            const targetTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
            if (
                isInitialScrollSettling()
                && shouldFollowTailInScrollPhase(scrollStateRef.current.phase)
                && viewport.scrollTop < targetTop - MANUAL_SCROLL_EPSILON_PX
            ) {
                scrollToBottomInstant()
            }
        }
        const canNestedElementScrollUp = (target: EventTarget | null): boolean => {
            let current = target instanceof Element ? target : null
            while (current && current !== viewport) {
                if (
                    current instanceof HTMLElement
                    && current.matches('[data-hapi-nested-scroll="true"], pre')
                    && current.scrollHeight > current.clientHeight
                    && current.scrollTop > 0
                ) {
                    return true
                }
                current = current.parentElement
            }
            return false
        }
        const handleUpwardWheelDuringInitialPin = (event: WheelEvent) => {
            if (event.deltaY >= 0 || !isInitialScrollSettling()) {
                return
            }
            if (canNestedElementScrollUp(event.target)) {
                return
            }
            clearInitialScrollTimers()
            updateScrollState({
                autoScrollEnabled: false,
                atBottom: false,
                isInitialPinning: false,
            })
        }
        viewport.addEventListener('scroll', handleViewportScrollDuringInitialPin, { passive: true })
        viewport.addEventListener('wheel', handleUpwardWheelDuringInitialPin, { passive: true })
        return () => {
            viewport.removeEventListener('scroll', handleViewportScrollDuringInitialPin)
            viewport.removeEventListener('wheel', handleUpwardWheelDuringInitialPin)
        }
    }, [clearInitialScrollTimers, isInitialScrollSettling, scrollToBottomInstant, updateScrollState])

    useEffect(() => {
        return () => {
            historyLoaderRef.current.runId += 1
            clearInitialScrollTimers()
            clearFailureRetryTimer()
            settlePendingLoad('transient-stop')
        }
    }, [clearInitialScrollTimers, clearFailureRetryTimer, settlePendingLoad])
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
        const previousOverflowAnchor = viewport.style.overflowAnchor
        viewport.style.overflowAnchor = 'none'
        updateScrollState({
            autoScrollEnabled: false,
            isInitialPinning: false,
            pendingRestore: {
                runId,
                sessionId: sessionIdRef.current,
                anchor: captureScrollAnchor(viewport),
                targetHistoryVersion: null,
                pinOnRestore: state.source === 'user' && anchorPinRef.current.wheelGestureUntil > Date.now(),
                previousOverflowAnchor,
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
                        || pending.sessionId !== sessionIdRef.current
                    ) {
                        return false
                    }
                    if (pending.previousOverflowAnchor === undefined) {
                        pending.previousOverflowAnchor = viewport.style.overflowAnchor
                    }
                    viewport.style.overflowAnchor = 'none'
                    pending.anchor = captureScrollAnchor(viewport) ?? pending.anchor
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
            restoreViewportOverflowAnchor()
            updateScrollState({ pendingRestore: null })
            if (outcome.kind === 'failed') {
                const failureCount = current.failureCount + 1
                console.error('Failed to load older messages:', outcome.error)
                if (failureCount <= MAX_COVERAGE_LOAD_RETRIES) {
                    const delay = COVERAGE_FAILURE_RETRY_DELAY_MS * failureCount
                    const nextState: HistoryLoaderState = {
                        ...current,
                        phase: 'backoff',
                        failureCount,
                        failureRetryTimer: null,
                    }
                    historyLoaderRef.current = nextState
                    scheduleOlderLoadRetry(nextState, delay, () => {
                        const retryState = historyLoaderRef.current
                        if (retryState.runId !== runId || retryState.phase !== 'backoff') {
                            return
                        }
                        startHistoryLoadAttemptRef.current(runId)
                    })
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
            // Tail sync may finish before the invalidated request settles, so
            // its prop-driven coverage check can still see this pending load.
            if (outcome.reason === 'invalidated' && current.source !== 'consumer') {
                void requestOlderRef.current('coverage')
            }
        })()
    }, [
        clearFailureRetryTimer,
        needsViewportCoverage,
        restoreViewportOverflowAnchor,
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
            hasMoreMessages: () => (
                hasMoreMessagesRef.current
                && needsViewportCoverageRef.current()
            ),
            loadOlder: async () => await requestOlder('user') === 'loaded',
        })
    }, [requestOlder])

    const loadOlderFromUserGesture = useCallback(async (): Promise<boolean> => {
        const viewport = viewportRef.current
        if (
            viewport?.querySelector(
                `${MESSAGE_ANCHOR_SELECTOR}[data-hapi-message-role], [data-thread-entry-id][data-hapi-message-role], [data-message-id][data-hapi-message-role]`
            )
        ) {
            return await loadOlderUntilVisible()
        }
        return await requestOlder('user') === 'loaded'
    }, [loadOlderUntilVisible, requestOlder])
    loadOlderFromUserGestureRef.current = loadOlderFromUserGesture

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const navigation = ++outlineNavigationRef.current
        const sessionId = sessionIdRef.current
        props.onOutlineOpenChange(false)
        const target = await locateOutlineTargetMessage({
            targetMessageId: item.targetMessageId,
            findTarget: (anchorId) => document.getElementById(anchorId),
            hasMoreMessages: () => hasMoreMessagesRef.current,
            loadOlderPreservingScroll: loadOlderForOutline
        })
        if (!target || navigation !== outlineNavigationRef.current || sessionId !== sessionIdRef.current) return
        updateScrollState({ autoScrollEnabled: false })
        target.scrollIntoView({ block: 'start', behavior: 'instant' })
        const viewport = viewportRef.current
        if (viewport && target.hasAttribute('data-hapi-offscreen-placeholder')) {
            const mounted = await revealThreadEntry(viewport, item.targetMessageId)
            if (mounted && navigation === outlineNavigationRef.current && sessionId === sessionIdRef.current) {
                document.getElementById(target.id)?.scrollIntoView({ block: 'start', behavior: 'instant' })
            }
        }
    }, [loadOlderForOutline, props.onOutlineOpenChange, updateScrollState])
    useEffect(() => {
        if (
            !props.hasMoreMessages
            || props.isSyncingTail
            || props.isLoadingMoreMessages
            || isAwaitingInitialRender
            || isAwaitingHistoryRender
        ) {
            return
        }
        if (!needsViewportCoverage() || isInitialScrollSettling()) {
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
    ])

    useEffect(() => {
        const content = contentRef.current ?? viewportRef.current?.firstElementChild
        if (!content || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            const viewport = viewportRef.current
            const anchorPin = anchorPinRef.current
            const followsTail = scrollStateRef.current.autoScrollEnabled && scrollStateRef.current.atBottom
            if (followsTail) {
                anchorPinRef.current = createInitialAnchorPinState()
            } else if (
                viewport
                && anchorPin.until > Date.now()
                && anchorPin.anchor
                && historyLoaderRef.current.phase === 'idle'
            ) {
                if (restoreScrollAnchor(viewport, anchorPin.anchor)) {
                    scrollStateRef.current.lastScrollTop = viewport.scrollTop
                    return
                }
                anchorPinRef.current = createInitialAnchorPinState()
            }
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Stay pinned during INITIAL_PINNING and PINNED_FOLLOW.
            if (shouldFollowTailInScrollPhase(scrollStateRef.current.phase)) {
                scrollToBottomInstant()
                if (!isInitialScrollSettling() && scrollStateRef.current.phase === 'INITIAL_PINNING') {
                    updateScrollState({ isInitialPinning: false })
                }
            }
            // Late content growth can leave the viewport near the top without
            // a scroll event. Submit demand through the same controller; an
            // in-flight load, backoff, or paused run remains exclusive.
            if (
                !scrollStateRef.current.pendingRestore
                && !isInitialScrollSettling()
                && needsViewportCoverage()
            ) {
                void requestOlderRef.current('coverage')
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [
        scrollToBottomInstant,
        isInitialScrollSettling,
        needsViewportCoverage,
        updateScrollState,
    ])

    useLayoutEffect(() => {
        const pending = scrollStateRef.current.pendingRestore
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            const loaderState = historyLoaderRef.current
            if (
                loaderState.runId !== pending.runId
                || pending.sessionId !== props.sessionId
                || sessionIdRef.current !== props.sessionId
                || (loaderState.phase !== 'loading' && loaderState.phase !== 'awaiting-render')
            ) {
                restoreViewportOverflowAnchor(pending)
                updateScrollState({ pendingRestore: null })
                return
            }
            if (
                pending.targetHistoryVersion === null
                || appliedHistoryVersion < pending.targetHistoryVersion
                || loaderState.phase !== 'awaiting-render'
            ) {
                return
            }
            const followsTail = scrollStateRef.current.autoScrollEnabled && scrollStateRef.current.atBottom
            const restoredByAnchor = !followsTail && pending.anchor
                ? restoreScrollAnchor(viewport, pending.anchor)
                : false
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
            } else {
                anchorPinRef.current = createInitialAnchorPinState()
            }
            restoreViewportOverflowAnchor(pending)
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
            if (!followsTail) return
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
        props.sessionId,
        restoreViewportOverflowAnchor,
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
    const getScrollPhase = useCallback((): ThreadScrollPhase => {
        isInitialScrollSettling()
        return scrollStateRef.current.phase
    }, [isInitialScrollSettling])

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
        getScrollPhase,
    }
}

