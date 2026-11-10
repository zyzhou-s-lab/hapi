import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import {
    applyThreadScrollStatePatch,
    captureScrollAnchor,
    createInitialThreadScrollState,
    INITIAL_SCROLL_SETTLE_MS,
    resolveThreadScrollPhase,
    restoreScrollAnchor,
    shouldFollowTailInScrollPhase,
    transitionScrollModeOnViewportScroll,
    type ThreadScrollPhase,
} from '@/components/AssistantChat/threadScrollHelpers'
import { useThreadScrollAndHistoryController } from '@/components/AssistantChat/useThreadScrollAndHistoryController'
import * as threadViewportEvents from '@/components/AssistantChat/useThreadViewportEvents'
import type { ThreadViewportEventBindings } from '@/components/AssistantChat/useThreadViewportEvents'

type MockResizeObserverRecord = {
    callback: ResizeObserverCallback
    observed: Set<Element>
    disconnected: boolean
}

let resizeObserverRecords: MockResizeObserverRecord[] = []

class MockResizeObserver {
    private readonly record: MockResizeObserverRecord

    constructor(callback: ResizeObserverCallback) {
        this.record = {
            callback,
            observed: new Set(),
            disconnected: false,
        }
        resizeObserverRecords.push(this.record)
    }

    observe(target: Element): void {
        this.record.observed.add(target)
    }

    unobserve(target: Element): void {
        this.record.observed.delete(target)
    }

    disconnect(): void {
        this.record.disconnected = true
        this.record.observed.clear()
    }
}

type TestEntry = {
    id: string
    top: number
    height: number
    childTop?: number
    role?: 'user' | 'assistant' | 'system'
}

type ControllerTestApi = {
    getScrollPhase: () => ThreadScrollPhase
    loadOlderFromConsumer: () => Promise<string>
    scrollToBottom: () => void
    setEntriesAndHistory: (nextEntries: TestEntry[], nextHistoryVersion: number, nextHasMore?: boolean) => void
}

function captureViewportBindings(): () => ThreadViewportEventBindings {
    const useEvents = threadViewportEvents.useThreadViewportEvents
    let bindings!: ThreadViewportEventBindings
    vi.spyOn(threadViewportEvents, 'useThreadViewportEvents').mockImplementation((current) => {
        bindings = current
        useEvents(current)
    })
    return () => bindings
}

