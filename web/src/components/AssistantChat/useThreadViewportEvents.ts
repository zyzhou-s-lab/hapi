import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { OlderHistoryLoadResult } from '@/components/AssistantChat/context'
import {
    applyKeyboardScrollToNestedContainer,
    findNestedScrollContainer,
    isHorizontalOnlyScrollEvent,
    isNestedScrollEvent,
    NESTED_SCROLL_KEYS,
} from '@/components/AssistantChat/nestedScroll'
import {
    ANCHOR_PIN_MAX_MS,
    captureScrollAnchor,
    getPullToLoadState,
    getScrollIntent,
    KEYBOARD_SCROLL_INTENT_WINDOW_MS,
    nextPinnedAnchorUntil,
    POINTER_CANCEL_INTENT_WINDOW_MS,
    restoreScrollAnchor,
    shouldRecapturePendingHistoryAnchor,
    shouldSuppressPinnedWheel,
    transitionScrollModeOnViewportScroll,
    UPWARD_SCROLL_KEYS,
    WHEEL_GESTURE_GAP_MS,
    type AnchorPinState,
    type HistoryLoaderState,
    type HistoryLoadSource,
    type InitialScrollSettleState,
    type PullToLoadState,
    type ScrollIntent,
    type ThreadScrollState,
} from '@/components/AssistantChat/threadScrollHelpers'

export type ThreadViewportEventBindings = {
    viewportRef: RefObject<HTMLDivElement | null>
    scrollStateRef: MutableRefObject<ThreadScrollState>
    anchorPinRef: MutableRefObject<AnchorPinState>
    initialSettleRef: MutableRefObject<InitialScrollSettleState>
    historyLoaderRef: MutableRefObject<HistoryLoaderState>
    updateScrollState: (
        patch: Partial<Omit<ThreadScrollState, 'mode'>>,
        options?: { forceNotifyViewMode?: boolean }
    ) => ThreadScrollState
    loadOlderFromUserGestureRef: MutableRefObject<() => Promise<boolean>>
    needsViewportCoverageRef: MutableRefObject<() => boolean>
    isInitialScrollSettling: () => boolean
    clearInitialScrollTimers: () => void
    requestOlderRef: MutableRefObject<(source: HistoryLoadSource) => Promise<OlderHistoryLoadResult>>
    cancelActiveHistoryLoad: () => void
    pullToLoadStateRef: MutableRefObject<PullToLoadState>
    setPullToLoadState: Dispatch<SetStateAction<PullToLoadState>>
    hasMoreMessagesRef: MutableRefObject<boolean>
    isSyncingTailRef: MutableRefObject<boolean>
    isLoadingMoreRef: MutableRefObject<boolean>
}

