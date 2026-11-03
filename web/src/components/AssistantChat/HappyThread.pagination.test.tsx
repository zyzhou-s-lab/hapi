import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '@/api/client'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { I18nProvider } from '@/lib/i18n-context'
import type { Session } from '@/types/api'
import type { OlderLoadOutcome } from '@/lib/message-window-store'

vi.mock('@assistant-ui/react', () => ({
    ThreadPrimitive: {
        Root: ({ children }: PropsWithChildren) => <div>{children}</div>,
        Viewport: ({ children }: PropsWithChildren) => <>{children}</>,
        Messages: () => <div id="stable-visible-message" data-testid="stable-visible-message" />,
        Unstable_MessageById: () => <div id="stable-visible-message" data-testid="stable-visible-message" />,
    },
    useAuiState<T>(selector: (state: { thread: { extras: undefined } }) => T): T {
        return selector({ thread: { extras: undefined } })
    },
    unstable_useThreadMessageIds: (): string[] => ['stable-visible-message'],
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({
        machines: [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
}))

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value(this: HTMLElement, options: ScrollToOptions) {
            if (typeof options.top === 'number') {
                this.scrollTop = options.top
            }
        },
    })
})

afterAll(() => {
    if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor)
        return
    }
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

const api = new ApiClient('test-token')
vi.spyOn(api, 'getHubSettings').mockResolvedValue({
    sessionSummaryContract: false,
    sessionSummaryInChat: false
})
const session: Session = {
    id: 'pagination-session',
    namespace: 'default',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: null,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    model: null,
    modelReasoningEffort: null,
    effort: null,
    serviceTier: null,
    resumeWithSessionModel: false,
}