function ScrollControllerHarness(props: {
    sessionId?: string
    initialEntries: TestEntry[]
    hasMoreMessages?: boolean
    onViewModeChange?: (mode: 'tail' | 'history') => void
    geometry?: { scrollHeight: number; clientHeight: number }
    onCancelLoadMoreImpl?: () => void
    onLoadMoreImpl?: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    exposeController?: (api: ControllerTestApi) => void
}) {
    const [entries, setEntries] = useState<TestEntry[]>(props.initialEntries)
    const [hasMoreMessages, setHasMoreMessages] = useState(props.hasMoreMessages ?? true)
    const [historyVersion, setHistoryVersion] = useState(1)
    const [messagesVersion, setMessagesVersion] = useState(1)
    const onViewModeChange = props.onViewModeChange ?? (() => undefined)
    const defaultLoadMore = useRef(
        async (onBeforeApply?: (nextHistoryVersion: number) => boolean): Promise<OlderLoadOutcome> => {
            const nextVersion = historyVersion + 1
            onBeforeApply?.(nextVersion)
            return {
                kind: 'applied',
                historyVersion: nextVersion,
                hasMore: false,
                addedRenderableCount: 1,
            }
        }
    )

    const controller = useThreadScrollAndHistoryController({
        sessionId: props.sessionId ?? 'session-1',
        isLoadingMoreMessages: false,
        hasMoreMessages,
        isSyncingTail: false,
        onLoadMore: props.onLoadMoreImpl ?? defaultLoadMore.current,
        onCancelLoadMore: props.onCancelLoadMoreImpl ?? (() => undefined),
        onViewModeChange,
        forceScrollToken: 0,
        rawMessagesCount: entries.length,
        messagesVersion,
        appliedMessagesVersion: messagesVersion,
        appliedHistoryVersion: historyVersion,
        isAwaitingMessagesRender: false,
        isAwaitingHistoryRender: false,
        onOutlineOpenChange: () => undefined,
    })

    props.exposeController?.({
        getScrollPhase: controller.getScrollPhase,
        loadOlderFromConsumer: controller.loadOlderFromConsumer,
        scrollToBottom: controller.scrollToBottom,
        setEntriesAndHistory: (nextEntries, nextHistoryVersion, nextHasMore) => {
            setEntries(nextEntries)
            setHistoryVersion(nextHistoryVersion)
            setMessagesVersion((prev) => prev + 1)
            if (nextHasMore !== undefined) {
                setHasMoreMessages(nextHasMore)
            }
        },
    })

    return (
        <div
            ref={(node) => {
                controller.viewportRef.current = node
                if (!node || !props.geometry) return
                const geometry = props.geometry
                Object.defineProperties(node, {
                    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
                    clientHeight: { configurable: true, get: () => geometry.clientHeight },
                })
                node.getBoundingClientRect = () => DOMRect.fromRect({ width: 640, height: geometry.clientHeight })
            }}
            data-testid="thread-viewport"
            className="app-scroll-y"
        >
            <div ref={controller.contentRef} data-testid="thread-content" className="chat-scroll-content">
                <div
                    ref={(node) => {
                        controller.topSentinelRef.current = node
                        if (!node || !props.geometry) return
                        node.getBoundingClientRect = () => DOMRect.fromRect({
                            y: -(controller.viewportRef.current?.scrollTop ?? 0), width: 640, height: 1,
                        })
                    }}
                    data-testid="thread-top-sentinel"
                    aria-hidden="true"
                />
                <div className="happy-thread-messages">
                    {entries.map((entry) => (
                        <div
                            key={entry.id}
                            data-testid={`entry-${entry.id}`}
                            data-thread-entry-id={entry.id}
                            data-message-id={entry.id}
                            data-hapi-message-role={entry.role ?? 'user'}
                            ref={(node) => {
                                if (!node) return
                                node.getBoundingClientRect = () => {
                                    const viewport = controller.viewportRef.current
                                    const scrollTop = viewport?.scrollTop ?? 0
                                    return DOMRect.fromRect({
                                        x: 0,
                                        y: entry.top - scrollTop,
                                        width: 640,
                                        height: entry.height,
                                    })
                                }
                            }}
                        >
                            <div
                                data-block-id={`block-${entry.id}`}
                                ref={(node) => {
                                    if (!node) return
                                    node.getBoundingClientRect = () => DOMRect.fromRect({
                                        y: entry.top + (entry.childTop ?? 0) - (controller.viewportRef.current?.scrollTop ?? 0),
                                        width: 640,
                                        height: Math.min(100, entry.height),
                                    })
                                }}
                            >
                                {entry.id}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}

describe('useThreadScrollAndHistoryController & ThreadScrollPhase state machine', () => {
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

    beforeEach(() => {
        resizeObserverRecords = []
        vi.stubGlobal('ResizeObserver', MockResizeObserver)
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            writable: true,
            value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
                const requestedTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0)
                const maxTop = Math.max(0, this.scrollHeight - this.clientHeight)
                this.scrollTop = Math.min(Math.max(0, requestedTop), maxTop)
            },
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        if (originalScrollTo) {
            Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
        } else {
            Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
        }
    })

    it('resolves ThreadScrollPhase deterministically across INITIAL_PINNING, PINNED_FOLLOW, USER_SCROLLED, and PREPENDING_HISTORY', () => {
        const initial = createInitialThreadScrollState(0)
        expect(initial.phase).toBe('INITIAL_PINNING')
        expect(initial.mode).toBe('tail-follow')
        expect(shouldFollowTailInScrollPhase(initial.phase)).toBe(true)

        const settled = applyThreadScrollStatePatch(initial, { isInitialPinning: false })
        expect(settled.phase).toBe('PINNED_FOLLOW')
        expect(settled.mode).toBe('tail-follow')
        expect(shouldFollowTailInScrollPhase(settled.phase)).toBe(true)

        const scrolledUp = applyThreadScrollStatePatch(settled, {
            autoScrollEnabled: false,
            atBottom: false,
            lastScrollTop: 180,
        })
        expect(scrolledUp.phase).toBe('USER_SCROLLED')
        expect(scrolledUp.mode).toBe('user-reading')
        expect(shouldFollowTailInScrollPhase(scrolledUp.phase)).toBe(false)

        const prepending = applyThreadScrollStatePatch(scrolledUp, {
            pendingRestore: {
                runId: 1,
                sessionId: 'session-1',
                anchor: { id: 'msg-10', topOffset: 24 },
                targetHistoryVersion: 2,
            },
        })
        expect(prepending.phase).toBe('PREPENDING_HISTORY')
        expect(prepending.mode).toBe('pagination-restore')
        expect(shouldFollowTailInScrollPhase(prepending.phase)).toBe(false)

        const postPrependReading = applyThreadScrollStatePatch(prepending, {
            pendingRestore: null,
        })
        expect(postPrependReading.phase).toBe('USER_SCROLLED')

        const backAtBottom = applyThreadScrollStatePatch(postPrependReading, {
            autoScrollEnabled: true,
            atBottom: true,
        })
        expect(backAtBottom.phase).toBe('PINNED_FOLLOW')
        expect(
            resolveThreadScrollPhase({
                autoScrollEnabled: true,
                atBottom: true,
                hasPendingRestore: false,
                isInitialPinning: true,
            })
        ).toBe('INITIAL_PINNING')

        const cancelledTransition = transitionScrollModeOnViewportScroll({
            intent: {
                distanceFromBottom: 240,
                isNearBottom: false,
                isScrollingUp: true,
            },
            isInitialSettling: true,
            hadExplicitUpwardIntent: true,
            tailScrollInProgress: false,
            needsCoverage: false,
            hasPendingRestore: false,
        })
        expect(cancelledTransition.nextPhase).toBe('USER_SCROLLED')
        expect(cancelledTransition.cancelInitialSettling).toBe(true)
    })

    it('pins to bottom via ResizeObserver during INITIAL_PINNING, cancels on upward user wheel, and disconnects observers on unmount', () => {
        const onViewModeChange = vi.fn()
        let controllerApi = null as ControllerTestApi | null

        let scrollHeight = 1_200
        const clientHeight = 400
        const scrollHeightSpy = vi
            .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
            .mockImplementation(() => scrollHeight)
        const clientHeightSpy = vi
            .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
            .mockImplementation(() => clientHeight)
        const scrollToSpy = vi
            .spyOn(HTMLElement.prototype, 'scrollTo')
            .mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
                const requestedTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0)
                const maxTop = Math.max(0, this.scrollHeight - this.clientHeight)
                this.scrollTop = Math.min(requestedTop, maxTop)
            })

        try {
            const { unmount } = render(
                <ScrollControllerHarness
                    initialEntries={[
                        { id: 'msg-1', top: 0, height: 600 },
                        { id: 'msg-2', top: 600, height: 600 },
                    ]}
                    hasMoreMessages={false}
                    onViewModeChange={onViewModeChange}
                    exposeController={(api) => {
                        controllerApi = api
                    }}
                />
            )

            const viewport = screen.getByTestId('thread-viewport')
            expect(viewport.scrollTop).toBe(800)
            expect(controllerApi?.getScrollPhase()).toBe('INITIAL_PINNING')
            expect(onViewModeChange).toHaveBeenLastCalledWith('tail')

            // Async content growth reported by ResizeObserver while in INITIAL_PINNING keeps viewport pinned to bottom.
            scrollHeight = 1_650
            act(() => {
                for (const record of resizeObserverRecords) {
                    if (!record.disconnected && record.observed.size > 0) {
                        record.callback([], {} as ResizeObserver)
                    }
                }
            })
            expect(viewport.scrollTop).toBe(1_250)
            expect(controllerApi?.getScrollPhase()).toBe('INITIAL_PINNING')

            // Upward user wheel gesture immediately cancels INITIAL_PINNING and transitions to USER_SCROLLED.
            viewport.scrollTop = 900
            fireEvent.wheel(viewport, { deltaY: -120 })
            expect(controllerApi?.getScrollPhase()).toBe('USER_SCROLLED')
            expect(onViewModeChange).toHaveBeenLastCalledWith('history')

            // Subsequent ResizeObserver notifications do not snap the user back to the bottom.
            scrollHeight = 2_000
            act(() => {
                for (const record of resizeObserverRecords) {
                    if (!record.disconnected && record.observed.size > 0) {
                        record.callback([], {} as ResizeObserver)
                    }
                }
            })
            expect(viewport.scrollTop).toBe(900)

            unmount()
            expect(resizeObserverRecords.length).toBeGreaterThan(0)
            expect(resizeObserverRecords.every((record) => record.disconnected)).toBe(true)
        } finally {
            scrollHeightSpy.mockRestore()
            clientHeightSpy.mockRestore()
            scrollToSpy.mockRestore()
        }
    })

    it('transitions from INITIAL_PINNING to PINNED_FOLLOW after the initial settle window while continuing to follow tail growth', () => {
        let now = 1_000
        const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
        let scrollHeight = 1_000
        const clientHeight = 300
        const scrollHeightSpy = vi
            .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
            .mockImplementation(() => scrollHeight)
        const clientHeightSpy = vi
            .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
            .mockImplementation(() => clientHeight)
        const scrollToSpy = vi
            .spyOn(HTMLElement.prototype, 'scrollTo')
            .mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
                const requestedTop = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0)
                const maxTop = Math.max(0, this.scrollHeight - this.clientHeight)
                this.scrollTop = Math.min(requestedTop, maxTop)
            })

        let controllerApi = null as ControllerTestApi | null

        try {
            render(
                <ScrollControllerHarness
                    initialEntries={[{ id: 'msg-1', top: 0, height: 1_000 }]}
                    hasMoreMessages={false}
                    exposeController={(api) => {
                        controllerApi = api
                    }}
                />
            )

            const viewport = screen.getByTestId('thread-viewport')
            expect(viewport.scrollTop).toBe(700)
            expect(controllerApi?.getScrollPhase()).toBe('INITIAL_PINNING')

            now += INITIAL_SCROLL_SETTLE_MS + 10
            scrollHeight = 1_300
            act(() => {
                for (const record of resizeObserverRecords) {
                    if (!record.disconnected && record.observed.size > 0) {
                        record.callback([], {} as ResizeObserver)
                    }
                }
            })

            expect(controllerApi?.getScrollPhase()).toBe('PINNED_FOLLOW')
            expect(viewport.scrollTop).toBe(1_000)
        } finally {
            dateNowSpy.mockRestore()
            scrollHeightSpy.mockRestore()
            clientHeightSpy.mockRestore()
            scrollToSpy.mockRestore()
        }
    })

    it('restores prepend scroll position from [data-thread-entry-id] getBoundingClientRect().top delta with overflowAnchor guard even when tail height changes concurrently', async () => {
        let controllerApi = null as ControllerTestApi | null

        let observedOverflowAnchorDuringBeforeApply: string | null = null
        let observedPhaseDuringBeforeApply: ThreadScrollPhase | null = null
        let scrollHeight = 1_400

        render(
            <ScrollControllerHarness
                initialEntries={[
                    { id: 'entry-10', top: 0, height: 400, role: 'user' },
                    { id: 'entry-11', top: 400, height: 500, role: 'assistant' },
                    { id: 'entry-12', top: 900, height: 500, role: 'assistant' },
                ]}
                hasMoreMessages={true}
                onLoadMoreImpl={async (onBeforeApply) => {
                    const accepted = onBeforeApply?.(2) ?? false
                    expect(accepted).toBe(true)
                    const viewport = screen.getByTestId('thread-viewport')
                    observedOverflowAnchorDuringBeforeApply = viewport.style.overflowAnchor
                    observedPhaseDuringBeforeApply = controllerApi?.getScrollPhase() ?? null

                    // Prepend 2 older entries (total height +360px above entry-10),
                    // AND simulate concurrent streaming tail growth (+500px on entry-12) so total scrollHeight
                    // grows by +860px while entry-10 shifts down by only +360px.
                    scrollHeight = 2_260
                    controllerApi?.setEntriesAndHistory(
                        [
                            { id: 'entry-8', top: 0, height: 160, role: 'user' },
                            { id: 'entry-9', top: 160, height: 200, role: 'assistant' },
                            { id: 'entry-10', top: 360, height: 400, role: 'user' },
                            { id: 'entry-11', top: 760, height: 500, role: 'assistant' },
                            { id: 'entry-12', top: 1_260, height: 1_000, role: 'assistant' },
                        ],
                        2,
                        false
                    )
                    return {
                        kind: 'applied',
                        historyVersion: 2,
                        hasMore: false,
                        addedRenderableCount: 2,
                    }
                }}
                exposeController={(api) => {
                    controllerApi = api
                }}
            />
        )

        const viewport = screen.getByTestId('thread-viewport')
        const sentinel = screen.getByTestId('thread-top-sentinel')
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 })
        Object.defineProperty(viewport, 'scrollHeight', {
            configurable: true,
            get: () => scrollHeight,
        })
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 500 })
        // User scrolls up to read near the top with entry-10 partially scrolled (scrollTop = 120 -> entry-10 topOffset = -120).
        sentinel.getBoundingClientRect = () =>
            DOMRect.fromRect({ x: 0, y: -1_000, width: 640, height: 1 })
        viewport.style.overflowAnchor = 'auto'
        viewport.scrollTop = 120
        fireEvent.wheel(viewport, { deltaY: -80 })
        sentinel.getBoundingClientRect = () =>
            DOMRect.fromRect({ x: 0, y: -viewport.scrollTop, width: 640, height: 1 })
        let loadPromise: Promise<string> | undefined
        await act(async () => {
            loadPromise = controllerApi?.loadOlderFromConsumer()
        })
        const loadResult = (await loadPromise) ?? null

        expect(loadResult).toBe('loaded')
        expect(observedOverflowAnchorDuringBeforeApply).toBe('none')
        expect(observedPhaseDuringBeforeApply).toBe('PREPENDING_HISTORY')
        // Restored via entry-10's getBoundingClientRect().top delta (120 + 360 = 480), NOT scrollHeight delta (120 + 860 = 980).
        expect(viewport.scrollTop).toBe(480)
        // Inline overflowAnchor is restored after prepend layout effect finishes.
        expect(viewport.style.overflowAnchor).toBe('auto')
        expect(controllerApi?.getScrollPhase()).toBe('USER_SCROLLED')
    })

    it('requests exactly one underfilled coverage page at the initial deadline without scroll or resize', async () => {
        vi.useFakeTimers()
        const onLoadMore = vi.fn(async (): Promise<OlderLoadOutcome> => ({ kind: 'stopped', reason: 'exhausted' }))
        const view = render(<ScrollControllerHarness
            initialEntries={[{ id: 'short', top: 0, height: 300 }]}
            geometry={{ scrollHeight: 300, clientHeight: 500 }}
            onLoadMoreImpl={onLoadMore}
        />)
        await act(async () => { vi.advanceTimersByTime(INITIAL_SCROLL_SETTLE_MS - 1) })
        expect(onLoadMore).not.toHaveBeenCalled()
        await act(async () => { vi.advanceTimersByTime(1) })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        await act(async () => { vi.advanceTimersByTime(INITIAL_SCROLL_SETTLE_MS * 2) })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        view.unmount()
    })

    it.each(['wheel', 'session', 'unmount'] as const)('cancels the captured deadline callback on %s', async (cancel) => {
        vi.useFakeTimers()
        const getBindings = captureViewportBindings()
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
        const onLoadMore = vi.fn(async (): Promise<OlderLoadOutcome> => ({ kind: 'stopped', reason: 'exhausted' }))
        const geometry = { scrollHeight: 300, clientHeight: 500 }
        const harnessProps = {
            initialEntries: [{ id: 'short', top: 0, height: 300 }],
            geometry,
            onLoadMoreImpl: onLoadMore,
        }
        const view = render(<ScrollControllerHarness {...harnessProps} sessionId="old-session" />)
        const timer = getBindings().historyLoaderRef.current.coverageCheckTimer
        const timerIndex = setTimeoutSpy.mock.results.findIndex((result) => result.value === timer)
        const oldCallback = setTimeoutSpy.mock.calls[timerIndex]![0] as () => void
        await act(async () => { vi.advanceTimersByTime(600) })
        if (cancel === 'wheel') {
            // Keep this gesture outside coverage so the assertion isolates deadline demand.
            geometry.scrollHeight = 1200
            screen.getByTestId('thread-viewport').scrollTop = 700
            fireEvent.wheel(screen.getByTestId('thread-viewport'), { deltaY: -80 })
            geometry.scrollHeight = 300
        } else if (cancel === 'session') {
            view.rerender(<ScrollControllerHarness {...harnessProps} sessionId="new-session" />)
        } else {
            view.unmount()
        }
        await act(async () => {
            oldCallback()
            vi.advanceTimersByTime(INITIAL_SCROLL_SETTLE_MS - 600)
        })
        expect(onLoadMore).not.toHaveBeenCalled()
        if (cancel === 'session') {
            await act(async () => { vi.advanceTimersByTime(600) })
            expect(onLoadMore).toHaveBeenCalledTimes(1)
        } else if (cancel === 'wheel') {
            expect(getBindings().scrollStateRef.current.phase).toBe('USER_SCROLLED')
        }
        view.unmount()
    })

    it.each(['covered', 'paused', 'loading', 'backoff', 'awaiting-render', 'pending'] as const)(
        'does not submit deadline coverage when %s', async (condition) => {
            vi.useFakeTimers()
            const getBindings = captureViewportBindings()
            const geometry = { scrollHeight: 1200, clientHeight: 500 }
            const onLoadMore = vi.fn(async (): Promise<OlderLoadOutcome> => ({ kind: 'stopped', reason: 'exhausted' }))
            const view = render(<ScrollControllerHarness
                initialEntries={[{ id: 'entry', top: 0, height: 1200 }]}
                geometry={geometry}
                onLoadMoreImpl={onLoadMore}
            />)
            const bindings = getBindings()
            if (condition !== 'covered') geometry.scrollHeight = 300
            if (condition === 'paused') bindings.historyLoaderRef.current.autoPaused = true
            if (condition === 'loading' || condition === 'backoff' || condition === 'awaiting-render') {
                bindings.historyLoaderRef.current.phase = condition
            }
            if (condition === 'pending') {
                bindings.scrollStateRef.current.pendingRestore = {
                    runId: bindings.historyLoaderRef.current.runId,
                    sessionId: 'session-1', anchor: null, targetHistoryVersion: null,
                }
            }
            await act(async () => { vi.advanceTimersByTime(INITIAL_SCROLL_SETTLE_MS) })
            expect(onLoadMore).not.toHaveBeenCalled()
            expect(bindings.scrollStateRef.current.phase).toBe(condition === 'pending' ? 'PREPENDING_HISTORY' : 'PINNED_FOLLOW')
            if (condition === 'covered') expect(screen.getByTestId('thread-viewport').scrollTop).toBe(700)
            view.unmount()
        }
    )

    it('keeps the existing failure backoff exclusive after the deadline wakeup', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const onLoadMore = vi.fn(async (): Promise<OlderLoadOutcome> => ({ kind: 'failed', error: new Error('offline') }))
        const view = render(<ScrollControllerHarness
            initialEntries={[{ id: 'short', top: 0, height: 300 }]}
            geometry={{ scrollHeight: 300, clientHeight: 500 }}
            onLoadMoreImpl={onLoadMore}
        />)
        await act(async () => { vi.advanceTimersByTime(INITIAL_SCROLL_SETTLE_MS) })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        await act(async () => { vi.advanceTimersByTime(999) })
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        await act(async () => { vi.advanceTimersByTime(1) })
        expect(onLoadMore).toHaveBeenCalledTimes(2)
        view.unmount()
        await act(async () => { vi.advanceTimersByTime(10_000) })
        expect(onLoadMore).toHaveBeenCalledTimes(2)
    })

    it('uses tail-follow facts while pendingRestore still masks the scroll mode', async () => {
        const getBindings = captureViewportBindings()
        let api = null as ControllerTestApi | null
        const geometry = { scrollHeight: 1200, clientHeight: 500 }
        const view = render(<ScrollControllerHarness
            initialEntries={[{ id: 'entry', top: 0, height: 1200, childTop: 120 }]}
            geometry={geometry}
            exposeController={(current) => { api = current }}
        />)
        const viewport = screen.getByTestId('thread-viewport')
        viewport.style.overflowAnchor = 'auto'
        viewport.scrollTop = 100
        fireEvent.wheel(viewport, { deltaY: -80 })
        let result: Promise<string> | undefined
        await act(async () => { result = api?.loadOlderFromConsumer() })
        act(() => { api?.scrollToBottom() })
        expect(getBindings().scrollStateRef.current.mode).toBe('pagination-restore')
        expect(getBindings().scrollStateRef.current.autoScrollEnabled).toBe(true)
        expect(getBindings().scrollStateRef.current.atBottom).toBe(true)
        const writeScrollTop = vi.spyOn(viewport, 'scrollTop', 'set')
        geometry.scrollHeight = 2000
        act(() => { api?.setEntriesAndHistory([{ id: 'entry', top: 600, height: 1400, childTop: 400 }], 2, false) })
        expect(await result).toBe('loaded')
        expect(writeScrollTop).toHaveBeenCalledTimes(1)
        expect(writeScrollTop).toHaveBeenCalledWith(1500)
        expect(viewport.scrollTop).toBe(1500)
        expect(viewport.style.overflowAnchor).toBe('auto')
        expect(getBindings().scrollStateRef.current.pendingRestore).toBeNull()
        expect(getBindings().historyLoaderRef.current.phase).toBe('idle')
        view.unmount()
    })

    it.each(['missing', 'uncaptured'] as const)('settles a current %s anchor without any fallback scroll write', async (anchorCase) => {
        const getBindings = captureViewportBindings()
        let api = null as ControllerTestApi | null
        const geometry = { scrollHeight: 1200, clientHeight: 500 }
        const view = render(<ScrollControllerHarness
            initialEntries={[{ id: 'entry', top: 0, height: 1200 }]}
            geometry={geometry}
            exposeController={(current) => { api = current }}
        />)
        const viewport = screen.getByTestId('thread-viewport')
        viewport.style.overflowAnchor = 'auto'
        viewport.scrollTop = 100
        fireEvent.wheel(viewport, { deltaY: -80 })
        let result: Promise<string> | undefined
        await act(async () => { result = api?.loadOlderFromConsumer() })
        if (anchorCase === 'uncaptured') getBindings().scrollStateRef.current.pendingRestore!.anchor = null
        const writeScrollTop = vi.spyOn(viewport, 'scrollTop', 'set')
        geometry.scrollHeight = 2000
        act(() => { api?.setEntriesAndHistory([{ id: 'replacement', top: 0, height: 2000 }], 2, false) })
        expect(await result).toBe('loaded')
        expect(writeScrollTop).not.toHaveBeenCalled()
        expect(viewport.scrollTop).toBe(100)
        expect(viewport.style.overflowAnchor).toBe('auto')
        expect(getBindings().scrollStateRef.current.pendingRestore).toBeNull()
        expect(getBindings().historyLoaderRef.current.phase).toBe('idle')
        view.unmount()
    })

    it.each(['stale-run', 'cancelled', 'stale-session'] as const)('discards %s restoration before geometry writes', async (stale) => {
        const getBindings = captureViewportBindings()
        let api = null as ControllerTestApi | null
        const geometry = { scrollHeight: 1200, clientHeight: 500 }
        const view = render(<ScrollControllerHarness
            initialEntries={[{ id: 'entry', top: 0, height: 1200 }]}
            geometry={geometry}
            exposeController={(current) => { api = current }}
        />)
        const viewport = screen.getByTestId('thread-viewport')
        viewport.style.overflowAnchor = 'auto'
        viewport.scrollTop = 100
        fireEvent.wheel(viewport, { deltaY: -80 })
        await act(async () => { void api?.loadOlderFromConsumer() })
        const bindings = getBindings()
        if (stale === 'stale-run') bindings.historyLoaderRef.current.runId += 1
        if (stale === 'cancelled') bindings.historyLoaderRef.current.phase = 'idle'
        if (stale === 'stale-session') bindings.scrollStateRef.current.pendingRestore!.sessionId = 'old-session'
        const expectedRun = bindings.historyLoaderRef.current.runId
        const expectedPhase = bindings.historyLoaderRef.current.phase
        const writeScrollTop = vi.spyOn(viewport, 'scrollTop', 'set')
        geometry.scrollHeight = 2000
        act(() => { api?.setEntriesAndHistory([{ id: 'entry', top: 600, height: 1400 }], 2, false) })
        expect(writeScrollTop).not.toHaveBeenCalled()
        expect(viewport.scrollTop).toBe(100)
        expect(viewport.style.overflowAnchor).toBe('auto')
        expect(bindings.scrollStateRef.current.pendingRestore).toBeNull()
        expect(bindings.historyLoaderRef.current.runId).toBe(expectedRun)
        expect(bindings.historyLoaderRef.current.phase).toBe(expectedPhase)
        view.unmount()
    })

    it('supports captureScrollAnchor and restoreScrollAnchor for [data-thread-entry-id] elements without id attributes', () => {
        const viewport = document.createElement('div')
        viewport.style.overflowAnchor = 'auto'
        viewport.scrollTop = 50
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 400 })

        const item = document.createElement('div')
        item.setAttribute('data-thread-entry-id', 'turn-entry-42')
        let itemTop = 30
        item.getBoundingClientRect = () =>
            DOMRect.fromRect({ x: 0, y: itemTop - viewport.scrollTop, width: 600, height: 180 })
        viewport.appendChild(item)
        document.body.appendChild(viewport)

        try {
            const anchor = captureScrollAnchor(viewport)
            expect(anchor).toEqual({
                id: 'turn-entry-42',
                topOffset: -20,
            })

            // Prepend 250px above item
            itemTop = 280
            const restored = restoreScrollAnchor(viewport, anchor!)
            expect(restored).toBe(true)
            expect(viewport.scrollTop).toBe(300)
            expect(viewport.style.overflowAnchor).toBe('auto')
        } finally {
            viewport.remove()
        }
    })
})
