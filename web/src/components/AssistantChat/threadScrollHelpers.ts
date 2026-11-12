import { getConversationMessageAnchorId } from '@/chat/outline'
import type { OlderHistoryLoadResult } from '@/components/AssistantChat/context'

export type ScrollAnchor = {
    id: string
    topOffset: number
}

export type PendingScrollRestore = {
    runId: number
    sessionId: string
    anchor: ScrollAnchor | null
    targetHistoryVersion: number | null
    pinOnRestore?: boolean
    previousOverflowAnchor?: string
}

export type HistoryLoadSource = 'coverage' | 'user' | 'consumer'
export type PullToLoadState = 'idle' | 'pulling' | 'ready'

export type ThreadScrollPhase =
    | 'INITIAL_PINNING'
    | 'PINNED_FOLLOW'
    | 'USER_SCROLLED'
    | 'PREPENDING_HISTORY'

export type ThreadScrollMode =
    | 'tail-follow'
    | 'user-reading'
    | 'pagination-restore'

export type ThreadScrollState = {
    phase: ThreadScrollPhase
    mode: ThreadScrollMode
    autoScrollEnabled: boolean
    atBottom: boolean
    tailScrollInProgress: boolean
    lastScrollTop: number
    pendingRestore: PendingScrollRestore | null
}

export type AnchorPinState = {
    anchor: ScrollAnchor | null
    startedAt: number
    until: number
    wheelGestureUntil: number
}

export type InitialScrollSettleState = {
    sessionId: string | null
    deadline: number
    timers: number[]
}

export type HistoryLoaderState = {
    runId: number
    phase: 'idle' | 'loading' | 'backoff' | 'awaiting-render'
    source: HistoryLoadSource | null
    failureCount: number
    autoPaused: boolean
    pendingPromise?: Promise<OlderHistoryLoadResult> | null
    pendingResolve?: ((value: OlderHistoryLoadResult) => void) | null
    coverageCheckTimer?: number | null
    failureRetryTimer?: number | null
}

export const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
export const THREAD_ENTRY_ANCHOR_SELECTOR =
    '.happy-thread-messages > [id], [data-thread-entry-id], [data-message-id]'
// Resume tail-following only once the user has actually reached the bottom.
// A wider proximity threshold makes a downward-reading user enter tail mode
// early; the next content/layout update then snaps the viewport to the end.
export const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1

/** Blank the thread keeps under the floating dock. Expanded/hidden docks reserve nothing. */
export function measureComposerDockInset(
    heightPx: number,
    options: { expanded: boolean; hidden: boolean }
): number {
    if (options.expanded || options.hidden) return 0
    if (!Number.isFinite(heightPx) || heightPx <= 0) return 0
    return Math.ceil(heightPx)
}
export const MANUAL_SCROLL_EPSILON_PX = 1
export const INITIAL_SCROLL_SETTLE_MS = 1800
export const INITIAL_SCROLL_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500, 900, 1400, 1800] as const
export const HISTORY_PRELOAD_MARGIN_PX = 200
// Bounded backoff for the same logical history load. A failed page leaves the
// viewport geometry unchanged, so no new scroll/resize signal is guaranteed.
export const COVERAGE_FAILURE_RETRY_DELAY_MS = 1000
export const MAX_COVERAGE_LOAD_RETRIES = 3
// Show feedback early, but require a deliberate pull before release loads.
export const TOP_PULL_FEEDBACK_PX = 16
export const TOP_PULL_TRIGGER_PX = 64
// Silence between wheel events that marks the end of one upward gesture.
// Trackpads emit a burst per swipe; one signal is enough to restart a paused
// run after its bounded retry budget is exhausted.
export const WHEEL_GESTURE_GAP_MS = 250
// Leftover upward deltas are swallowed only for the rest of the gesture,
// and never longer than this from the moment the anchor is pinned.
export const ANCHOR_PIN_MAX_MS = 1000
export const KEYBOARD_SCROLL_INTENT_WINDOW_MS = 750
export const POINTER_CANCEL_INTENT_WINDOW_MS = 750
export const UPWARD_SCROLL_KEYS: Record<string, true> = {
    ArrowUp: true,
    PageUp: true,
    Home: true,
}