function PaginationHarness(props: { onRequest: () => void }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const [committedPageCount, setCommittedPageCount] = useState(0)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const pendingResolveRef = useRef<((outcome: OlderLoadOutcome) => void) | null>(null)
    const pendingBeforeApplyRef = useRef<((historyVersion: number) => boolean) | null>(null)

    const onLoadMore = useCallback((onBeforeApply?: (historyVersion: number) => boolean) => {
        props.onRequest()
        pendingBeforeApplyRef.current = onBeforeApply ?? null
        setIsLoadingMore(true)
        return new Promise<OlderLoadOutcome>((resolve) => {
            pendingResolveRef.current = resolve
        })
    }, [props.onRequest])

    useEffect(() => {
        if (!isLoadingMore) return

        const historyVersion = committedPageCount + 1
        const shouldApply = pendingBeforeApplyRef.current?.(historyVersion) ?? true
        pendingBeforeApplyRef.current = null
        setIsLoadingMore(false)
        if (!shouldApply) {
            pendingResolveRef.current?.({ kind: 'stopped', reason: 'invalidated' })
            pendingResolveRef.current = null
            return
        }
        setCommittedPageCount(historyVersion)
        pendingResolveRef.current?.({
            kind: 'applied',
            historyVersion,
            hasMore: historyVersion < 3,
            addedRenderableCount: 1
        })
        pendingResolveRef.current = null
    }, [committedPageCount, isLoadingMore])

    return (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <output data-testid="page">{committedPageCount}</output>
                <HappyThread
                    api={api}
                    session={session}
                    sessionId="pagination-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={() => undefined}
                    messagesWarning={null}
                    hasMoreMessages={committedPageCount < 3}
                    isLoadingMoreMessages={isLoadingMore}
                    onLoadMore={onLoadMore}
                    onCancelLoadMore={() => undefined}
                    onViewModeChange={() => undefined}
                    isSyncingTail={false}
                    unseenCount={0}
                    rawMessagesCount={1}
                    normalizedMessagesCount={1}
                    messagesVersion={committedPageCount}
                    historyVersion={committedPageCount}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={() => undefined}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('HappyThread older-history pagination lifecycle', () => {
    it('continues loading after each committed page until hidden history is exhausted', async () => {
        const onRequest = vi.fn()
        render(<PaginationHarness onRequest={onRequest} />)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')
        if (!viewport) {
            throw new Error('Message viewport was not rendered')
        }
        const anchor = screen.getByTestId('stable-visible-message')
        const pageCountOutput = screen.getByTestId('page')
        Object.defineProperty(viewport, 'clientHeight', {
            configurable: true,
            value: 104,
        })
        Object.defineProperty(viewport, 'scrollHeight', {
            configurable: true,
            get: () => pageCountOutput.textContent === '3' ? 205 : 171,
        })
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ height: 104, width: 400 })
        anchor.getBoundingClientRect = () => {
            const insertedHeight = pageCountOutput.textContent === '3' ? 34 : 0
            return DOMRect.fromRect({
                y: 61 + insertedHeight - viewport.scrollTop,
                height: 20,
                width: 100,
            })
        }
        viewport.scrollTop = 0

        fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))

        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(3))
        await waitFor(() => expect(viewport.scrollTop).toBe(34))
        expect(anchor.getBoundingClientRect().top).toBe(61)
        expect(screen.queryByRole('button', { name: 'Load earlier' })).not.toBeInTheDocument()
    })

    it('keeps the anchor at 305px on the final 1.5s-delayed wheel page when hasMore becomes false', async () => {
        let now = 1_000
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
        try {
            const onRequest = vi.fn()
            const controls: {
                resolvePage: ((outcome: OlderLoadOutcome) => void) | null
                beforeApply: ((historyVersion: number) => boolean) | null
            } = {
                resolvePage: null,
                beforeApply: null,
            }

            function DelayedFinalPageHarness() {
                const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
                const [page, setPage] = useState(2)
                const [isLoadingMore, setIsLoadingMore] = useState(false)
                const onLoadMore = useCallback((onBeforeApply?: (historyVersion: number) => boolean) => {
                    onRequest()
                    controls.beforeApply = onBeforeApply ?? null
                    setIsLoadingMore(true)
                    const { promise, resolve } = Promise.withResolvers<OlderLoadOutcome>()
                    controls.resolvePage = (outcome) => {
                        setIsLoadingMore(false)
                        if (outcome.kind === 'applied') {
                            setPage(outcome.historyVersion)
                        }
                        resolve(outcome)
                    }
                    return promise
                }, [])

                return (
                    <QueryClientProvider client={queryClient}>
                        <I18nProvider>
                            <output data-testid="delayed-page">{page}</output>
                            <HappyThread
                                api={api}
                                session={session}
                                sessionId="pagination-session"
                                metadata={null}
                                disabled={false}
                                onRefresh={() => undefined}
                                messagesWarning={null}
                                hasMoreMessages={page < 3}
                                isLoadingMoreMessages={isLoadingMore}
                                onLoadMore={onLoadMore}
                                onCancelLoadMore={() => undefined}
                                onViewModeChange={() => undefined}
                                isSyncingTail={false}
                                unseenCount={0}
                                rawMessagesCount={1}
                                normalizedMessagesCount={1}
                                messagesVersion={page}
                                historyVersion={page}
                                forceScrollToken={0}
                                outlineOpen={false}
                                outlineItems={[]}
                                onOutlineOpenChange={() => undefined}
                            />
                        </I18nProvider>
                    </QueryClientProvider>
                )
            }

            render(<DelayedFinalPageHarness />)
            const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
            const anchor = screen.getByTestId('stable-visible-message')
            const pageOut = screen.getByTestId('delayed-page')
            Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 900 })
            Object.defineProperty(viewport, 'scrollHeight', {
                configurable: true,
                get: () => pageOut.textContent === '3' ? 3_486 : 3_000,
            })
            viewport.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, height: 900, width: 800 })
            anchor.getBoundingClientRect = () => {
                const prepended = pageOut.textContent === '3' ? 486 : 0
                return DOMRect.fromRect({
                    y: 305 + prepended - viewport.scrollTop,
                    height: 162,
                    width: 600,
                })
            }
            viewport.scrollTop = 0
            expect(anchor.getBoundingClientRect().top).toBe(305)

            fireEvent.wheel(viewport, { deltaY: -486 })
            await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))

            // 1.5s network delay: past the 250ms wheel gesture gap before the final page resolves.
            now += 1_500
            expect(controls.beforeApply?.(3)).toBe(true)
            controls.resolvePage?.({
                kind: 'applied',
                historyVersion: 3,
                hasMore: false,
                addedRenderableCount: 3,
            })

            await waitFor(() => expect(pageOut.textContent).toBe('3'))
            expect(viewport.scrollTop).toBe(486)
            expect(anchor.getBoundingClientRect().top).toBe(305)

            // A leftover upward wheel event immediately after the final page restore must be suppressed.
            const tailWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -486 })
            viewport.dispatchEvent(tailWheel)
            expect(tailWheel.defaultPrevented).toBe(true)
            expect(anchor.getBoundingClientRect().top).toBe(305)
        } finally {
            nowSpy.mockRestore()
        }
    })

    it('does not load older messages when PageUp or Home is pressed inside an unmarked scrollable tool result', async () => {
        const onRequest = vi.fn()
        render(<PaginationHarness onRequest={onRequest} />)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
        const anchor = screen.getByTestId('stable-visible-message')
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 })
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2_000 })
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, height: 600, width: 800 })
        viewport.scrollTop = 0

        const toolResultScroller = document.createElement('div')
        toolResultScroller.className = 'mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto'
        Object.defineProperties(toolResultScroller, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, value: 600 }
        })
        const codeBlock = document.createElement('pre')
        codeBlock.textContent = 'longlog.ts contents'
        toolResultScroller.append(codeBlock)
        anchor.append(toolResultScroller)

        toolResultScroller.scrollTop = 300
        viewport.scrollTop = 500

        const pageUpOnCode = new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })
        codeBlock.dispatchEvent(pageUpOnCode)
        expect(pageUpOnCode.defaultPrevented).toBe(true)
        expect(toolResultScroller.scrollTop).toBe(120)
        expect(viewport.scrollTop).toBe(500)

        const homeOnCode = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
        codeBlock.dispatchEvent(homeOnCode)
        expect(homeOnCode.defaultPrevented).toBe(true)
        expect(toolResultScroller.scrollTop).toBe(0)
        expect(viewport.scrollTop).toBe(500)

        fireEvent.pointerDown(codeBlock, { button: 0 })
        const pageUpOnViewport = new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })
        viewport.dispatchEvent(pageUpOnViewport)
        expect(pageUpOnViewport.defaultPrevented).toBe(true)

        const homeOnBody = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
        document.body.dispatchEvent(homeOnBody)
        expect(homeOnBody.defaultPrevented).toBe(true)
        expect(viewport.scrollTop).toBe(500)

        // Clicking outside the viewport clears nestedScrollFocused so window keys are no longer intercepted.
        const outsideButton = document.createElement('button')
        document.body.append(outsideButton)
        fireEvent.pointerDown(outsideButton, { button: 0, clientX: 950, clientY: 50 })
        const spaceAfterOutsideClick = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
        document.body.dispatchEvent(spaceAfterOutsideClick)
        expect(spaceAfterOutsideClick.defaultPrevented).toBe(false)
        outsideButton.remove()

        expect(onRequest).not.toHaveBeenCalled()
    })

    it('loads older messages on upward wheel over a wide overflow-x-auto code block and on PageUp/Home after clicking it', async () => {
        const onRequest = vi.fn()
        render(<PaginationHarness onRequest={onRequest} />)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
        const anchor = screen.getByTestId('stable-visible-message')
        const pageCountOutput = screen.getByTestId('page')
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 })
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 1_200 })
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, height: 400, width: 800 })
        anchor.getBoundingClientRect = () => DOMRect.fromRect({ y: 60, height: 20, width: 100 })
        viewport.scrollTop = 0

        const wideCodeBlock = document.createElement('div')
        wideCodeBlock.className = 'overflow-x-auto'
        Object.defineProperties(wideCodeBlock, {
            clientWidth: { configurable: true, value: 400 },
            scrollWidth: { configurable: true, value: 1_200 },
            clientHeight: { configurable: true, value: 80 },
            scrollHeight: { configurable: true, value: 80 }
        })
        const codeToken = document.createElement('code')
        codeToken.textContent = 'const horizontalOnly = true'
        wideCodeBlock.append(codeToken)

        const shortDiff = document.createElement('div')
        shortDiff.dataset.hapiNestedScroll = 'true'
        shortDiff.className = 'mt-3 max-h-[75vh] overflow-auto'
        Object.defineProperties(shortDiff, {
            clientHeight: { configurable: true, value: 80 },
            scrollHeight: { configurable: true, value: 80 }
        })
        anchor.append(wideCodeBlock, shortDiff)

        fireEvent.wheel(codeToken, { deltaY: -120 })
        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(pageCountOutput.textContent).toBe('1'))

        viewport.scrollTop = 0
        fireEvent.pointerDown(codeToken, { button: 0 })
        fireEvent.keyDown(viewport, { key: 'PageUp' })
        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(pageCountOutput.textContent).toBe('2'))

        viewport.scrollTop = 0
        fireEvent.pointerDown(shortDiff, { button: 0 })
        fireEvent.keyDown(viewport, { key: 'Home' })
        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(3))
        await waitFor(() => expect(pageCountOutput.textContent).toBe('3'))
    })

    it('recaptures the anchor when wheel scrolling reaches 0px during a 1.5s split-turn load', async () => {
        let now = 1_000
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
        try {
            const onRequest = vi.fn()
            const controls: {
                resolvePage: ((outcome: OlderLoadOutcome) => void) | null
                beforeApply: ((historyVersion: number) => boolean) | null
            } = {
                resolvePage: null,
                beforeApply: null,
            }

            function SplitTurnWheelHarness() {
                const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
                const [page, setPage] = useState(1)
                const [isLoadingMore, setIsLoadingMore] = useState(false)
                const onLoadMore = useCallback((onBeforeApply?: (historyVersion: number) => boolean) => {
                    onRequest()
                    controls.beforeApply = onBeforeApply ?? null
                    setIsLoadingMore(true)
                    const { promise, resolve } = Promise.withResolvers<OlderLoadOutcome>()
                    controls.resolvePage = (outcome) => {
                        setIsLoadingMore(false)
                        if (outcome.kind === 'applied') {
                            setPage(outcome.historyVersion)
                        }
                        resolve(outcome)
                    }
                    return promise
                }, [])

                return (
                    <QueryClientProvider client={queryClient}>
                        <I18nProvider>
                            <output data-testid="split-page">{page}</output>
                            <HappyThread
                                api={api}
                                session={session}
                                sessionId="pagination-session"
                                metadata={null}
                                disabled={false}
                                onRefresh={() => undefined}
                                messagesWarning={null}
                                hasMoreMessages={page < 3}
                                isLoadingMoreMessages={isLoadingMore}
                                onLoadMore={onLoadMore}
                                onCancelLoadMore={() => undefined}
                                onViewModeChange={() => undefined}
                                isSyncingTail={false}
                                unseenCount={0}
                                rawMessagesCount={1}
                                normalizedMessagesCount={1}
                                messagesVersion={page}
                                historyVersion={page}
                                forceScrollToken={0}
                                outlineOpen={false}
                                outlineItems={[]}
                                onOutlineOpenChange={() => undefined}
                            />
                        </I18nProvider>
                    </QueryClientProvider>
                )
            }

            render(<SplitTurnWheelHarness />)
            const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
            const anchor = screen.getByTestId('stable-visible-message')
            const pageOut = screen.getByTestId('split-page')
            Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 900 })
            Object.defineProperty(viewport, 'scrollHeight', {
                configurable: true,
                get: () => pageOut.textContent === '2' ? 2_600 : 2_000,
            })
            viewport.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, height: 900, width: 800 })
            anchor.getBoundingClientRect = () => {
                const splitTurnGrowth = pageOut.textContent === '2' ? 600 : 0
                return DOMRect.fromRect({
                    y: -viewport.scrollTop,
                    height: 1_200 + splitTurnGrowth,
                    width: 600,
                })
            }

            // Start at scrollTop = 266 (inside the 320px preload margin) when the wheel load triggers.
            viewport.scrollTop = 266
            fireEvent.wheel(viewport, { deltaY: -266 })
            await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))

            // The wheel gesture finishes scrolling the viewport to 0px while the 1.5s request is in flight.
            now += 50
            viewport.scrollTop = 0
            fireEvent.scroll(viewport)

            // 1.5s later, the older split-turn slice resolves and grows the anchored message by 600px at the top.
            now += 1_450
            expect(controls.beforeApply?.(2)).toBe(true)
            controls.resolvePage?.({
                kind: 'applied',
                historyVersion: 2,
                hasMore: true,
                addedRenderableCount: 4,
            })

            await waitFor(() => expect(pageOut.textContent).toBe('2'))
            // The bottom of the split turn stays at the exact same viewport offset (scrollTop = 600, not 600 - 266 = 334).
            expect(viewport.scrollTop).toBe(600)
        } finally {
            nowSpy.mockRestore()
        }
    })

    it('scrolls the outer viewport and loads older messages when wheeling upward over #code-body even if a nested ToolCard passes under the stationary cursor', async () => {
        const onRequest = vi.fn()
        render(<PaginationHarness onRequest={onRequest} />)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
        const sentinel = viewport.querySelector<HTMLElement>('.chat-scroll-content > [aria-hidden="true"]')!
        const anchor = screen.getByTestId('stable-visible-message')
        anchor.className = 'happy-message mx-auto w-full max-w-content min-w-0 overflow-x-clip px-4 py-2'
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 900 })
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 4_775 })
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, height: 900, width: 1_280 })
        sentinel.getBoundingClientRect = () => DOMRect.fromRect({ y: -viewport.scrollTop, height: 1, width: 800 })
        anchor.getBoundingClientRect = () => DOMRect.fromRect({
            y: 4_000 - viewport.scrollTop,
            height: 600,
            width: 800
        })
        viewport.scrollTop = 3_875

        const codeBody = document.createElement('div')
        codeBody.id = 'code-body'
        codeBody.dataset.hapiCodeBody = 'true'
        codeBody.className = 'overflow-x-auto overflow-y-hidden'
        Object.defineProperties(codeBody, {
            clientWidth: { configurable: true, value: 700 },
            scrollWidth: { configurable: true, value: 4_081 },
            clientHeight: { configurable: true, value: 141 },
            scrollHeight: { configurable: true, value: 141 }
        })

        const nestedToolCard = document.createElement('div')
        nestedToolCard.dataset.hapiNestedScroll = 'true'
        nestedToolCard.className = 'mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto'
        Object.defineProperties(nestedToolCard, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, value: 600 },
            scrollTop: { configurable: true, writable: true, value: 250 }
        })
        anchor.append(nestedToolCard, codeBody)

        // First upward wheel tick starts on the horizontal-only #code-body at stationary cursor (480, 620).
        fireEvent.wheel(codeBody, { deltaY: -600, clientX: 480, clientY: 620 })
        expect(viewport.scrollTop).toBe(3_275)

        // Subsequent upward wheel ticks at the exact same cursor coordinates hit nestedToolCard as it scrolls under the cursor.
        for (let i = 0; i < 6; i += 1) {
            fireEvent.wheel(nestedToolCard, { deltaY: -600, clientX: 480, clientY: 620 })
        }

        expect(viewport.scrollTop).toBe(0)
        await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
    })
})