export function useThreadViewportEvents(bindings: ThreadViewportEventBindings): void {
    const {
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
    } = bindings
    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        scrollStateRef.current.lastScrollTop = viewport.scrollTop
        let pointerResumeActive = false
        let pointerResumeUntil = 0
        let pointerResumeLatched = false
        let keyboardResumeUntil = 0
        let lastWheelAt = 0
        let wheelIntentUntil = 0
        let wheelLatched = false
        let wheelLatchStartedAt = 0
        let nestedScrollFocused = false
        let focusedNestedScroller: HTMLElement | null = null
        let outerWheelActive = false
        let outerWheelClientX = 0
        let outerWheelClientY = 0
        let lastOuterWheelAt = 0
        const hasExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            return intent.isScrollingUp && (
                pointerResumeActive
                || pointerResumeUntil >= Date.now()
                || keyboardResumeUntil >= Date.now()
                || wheelIntentUntil >= Date.now()
            )
        }

        const consumeExplicitUpwardIntent = (intent: ScrollIntent): boolean => {
            if (!hasExplicitUpwardIntent(intent)) {
                return false
            }
            if ((pointerResumeActive || pointerResumeUntil >= Date.now()) && !pointerResumeLatched) {
                pointerResumeLatched = true
                return true
            }
            if (keyboardResumeUntil >= Date.now()) {
                keyboardResumeUntil = 0
                return true
            }
            if (wheelIntentUntil >= Date.now() && !wheelLatched) {
                wheelLatched = true
                wheelLatchStartedAt = Date.now()
                return true
            }
            return false
        }
        const runUserGestureLoad = () => {
            const latchToken = wheelLatchStartedAt
            void loadOlderFromUserGestureRef.current().then((loaded) => {
                if (wheelLatchStartedAt !== latchToken) {
                    return
                }
                if (!loaded || Date.now() - latchToken >= WHEEL_GESTURE_GAP_MS) {
                    wheelLatched = false
                }
            })
        }

        const handleScroll = () => {
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: scrollStateRef.current.lastScrollTop
            })
            scrollStateRef.current.lastScrollTop = viewport.scrollTop

            // A slow older-page request must not restore the position from
            // when it started after the user has already scrolled elsewhere.
            // Keep the pending baseline aligned with the latest visible row;
            // the eventual prepend will preserve that row instead.
            const pending = scrollStateRef.current.pendingRestore
            const anchorPin = anchorPinRef.current
            if (
                intent.isNearBottom
                || (scrollStateRef.current.autoScrollEnabled && scrollStateRef.current.atBottom)
            ) {
                clearPinnedAnchor()
            } else if (
                anchorPin.until > Date.now()
                && anchorPin.anchor
                && historyLoaderRef.current.phase === 'idle'
            ) {
                if (intent.isScrollingUp && restoreScrollAnchor(viewport, anchorPin.anchor)) {
                    scrollStateRef.current.lastScrollTop = viewport.scrollTop
                    return
                }
                clearPinnedAnchor()
            }
            if (
                pending
                && historyLoaderRef.current.runId === pending.runId
                && shouldRecapturePendingHistoryAnchor(historyLoaderRef.current.phase)
            ) {
                pending.anchor = captureScrollAnchor(viewport)
            }

            const needsCoverage = needsViewportCoverageRef.current()
            // Keep the keyboard/pointer intent armed while the user moves
            // through ordinary history. Consume it only when the viewport
            // actually reaches the preload area.
            const hadExplicitUpwardIntent = hasExplicitUpwardIntent(intent)
            const explicitUpwardIntent = needsCoverage && consumeExplicitUpwardIntent(intent)

            const isSettling = isInitialScrollSettling()
            if (!isSettling) {
                // Scroll position is the source of truth. The loader controller
                // decides whether this demand may start a request; programmatic
                // scroll events cannot bypass backoff or a paused coverage run.
                if (needsCoverage) {
                    if (explicitUpwardIntent) {
                        runUserGestureLoad()
                    } else {
                        void requestOlderRef.current('coverage')
                    }
                } else {
                    wheelLatched = false
                    pointerResumeLatched = false
                    if (historyLoaderRef.current.autoPaused) {
                        historyLoaderRef.current = {
                            ...historyLoaderRef.current,
                            autoPaused: false
                        }
                    }
                }
            }

            const transition = transitionScrollModeOnViewportScroll({
                intent,
                isInitialSettling: isSettling,
                hadExplicitUpwardIntent,
                tailScrollInProgress: scrollStateRef.current.tailScrollInProgress,
                needsCoverage,
                hasPendingRestore: scrollStateRef.current.pendingRestore !== null,
            })

            if (transition.cancelInitialSettling) {
                initialSettleRef.current.deadline = 0
                clearInitialScrollTimers()
                updateScrollState({
                    autoScrollEnabled: false,
                    atBottom: false,
                })
                if (explicitUpwardIntent) {
                    void loadOlderFromUserGestureRef.current()
                }
                return
            }
            if (isSettling) {
                return
            }

            if (transition.cancelActiveHistoryLoad) {
                cancelActiveHistoryLoad()
            }
            updateScrollState({
                ...(transition.clearTailScrollInProgress ? { tailScrollInProgress: false } : {}),
                ...(!transition.preserveTailDuringSmoothScroll
                    ? {
                        autoScrollEnabled: transition.autoScrollEnabled,
                        atBottom: transition.atBottom,
                    }
                    : {}),
            })
        }

        // Gesture fallback: at scrollTop=0 no further scroll events fire. Give
        // touch users progressive feedback, then load only when they release
        // after crossing the threshold.
        let pullStartY: number | null = null

        const updatePullToLoadState = (state: PullToLoadState) => {
            if (pullToLoadStateRef.current === state) {
                return
            }
            pullToLoadStateRef.current = state
            setPullToLoadState(state)
        }

        const clearPinnedAnchor = () => {
            anchorPinRef.current.anchor = null
            anchorPinRef.current.until = 0
            anchorPinRef.current.startedAt = 0
            if (scrollStateRef.current.pendingRestore) {
                scrollStateRef.current.pendingRestore.pinOnRestore = false
            }
        }
        const isEditableKeyTarget = (target: EventTarget | null): boolean => {
            return target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || (target instanceof HTMLElement && target.isContentEditable)
        }

        const handleNestedKeyScroll = (event: KeyboardEvent, container: HTMLElement | null): boolean => {
            if (
                event.defaultPrevented
                || event.altKey
                || event.ctrlKey
                || event.metaKey
                || isEditableKeyTarget(event.target)
                || !NESTED_SCROLL_KEYS[event.key]
            ) {
                return false
            }
            event.preventDefault()
            if (container && container.isConnected) {
                applyKeyboardScrollToNestedContainer(container, event.key, event.shiftKey)
            }
            return true
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            clearPinnedAnchor()
            outerWheelActive = false
            const nestedContainer = findNestedScrollContainer(event.target, viewport)
            if (nestedContainer || isNestedScrollEvent(event, viewport)) {
                if (nestedContainer) {
                    nestedScrollFocused = true
                    focusedNestedScroller = nestedContainer
                }
                handleNestedKeyScroll(event, nestedContainer ?? focusedNestedScroller)
                return
            }
            const target = event.target
            if (target === viewport && nestedScrollFocused) {
                handleNestedKeyScroll(event, focusedNestedScroller)
                return
            }
            if (
                event.defaultPrevented
                || event.repeat
                || event.altKey
                || event.ctrlKey
                || event.metaKey
                || !UPWARD_SCROLL_KEYS[event.key]
                || isEditableKeyTarget(target)
            ) {
                return
            }
            keyboardResumeUntil = Date.now() + KEYBOARD_SCROLL_INTENT_WINDOW_MS
            if (needsViewportCoverageRef.current()) {
                keyboardResumeUntil = 0
                void loadOlderFromUserGestureRef.current()
            }
        }

        const handleWindowKeyDown = (event: KeyboardEvent) => {
            if (!nestedScrollFocused) {
                return
            }
            const target = event.target
            if (target instanceof Node && viewport.contains(target)) {
                return
            }
            if (
                target !== document.body
                && target !== document.documentElement
                && target !== window
            ) {
                return
            }
            clearPinnedAnchor()
            outerWheelActive = false
            handleNestedKeyScroll(event, focusedNestedScroller)
        }

        const armPointerIntent = () => {
            pointerResumeActive = true
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerDown = (event: PointerEvent) => {
            outerWheelActive = false
            const nestedContainer = findNestedScrollContainer(event.target, viewport)
            if (nestedContainer || isNestedScrollEvent(event, viewport)) {
                nestedScrollFocused = true
                focusedNestedScroller = nestedContainer
                return
            }
            nestedScrollFocused = false
            focusedNestedScroller = null
            if (event.button !== 0) {
                return
            }
            clearPinnedAnchor()
            armPointerIntent()
        }

        const isInsideViewport = (clientX: number, clientY: number) => {
            const rect = viewport.getBoundingClientRect()
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
        }

        // Native scrollbar interaction may bypass the viewport's own event
        // listeners. Capture pointer and mouse input at the window boundary,
        // then scope it back to the chat viewport by coordinates.
        const handleWindowPointerDown = (event: PointerEvent) => {
            outerWheelActive = false
            const nestedContainer = findNestedScrollContainer(event.target, viewport)
            if (nestedContainer || isNestedScrollEvent(event, viewport)) {
                nestedScrollFocused = true
                focusedNestedScroller = nestedContainer
                return
            }
            nestedScrollFocused = false
            focusedNestedScroller = null
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                clearPinnedAnchor()
                armPointerIntent()
            }
        }

        const handleWindowMouseDown = (event: MouseEvent) => {
            outerWheelActive = false
            const nestedContainer = findNestedScrollContainer(event.target, viewport)
            if (nestedContainer || isNestedScrollEvent(event, viewport)) {
                nestedScrollFocused = true
                focusedNestedScroller = nestedContainer
                return
            }
            nestedScrollFocused = false
            focusedNestedScroller = null
            if (event.button === 0 && isInsideViewport(event.clientX, event.clientY)) {
                clearPinnedAnchor()
                armPointerIntent()
            }
        }

        const handleWindowPointerMove = (event: PointerEvent) => {
            if (!outerWheelActive) {
                return
            }
            if (
                Math.abs(event.clientX - outerWheelClientX) > 4
                || Math.abs(event.clientY - outerWheelClientY) > 4
            ) {
                outerWheelActive = false
            }
        }

        const clearPointerIntent = () => {
            pointerResumeActive = false
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handlePointerCancel = (event: PointerEvent) => {
            if (isNestedScrollEvent(event, viewport)) return
            const hadActivePointer = pointerResumeActive
            pointerResumeActive = false
            if (hadActivePointer && (event.pointerType === 'touch' || event.pointerType === 'pen')) {
                // Native panning cancels the pointer before some mobile browsers
                // dispatch the resulting scroll event. Retain that explicit input
                // briefly so initial bottom-settling cannot reclaim the viewport.
                pointerResumeUntil = Date.now() + POINTER_CANCEL_INTENT_WINDOW_MS
                return
            }
            pointerResumeUntil = 0
            pointerResumeLatched = false
        }

        const handleWheel = (event: WheelEvent) => {
            const now = Date.now()
            if (
                Math.abs(event.clientX - outerWheelClientX) > 4
                || Math.abs(event.clientY - outerWheelClientY) > 4
                || now - lastOuterWheelAt > ANCHOR_PIN_MAX_MS
            ) {
                outerWheelActive = false
            }
            const nestedScroll = isNestedScrollEvent(event, viewport)
            if (nestedScroll && !outerWheelActive) return
            if (!nestedScroll) {
                outerWheelActive = true
                outerWheelClientX = event.clientX
                outerWheelClientY = event.clientY
            }
            lastOuterWheelAt = now
            if (shouldSuppressPinnedWheel(event.deltaY, anchorPinRef.current.until, now)) {
                event.preventDefault()
                const startedAt = anchorPinRef.current.startedAt || now
                anchorPinRef.current.startedAt = startedAt
                const until = nextPinnedAnchorUntil(
                    startedAt,
                    now,
                    WHEEL_GESTURE_GAP_MS,
                    ANCHOR_PIN_MAX_MS
                )
                anchorPinRef.current.until = until
                anchorPinRef.current.wheelGestureUntil = until
                lastWheelAt = now
                wheelLatched = true
                wheelIntentUntil = until
                return
            }
            if (event.deltaY >= 0) {
                wheelIntentUntil = 0
                anchorPinRef.current.wheelGestureUntil = 0
                clearPinnedAnchor()
            }
            const shouldForwardVerticalWheel =
                !event.ctrlKey
                && !event.shiftKey
                && event.deltaY !== 0
                && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
                && (nestedScroll || isHorizontalOnlyScrollEvent(event, viewport))
            if (shouldForwardVerticalWheel && viewport.scrollHeight > viewport.clientHeight) {
                const pixelDeltaY = event.deltaMode === 1
                    ? event.deltaY * 40
                    : event.deltaMode === 2
                        ? event.deltaY * (viewport.clientHeight || 400)
                        : event.deltaY
                const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                const nextScrollTop = Math.max(0, Math.min(maxScrollTop, viewport.scrollTop + pixelDeltaY))
                event.preventDefault()
                if (nextScrollTop !== viewport.scrollTop) {
                    viewport.scrollTop = nextScrollTop
                    const pending = scrollStateRef.current.pendingRestore
                    if (
                        pending
                        && historyLoaderRef.current.runId === pending.runId
                        && shouldRecapturePendingHistoryAnchor(historyLoaderRef.current.phase)
                    ) {
                        pending.anchor = captureScrollAnchor(viewport)
                    }
                }
            }
            if (event.deltaY >= 0) {
                return
            }
            // One trigger per gesture: a trackpad swipe is a burst of wheel
            // events. Remember the gesture before the following scroll event
            // so an approach from outside the preload area is also classified
            // as explicit user intent.
            if (
                now - lastWheelAt > WHEEL_GESTURE_GAP_MS
                || (!historyLoaderRef.current.pendingPromise && now - wheelLatchStartedAt > ANCHOR_PIN_MAX_MS)
            ) {
                wheelLatched = false
            }
            lastWheelAt = now
            wheelIntentUntil = now + WHEEL_GESTURE_GAP_MS
            anchorPinRef.current.wheelGestureUntil = wheelIntentUntil
            if (scrollStateRef.current.pendingRestore) {
                scrollStateRef.current.pendingRestore.pinOnRestore = true
            }
            if (!needsViewportCoverageRef.current() || wheelLatched) {
                return
            }
            wheelLatched = true
            wheelLatchStartedAt = now
            runUserGestureLoad()
        }

        const handleTouchStart = (event: TouchEvent) => {
            const nestedContainer = findNestedScrollContainer(event.target, viewport)
            if (nestedContainer) {
                nestedScrollFocused = true
                focusedNestedScroller = nestedContainer
            } else {
                nestedScrollFocused = false
                focusedNestedScroller = null
            }
            if (isNestedScrollEvent(event, viewport, -1)) return
            pullStartY = (
                viewport.scrollTop <= 0
                && hasMoreMessagesRef.current
                && !isSyncingTailRef.current
                && !isLoadingMoreRef.current
                && !historyLoaderRef.current.pendingPromise
            )
                ? event.touches[0]?.clientY ?? null
                : null
        }

        const handleTouchMove = (event: TouchEvent) => {
            const currentY = event.touches[0]?.clientY
            const touchDeltaY = pullStartY !== null && currentY !== undefined
                ? pullStartY - currentY
                : -1
            if (isNestedScrollEvent(event, viewport, touchDeltaY)) {
                pullStartY = null
                updatePullToLoadState('idle')
                return
            }
            if (pullStartY === null) {
                return
            }
            if (viewport.scrollTop > 0) {
                pullStartY = null
                updatePullToLoadState('idle')
                return
            }
            if (currentY !== undefined) {
                updatePullToLoadState(getPullToLoadState(currentY - pullStartY))
            }
        }

        const handleTouchEnd = (event: TouchEvent) => {
            if (isNestedScrollEvent(event, viewport, -1)) return
            const shouldLoad = pullStartY !== null
                && pullToLoadStateRef.current === 'ready'
                && viewport.scrollTop <= 0
            pullStartY = null
            updatePullToLoadState('idle')
            if (shouldLoad) {
                void loadOlderFromUserGestureRef.current()
            }
        }

        const handleTouchCancel = (event: TouchEvent) => {
            if (isNestedScrollEvent(event, viewport, -1)) return
            pullStartY = null
            updatePullToLoadState('idle')
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('keydown', handleKeyDown)
        viewport.addEventListener('pointerdown', handlePointerDown, { passive: true })
        // passive: false so preventDefault can drop leftover upward wheel
        // deltas after the anchor is restored. Downward wheel, pointer, and
        // key clear that pin; otherwise preventDefault would swallow them too.
        viewport.addEventListener('wheel', handleWheel, { passive: false })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
        viewport.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        window.addEventListener('keydown', handleWindowKeyDown)
        window.addEventListener('pointerdown', handleWindowPointerDown, { capture: true, passive: true })
        window.addEventListener('mousedown', handleWindowMouseDown, { capture: true, passive: true })
        window.addEventListener('pointermove', handleWindowPointerMove, { passive: true })
        window.addEventListener('pointerup', clearPointerIntent, { passive: true })
        window.addEventListener('mouseup', clearPointerIntent, { passive: true })
        window.addEventListener('pointercancel', handlePointerCancel, { passive: true })
        window.addEventListener('blur', clearPointerIntent)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('keydown', handleKeyDown)
            viewport.removeEventListener('pointerdown', handlePointerDown)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('touchcancel', handleTouchCancel)
            window.removeEventListener('keydown', handleWindowKeyDown)
            window.removeEventListener('pointerdown', handleWindowPointerDown, true)
            window.removeEventListener('mousedown', handleWindowMouseDown, true)
            window.removeEventListener('pointermove', handleWindowPointerMove)
            window.removeEventListener('pointerup', clearPointerIntent)
            window.removeEventListener('mouseup', clearPointerIntent)
            window.removeEventListener('pointercancel', handlePointerCancel)
            window.removeEventListener('blur', clearPointerIntent)
        }
    }, []) // Stable: no dependencies, reads from refs
}