export function getPullToLoadState(distancePx: number): PullToLoadState {
    if (distancePx >= TOP_PULL_TRIGGER_PX) {
        return 'ready'
    }
    if (distancePx >= TOP_PULL_FEEDBACK_PX) {
        return 'pulling'
    }
    return 'idle'
}

export type ScrollIntent = {
    distanceFromBottom: number
    isNearBottom: boolean
    isScrollingUp: boolean
}

export type LocateOutlineTargetOptions = {
    targetMessageId: string
    findTarget: (anchorId: string) => HTMLElement | null
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
    thresholdPx?: number
}): ScrollIntent {
    const thresholdPx = params.thresholdPx ?? AUTO_SCROLL_RESUME_THRESHOLD_PX
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isNearBottom: distanceFromBottom <= thresholdPx,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX
    }
}

export function shouldCancelInitialScrollSettling(
    intent: ScrollIntent,
    hasExplicitUpwardIntent: boolean
): boolean {
    return hasExplicitUpwardIntent
        && intent.isScrollingUp
        && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX
}

export function resolveThreadScrollPhase(params: {
    autoScrollEnabled: boolean
    atBottom: boolean
    hasPendingRestore: boolean
    isInitialPinning?: boolean
}): ThreadScrollPhase {
    if (params.hasPendingRestore) {
        return 'PREPENDING_HISTORY'
    }
    if (params.autoScrollEnabled && params.atBottom) {
        return params.isInitialPinning ? 'INITIAL_PINNING' : 'PINNED_FOLLOW'
    }
    return 'USER_SCROLLED'
}

export function shouldFollowTailInScrollPhase(phase: ThreadScrollPhase): boolean {
    return phase === 'INITIAL_PINNING' || phase === 'PINNED_FOLLOW'
}

export function resolveThreadScrollMode(params: {
    autoScrollEnabled: boolean
    atBottom: boolean
    hasPendingRestore: boolean
}): ThreadScrollMode {
    if (params.hasPendingRestore) {
        return 'pagination-restore'
    }
    if (params.autoScrollEnabled && params.atBottom) {
        return 'tail-follow'
    }
    return 'user-reading'
}

export function shouldFollowTailInScrollMode(mode: ThreadScrollMode): boolean {
    return mode === 'tail-follow'
}

export function createInitialThreadScrollState(lastScrollTop = 0): ThreadScrollState {
    return {
        phase: 'INITIAL_PINNING',
        mode: 'tail-follow',
        autoScrollEnabled: true,
        atBottom: true,
        tailScrollInProgress: false,
        lastScrollTop,
        pendingRestore: null,
    }
}

export function createInitialAnchorPinState(): AnchorPinState {
    return {
        anchor: null,
        startedAt: 0,
        until: 0,
        wheelGestureUntil: 0,
    }
}

export function createInitialScrollSettleState(): InitialScrollSettleState {
    return {
        sessionId: null,
        deadline: 0,
        timers: [],
    }
}

export function createInitialHistoryLoaderState(runId = 0): HistoryLoaderState {
    return {
        runId,
        phase: 'idle',
        source: null,
        failureCount: 0,
        autoPaused: false,
        pendingPromise: null,
        pendingResolve: null,
        coverageCheckTimer: null,
        failureRetryTimer: null,
    }
}

export type ThreadScrollStatePatch = Partial<Omit<ThreadScrollState, 'mode' | 'phase'>> & {
    isInitialPinning?: boolean
    phase?: ThreadScrollPhase
}

