import { getConversationMessageAnchorId } from '@/chat/outline'
export type ScrollAnchor = {
    id: string
    topOffset: number
}

export type PendingScrollRestore = {
    runId: number
    anchor: ScrollAnchor | null
    scrollTop: number
    scrollHeight: number
    targetHistoryVersion: number | null
    pinOnRestore?: boolean
}

export type HistoryLoadSource = 'coverage' | 'user' | 'consumer'
export type PullToLoadState = 'idle' | 'pulling' | 'ready'

export type HistoryLoaderState = {
    runId: number
    phase: 'idle' | 'loading' | 'backoff' | 'awaiting-render'
    source: HistoryLoadSource | null
    failureCount: number
    autoPaused: boolean
}

export const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
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

type CapturedAnchorState = {
    height: number
    wasFirstMessage: boolean
    topOffset: number
    consumedPrepend: boolean
}

const capturedAnchorState = new WeakMap<ScrollAnchor, CapturedAnchorState>()

export function captureScrollAnchor(viewport: HTMLElement): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    const firstNonSystemIndex = messages.findIndex(
        (element) => element.getAttribute('data-hapi-message-role') !== 'system'
    )
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!
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
                id: message.id,
                topOffset
            }
            const height = rect.bottom - rect.top
            if (height > 0) {
                capturedAnchorState.set(anchor, {
                    height,
                    wasFirstMessage: index === 0 || index === firstNonSystemIndex,
                    topOffset,
                    consumedPrepend: false
                })
            }
            return anchor
        }
    }
    return null
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = document.getElementById(anchor.id)
    if (!target || !viewport.contains(target)) {
        return false
    }
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const state = capturedAnchorState.get(anchor)
    let effectiveTopOffset = state?.topOffset ?? anchor.topOffset
    if (state && !state.consumedPrepend) {
        state.consumedPrepend = true
        const currentHeight = targetRect.bottom - targetRect.top
        if (state.wasFirstMessage && state.height > 0 && currentHeight > state.height) {
            effectiveTopOffset -= currentHeight - state.height
            state.topOffset = effectiveTopOffset
        }
    }
    viewport.scrollTop += targetRect.top - viewportRect.top - effectiveTopOffset
    return true
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

const MAX_VISIBLE_BOUNDARY_LOAD_PAGES = 4

export function getVisibleTurnBoundaryId(viewport: HTMLElement): string | null {
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
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
        return secondMessage.id
    }
    return firstMessage.id
}

export function isTopTurnHeadlessAssistant(viewport: HTMLElement): boolean {
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
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
        && (
            options.getVisibleBoundary() === initialBoundary
            || (loadedAny && options.isTopTurnIncomplete?.() === true)
        )
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