export function applyThreadScrollStatePatch(
    current: ThreadScrollState,
    patch: ThreadScrollStatePatch
): ThreadScrollState {
    const autoScrollEnabled = patch.autoScrollEnabled !== undefined
        ? patch.autoScrollEnabled
        : current.autoScrollEnabled
    const atBottom = patch.atBottom !== undefined
        ? patch.atBottom
        : current.atBottom
    const tailScrollInProgress = patch.tailScrollInProgress !== undefined
        ? patch.tailScrollInProgress
        : current.tailScrollInProgress
    const lastScrollTop = patch.lastScrollTop !== undefined
        ? patch.lastScrollTop
        : current.lastScrollTop
    const pendingRestore = patch.pendingRestore !== undefined
        ? patch.pendingRestore
        : current.pendingRestore
    const isInitialPinning = patch.isInitialPinning !== undefined
        ? patch.isInitialPinning
        : current.phase === 'INITIAL_PINNING' && autoScrollEnabled && atBottom && pendingRestore === null
    const phase = patch.phase ?? resolveThreadScrollPhase({
        autoScrollEnabled,
        atBottom,
        hasPendingRestore: pendingRestore !== null,
        isInitialPinning,
    })
    return {
        phase,
        mode: resolveThreadScrollMode({
            autoScrollEnabled,
            atBottom,
            hasPendingRestore: pendingRestore !== null,
        }),
        autoScrollEnabled,
        atBottom,
        tailScrollInProgress,
        lastScrollTop,
        pendingRestore,
    }
}

export type ViewportScrollTransition = {
    nextPhase: ThreadScrollPhase
    nextMode: ThreadScrollMode
    autoScrollEnabled: boolean
    atBottom: boolean
    cancelInitialSettling: boolean
    clearTailScrollInProgress: boolean
    cancelActiveHistoryLoad: boolean
    preserveTailDuringSmoothScroll: boolean
}

export function transitionScrollModeOnViewportScroll(params: {
    intent: ScrollIntent
    isInitialSettling: boolean
    hadExplicitUpwardIntent: boolean
    tailScrollInProgress: boolean
    needsCoverage: boolean
    hasPendingRestore: boolean
}): ViewportScrollTransition {
    if (params.isInitialSettling) {
        const cancel = shouldCancelInitialScrollSettling(params.intent, params.hadExplicitUpwardIntent)
        const autoScrollEnabled = !cancel
        const atBottom = !cancel
        return {
            nextPhase: resolveThreadScrollPhase({
                autoScrollEnabled,
                atBottom,
                hasPendingRestore: params.hasPendingRestore,
                isInitialPinning: !cancel,
            }),
            nextMode: resolveThreadScrollMode({
                autoScrollEnabled,
                atBottom,
                hasPendingRestore: params.hasPendingRestore,
            }),
            autoScrollEnabled,
            atBottom,
            cancelInitialSettling: cancel,
            clearTailScrollInProgress: false,
            cancelActiveHistoryLoad: false,
            preserveTailDuringSmoothScroll: !cancel,
        }
    }

    if (params.intent.isScrollingUp && params.intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX) {
        return {
            nextPhase: resolveThreadScrollPhase({
                autoScrollEnabled: false,
                atBottom: false,
                hasPendingRestore: params.hasPendingRestore,
                isInitialPinning: false,
            }),
            nextMode: resolveThreadScrollMode({
                autoScrollEnabled: false,
                atBottom: false,
                hasPendingRestore: params.hasPendingRestore,
            }),
            autoScrollEnabled: false,
            atBottom: false,
            cancelInitialSettling: false,
            clearTailScrollInProgress: true,
            cancelActiveHistoryLoad: false,
            preserveTailDuringSmoothScroll: false,
        }
    }

    if (params.intent.isNearBottom) {
        return {
            nextPhase: resolveThreadScrollPhase({
                autoScrollEnabled: true,
                atBottom: true,
                hasPendingRestore: params.hasPendingRestore,
                isInitialPinning: false,
            }),
            nextMode: resolveThreadScrollMode({
                autoScrollEnabled: true,
                atBottom: true,
                hasPendingRestore: params.hasPendingRestore,
            }),
            autoScrollEnabled: true,
            atBottom: true,
            cancelInitialSettling: false,
            clearTailScrollInProgress: true,
            cancelActiveHistoryLoad: !params.needsCoverage,
            preserveTailDuringSmoothScroll: false,
        }
    }

    if (params.tailScrollInProgress) {
        return {
            nextPhase: resolveThreadScrollPhase({
                autoScrollEnabled: true,
                atBottom: true,
                hasPendingRestore: params.hasPendingRestore,
                isInitialPinning: false,
            }),
            nextMode: resolveThreadScrollMode({
                autoScrollEnabled: true,
                atBottom: true,
                hasPendingRestore: params.hasPendingRestore,
            }),
            autoScrollEnabled: true,
            atBottom: true,
            cancelInitialSettling: false,
            clearTailScrollInProgress: false,
            cancelActiveHistoryLoad: false,
            preserveTailDuringSmoothScroll: true,
        }
    }

    return {
        nextPhase: resolveThreadScrollPhase({
            autoScrollEnabled: false,
            atBottom: false,
            hasPendingRestore: params.hasPendingRestore,
            isInitialPinning: false,
        }),
        nextMode: resolveThreadScrollMode({
            autoScrollEnabled: false,
            atBottom: false,
            hasPendingRestore: params.hasPendingRestore,
        }),
        autoScrollEnabled: false,
        atBottom: false,
        cancelInitialSettling: false,
        clearTailScrollInProgress: false,
        cancelActiveHistoryLoad: false,
        preserveTailDuringSmoothScroll: false,
    }
}

export function resolveStructureMessagesVersion(params: {
    messagesVersion: number
    previousStructureVersion: number
    previousStructureKey: string
    nextStructureKey: string
    previousHistoryVersion: number
    nextHistoryVersion: number
    previousRawMessagesCount: number
    nextRawMessagesCount: number
}): number {
    if (params.messagesVersion <= 0) {
        return 0
    }
    if (
        params.previousStructureVersion <= 0
        || params.previousStructureKey !== params.nextStructureKey
        || params.previousHistoryVersion !== params.nextHistoryVersion
        || params.previousRawMessagesCount !== params.nextRawMessagesCount
    ) {
        return params.messagesVersion
    }
    return params.previousStructureVersion
}

type CapturedAnchorState = {
    anchorHeight: number
    topOffset: number
    childId: string | null
    childTopOffset: number
    consumedPrepend: boolean
}

const capturedAnchorState = new WeakMap<ScrollAnchor, CapturedAnchorState>()

function getMessageAnchorId(element: HTMLElement): string {
    return (
        element.id
        || element.getAttribute('data-thread-entry-id')
        || element.getAttribute('data-message-id')
        || ''
    )
}

function findMessageAnchorElement(viewport: HTMLElement, anchorId: string): HTMLElement | null {
    if (!anchorId) {
        return null
    }
    const byId = document.getElementById(anchorId)
    if (byId && viewport.contains(byId)) {
        return byId
    }
    const candidates = viewport.querySelectorAll<HTMLElement>(THREAD_ENTRY_ANCHOR_SELECTOR)
    for (const candidate of candidates) {
        if (
            candidate.id === anchorId
            || candidate.getAttribute('data-thread-entry-id') === anchorId
            || candidate.getAttribute('data-message-id') === anchorId
        ) {
            return candidate
        }
    }
    return null
}

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(THREAD_ENTRY_ANCHOR_SELECTOR))
    const firstNonSystemIndex = messages.findIndex(
        (element) => element.getAttribute('data-hapi-message-role') !== 'system'
    )
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!
        const anchorId = getMessageAnchorId(message)
        if (!anchorId) {
            continue
        }
        const rect = message.getBoundingClientRect()
        if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
            if (index < firstNonSystemIndex) {
                const firstNonSystem = messages[firstNonSystemIndex]
                const nonSystemRect = firstNonSystem?.getBoundingClientRect()
                if (
                    firstNonSystem
                    && nonSystemRect
                    && nonSystemRect.bottom > viewportRect.top
                    && nonSystemRect.top < viewportRect.bottom
                ) {
                    continue
                }
            }
            const topOffset = rect.top - viewportRect.top
            const anchor: ScrollAnchor = {
                id: anchorId,
                topOffset
            }
            let childId: string | null = null
            let childTopOffset = 0
            for (const child of message.querySelectorAll<HTMLElement>('[data-block-id]')) {
                const id = child.getAttribute('data-block-id')
                // Rail containers can repeat a row's id. Capture the row itself.
                if (!id || child.querySelector('[data-block-id]')) continue
                const childRect = child.getBoundingClientRect()
                if (childRect.bottom > viewportRect.top && childRect.top < viewportRect.bottom) {
                    childId = id
                    childTopOffset = childRect.top - rect.top
                    break
                }
            }
            capturedAnchorState.set(anchor, {
                anchorHeight: rect.bottom - rect.top,
                topOffset,
                childId,
                childTopOffset,
                consumedPrepend: false,
            })
            return anchor
        }
    }
    return null
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = findMessageAnchorElement(viewport, anchor.id)
    if (!target) {
        return false
    }
    const previousOverflowAnchor = viewport.style.overflowAnchor
    viewport.style.overflowAnchor = 'none'
    try {
        const viewportRect = viewport.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const state = capturedAnchorState.get(anchor)
        const currentTopOffset = targetRect.top - viewportRect.top
        let delta = currentTopOffset - (state?.topOffset ?? anchor.topOffset)
        if (state && !state.consumedPrepend) {
            const child = state.childId === null ? undefined : Array.from(
                target.querySelectorAll<HTMLElement>('[data-block-id]')
            ).find((element) => (
                element.getAttribute('data-block-id') === state.childId
                && !element.querySelector('[data-block-id]')
            ))
            const childDelta = child
                ? child.getBoundingClientRect().top - targetRect.top - state.childTopOffset
                : 0
            delta = Math.max(0, delta) + Math.max(0, childDelta)
            const previousScrollTop = viewport.scrollTop
            if (delta !== 0) viewport.scrollTop += delta
            // Save the resulting anchor offset, including browser clamping.
            // Later pinning corrects actual drift without consuming the prepend twice.
            state.topOffset = currentTopOffset - (viewport.scrollTop - previousScrollTop)
            state.consumedPrepend = true
        } else if (delta !== 0) {
            viewport.scrollTop += delta
        }
        return true
    } finally {
        viewport.style.overflowAnchor = previousOverflowAnchor
    }
}

/** Scroll events while the older page is in flight still belong to the user.
 * Once the response is applied, those events are the prepend itself or the
 * rest of the wheel gesture, and recapturing would aim the restore at the
 * newly inserted rows. */
export function shouldRecapturePendingHistoryAnchor(
    phase: HistoryLoaderState['phase']
): boolean {
    return phase === 'loading'
}

/** Upward wheel deltas that arrive after the anchor is restored belong to the
 * gesture that triggered the load. Applying them moves the restored row. */
export function shouldSuppressPinnedWheel(deltaY: number, pinUntil: number, now: number): boolean {
    return deltaY < 0 && pinUntil > now
}

export function nextPinnedAnchorUntil(
    startedAt: number,
    now: number,
    gapMs: number,
    maxMs: number
): number {
    return Math.min(now + gapMs, startedAt + maxMs)
}

export function hasAppliedHistoryVersion(
    pendingHistoryVersion: number,
    appliedHistoryVersion: number
): boolean {
    return appliedHistoryVersion > pendingHistoryVersion
}

export async function locateOutlineTargetMessage(options: LocateOutlineTargetOptions): Promise<HTMLElement | null> {
    const anchorId = getConversationMessageAnchorId(options.targetMessageId)
    let target = options.findTarget(anchorId)
    while (!target && options.hasMoreMessages()) {
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) {
            break
        }
        target = options.findTarget(anchorId)
    }
    return target
}

export function shouldLoadOlderForViewport(params: {
    scrollHeight: number
    clientHeight: number
    viewportTop: number
    sentinelTop: number
    sentinelBottom: number
    preloadMarginPx?: number
}): boolean {
    const preloadMarginPx = params.preloadMarginPx ?? HISTORY_PRELOAD_MARGIN_PX
    if (params.scrollHeight <= params.clientHeight + 1) {
        return true
    }
    return params.sentinelBottom >= params.viewportTop - preloadMarginPx
        && params.sentinelTop <= params.viewportTop + preloadMarginPx
}

export function getHistoryCoverageRetryDelay(deadline: number, now: number): number {
    return Math.max(0, deadline - now) + 16
}

export function clearOlderLoadRetry(state: HistoryLoaderState): void {
    const timer = state.failureRetryTimer
    if (timer !== null && timer !== undefined) {
        window.clearTimeout(timer)
        state.failureRetryTimer = null
    }
}

export function scheduleOlderLoadRetry(
    state: HistoryLoaderState,
    delayMs: number,
    onRetry: () => void
): number {
    clearOlderLoadRetry(state)
    const timer = window.setTimeout(() => {
        state.failureRetryTimer = null
        onRetry()
    }, delayMs)
    state.failureRetryTimer = timer
    return timer
}

const MAX_VISIBLE_BOUNDARY_LOAD_PAGES = 4

export function getVisibleTurnBoundaryId(viewport: HTMLElement): string | null {
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(THREAD_ENTRY_ANCHOR_SELECTOR))
    const nonSystemMessages = messages.filter(
        (element) => element.getAttribute('data-hapi-message-role') !== 'system'
    )
    const firstMessage = nonSystemMessages[0] ?? messages[0]
    if (!firstMessage) {
        return null
    }
    const secondMessage = nonSystemMessages[1]
    if (
        firstMessage.getAttribute('data-hapi-message-role') === 'user'
        && secondMessage?.getAttribute('data-hapi-message-role') === 'assistant'
    ) {
        return getMessageAnchorId(secondMessage) || null
    }
    return getMessageAnchorId(firstMessage) || null
}

export function isTopTurnHeadlessAssistant(viewport: HTMLElement): boolean {
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(THREAD_ENTRY_ANCHOR_SELECTOR))
    const firstNonSystem = messages.find(
        (element) => element.getAttribute('data-hapi-message-role') !== 'system'
    )
    return firstNonSystem?.getAttribute('data-hapi-message-role') === 'assistant'
}
export async function loadUntilVisibleBoundaryChanges(options: {
    getVisibleBoundary: () => string | null
    isTopTurnIncomplete?: () => boolean
    hasMoreMessages: () => boolean
    loadOlder: () => Promise<boolean>
    maxPages?: number
}): Promise<boolean> {
    const initialBoundary = options.getVisibleBoundary()
    const maxPages = options.maxPages ?? MAX_VISIBLE_BOUNDARY_LOAD_PAGES
    let loadedAny = false
    let pagesLoaded = 0
    while (
        pagesLoaded < maxPages
        && options.hasMoreMessages()
        && options.getVisibleBoundary() === initialBoundary
    ) {
        const loaded = await options.loadOlder()
        if (!loaded) {
            break
        }
        loadedAny = true
        pagesLoaded += 1
    }
    return loadedAny
}

