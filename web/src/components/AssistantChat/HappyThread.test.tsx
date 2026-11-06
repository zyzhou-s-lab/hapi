import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createContext, useContext, useState, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    ANCHOR_PIN_MAX_MS,
    captureScrollAnchor,
    getHistoryCoverageRetryDelay,
    getPullToLoadState,
    getScrollIntent,
    getVisibleTurnBoundaryId,
    hasAppliedHistoryVersion,
    isNestedScrollEvent,
    isTopTurnHeadlessAssistant,
    measureComposerDockInset,
    loadUntilVisibleBoundaryChanges,
    locateOutlineTargetMessage,
    nextPinnedAnchorUntil,
    prependMissingUserSnapshot,
    restoreScrollAnchor,
    shouldRecapturePendingHistoryAnchor,
    shouldSuppressPinnedWheel,
    shouldLoadOlderForViewport,
    shouldCancelInitialScrollSettling,
    ThreadMessagesById,
} from '@/components/AssistantChat/HappyThread'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { Session } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]


describe('measureComposerDockInset', () => {
    it('reserves the measured dock height, rounding up so the last message stays clear', () => {
        expect(measureComposerDockInset(120.2, { expanded: false, hidden: false })).toBe(121)
    })

    it('reserves nothing while the composer is expanded or the dock is hidden', () => {
        expect(measureComposerDockInset(180, { expanded: true, hidden: false })).toBe(0)
        expect(measureComposerDockInset(180, { expanded: false, hidden: true })).toBe(0)
        expect(measureComposerDockInset(0, { expanded: false, hidden: false })).toBe(0)
        expect(measureComposerDockInset(Number.NaN, { expanded: false, hidden: false })).toBe(0)
    })
})
describe('nested scroll event ownership', () => {
    it('recognizes events from a nested scroll viewport and its descendants', () => {
        const nested = document.createElement('div')
        nested.dataset.hapiNestedScroll = 'true'
        const child = document.createElement('span')
        child.textContent = 'reasoning'
        nested.append(child)
        document.body.append(nested)

        const nestedEvent = new Event('wheel')
        Object.defineProperty(nestedEvent, 'target', { value: nested })
        const childEvent = new Event('keydown')
        Object.defineProperty(childEvent, 'target', { value: child })

        expect(isNestedScrollEvent(new WheelEvent('wheel'))).toBe(false)
        expect(isNestedScrollEvent(nestedEvent)).toBe(true)
        expect(isNestedScrollEvent(childEvent)).toBe(true)

        nested.remove()
    })

    it('recognizes an unmarked vertically scrollable ancestor only when it can scroll vertically', () => {
        const computedStyleSpy = vi.spyOn(window, 'getComputedStyle')
        const viewport = document.createElement('div')
        viewport.className = 'app-scroll-y chat-scroll-y'
        const toolResult = document.createElement('div')
        toolResult.className = 'mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto'
        Object.defineProperties(toolResult, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, value: 600 },
            scrollTop: { configurable: true, writable: true, value: 0 }
        })
        const codeLine = document.createElement('span')
        codeLine.textContent = 'longlog.ts line 1'
        toolResult.append(codeLine)

        const wideCodeBlock = document.createElement('div')
        wideCodeBlock.className = 'overflow-x-auto'
        Object.defineProperties(wideCodeBlock, {
            clientWidth: { configurable: true, value: 300 },
            scrollWidth: { configurable: true, value: 900 },
            clientHeight: { configurable: true, value: 80 },
            scrollHeight: { configurable: true, value: 80 }
        })
        const wideToken = document.createElement('span')
        wideToken.textContent = 'wide line'
        wideCodeBlock.append(wideToken)

        const shortDiff = document.createElement('div')
        shortDiff.className = 'mt-3 max-h-[75vh] overflow-auto'
        Object.defineProperties(shortDiff, {
            clientHeight: { configurable: true, value: 80 },
            scrollHeight: { configurable: true, value: 80 }
        })

        const plainRow = document.createElement('div')
        plainRow.textContent = 'ordinary row'
        viewport.append(toolResult, wideCodeBlock, shortDiff, plainRow)
        document.body.append(viewport)

        const pageUpInToolResult = new KeyboardEvent('keydown', { key: 'PageUp' })
        Object.defineProperty(pageUpInToolResult, 'target', { value: codeLine })
        const wheelUpAtTop = new WheelEvent('wheel', { deltaY: -40 })
        Object.defineProperty(wheelUpAtTop, 'target', { value: codeLine })
        const wheelDownFromTop = new WheelEvent('wheel', { deltaY: 40 })
        Object.defineProperty(wheelDownFromTop, 'target', { value: codeLine })

        expect(isNestedScrollEvent(pageUpInToolResult, viewport)).toBe(true)
        expect(isNestedScrollEvent(wheelUpAtTop, viewport)).toBe(false)
        expect(isNestedScrollEvent(wheelDownFromTop, viewport)).toBe(true)

        toolResult.scrollTop = 0.5
        expect(isNestedScrollEvent(wheelUpAtTop, viewport)).toBe(false)
        toolResult.scrollTop = 120
        expect(isNestedScrollEvent(wheelUpAtTop, viewport)).toBe(true)
        toolResult.scrollTop = 399.5
        expect(isNestedScrollEvent(wheelDownFromTop, viewport)).toBe(false)
        toolResult.scrollTop = 400
        expect(isNestedScrollEvent(wheelDownFromTop, viewport)).toBe(false)

        const wheelOnWideCode = new WheelEvent('wheel', { deltaY: -40 })
        Object.defineProperty(wheelOnWideCode, 'target', { value: wideToken })
        const keyOnWideCode = new KeyboardEvent('keydown', { key: 'PageUp' })
        Object.defineProperty(keyOnWideCode, 'target', { value: wideToken })
        const keyOnShortDiff = new KeyboardEvent('keydown', { key: 'PageUp' })
        Object.defineProperty(keyOnShortDiff, 'target', { value: shortDiff })
        const homeInPlainRow = new KeyboardEvent('keydown', { key: 'Home' })
        Object.defineProperty(homeInPlainRow, 'target', { value: plainRow })
        const viewportKey = new KeyboardEvent('keydown', { key: 'PageUp' })
        Object.defineProperty(viewportKey, 'target', { value: viewport })

        expect(isNestedScrollEvent(wheelOnWideCode, viewport)).toBe(false)
        expect(isNestedScrollEvent(keyOnWideCode, viewport)).toBe(false)
        expect(isNestedScrollEvent(keyOnShortDiff, viewport)).toBe(false)
        expect(isNestedScrollEvent(homeInPlainRow, viewport)).toBe(false)
        expect(isNestedScrollEvent(viewportKey, viewport)).toBe(false)
        expect(computedStyleSpy).not.toHaveBeenCalled()

        const assistantRoot = document.createElement('div')
        assistantRoot.className = 'happy-message mx-auto w-full max-w-content min-w-0 overflow-x-clip px-4 py-2'
        Object.defineProperties(assistantRoot, {
            clientHeight: { configurable: true, value: 400 },
            scrollHeight: { configurable: true, value: 900 },
            scrollTop: { configurable: true, writable: true, value: 120 }
        })
        const nestedCodeBody = document.createElement('div')
        nestedCodeBody.dataset.hapiCodeBody = 'true'
        nestedCodeBody.className = 'overflow-x-auto overflow-y-hidden'
        Object.defineProperties(nestedCodeBody, {
            clientWidth: { configurable: true, value: 400 },
            scrollWidth: { configurable: true, value: 2_000 },
            clientHeight: { configurable: true, value: 120 },
            scrollHeight: { configurable: true, value: 120 }
        })
        assistantRoot.append(nestedCodeBody)
        viewport.append(assistantRoot)
        const wheelOnCodeInsideAssistant = new WheelEvent('wheel', { deltaY: -120 })
        Object.defineProperty(wheelOnCodeInsideAssistant, 'target', { value: nestedCodeBody })
        expect(isNestedScrollEvent(wheelOnCodeInsideAssistant, viewport)).toBe(false)

        computedStyleSpy.mockRestore()
        viewport.remove()
    })
})

describe('ThreadMessagesById', () => {
    it('does not crash when rewind shortens the transcript and then clears it', async () => {
        type TestMessage = { id: string; role: 'user' | 'assistant'; text: string }
        let setMessages!: (messages: TestMessage[]) => void
        function Harness() {
            const [messages, updateMessages] = useState<TestMessage[]>([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' },
                { id: 'user-2', role: 'user', text: 'second' },
                { id: 'assistant-2', role: 'assistant', text: 'second answer' }
            ])
            setMessages = updateMessages
            const runtime = useExternalStoreRuntime({
                messages,
                convertMessage: (message): ThreadMessageLike => ({
                    id: message.id,
                    role: message.role,
                    content: [{ type: 'text', text: message.text }]
                }),
                onNew: async () => {}
            })
            return (
                <AssistantRuntimeProvider runtime={runtime}>
                    <ThreadMessagesById components={{
                        UserMessage: () => <div data-testid="user-message" />,
                        AssistantMessage: () => <div data-testid="assistant-message" />,
                        SystemMessage: () => <div data-testid="system-message" />
                    }} />
                </AssistantRuntimeProvider>
            )
        }

        render(<Harness />)
        expect(screen.getAllByTestId('user-message')).toHaveLength(2)
        expect(screen.getAllByTestId('assistant-message')).toHaveLength(2)

        await act(async () => {
            setMessages([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' }
            ])
        })

        await waitFor(() => {
            expect(screen.getAllByTestId('user-message')).toHaveLength(1)
            expect(screen.getAllByTestId('assistant-message')).toHaveLength(1)
        })

        await act(async () => {
            setMessages([])
        })

        await waitFor(() => {
            expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
            expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument()
        })
    })

    it.each(['echo', 'remove', 'clear'] as const)('keeps message lookups consistent during %s and a synchronous context update', async (operation) => {
        const ExtraContext = createContext('initial')
        const Message = () => {
            const extra = useContext(ExtraContext)
            const message = useAuiState((state) => state.message)
            const custom = message.metadata.custom as { hubMessageId?: string }
            return (
                <div data-testid={message.role} data-extra={extra} data-hub-id={custom.hubMessageId}>
                    {message.id}
                </div>
            )
        }
        const components = { UserMessage: Message, AssistantMessage: Message, SystemMessage: Message }
        const answer: VisibleChatBlock = {
            kind: 'agent-text', id: 'turn-1', localId: null, createdAt: 100, text: 'initial reply'
        }
        const localId = 'local-4cdab591-f2a3-41bf-9089-b1233ff54150'
        const optimistic: VisibleChatBlock = {
            kind: 'user-text', id: localId, localId, createdAt: 200,
            text: 'hello', status: 'sent', invokedAt: 200
        }
        const baseSession: Session = {
            id: 'session-1', namespace: 'default', seq: 1,
            createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            metadata: { path: '/tmp', host: 'localhost', flavor: 'omp' }, metadataVersion: 1,
            agentState: null, agentStateVersion: 1, thinking: true, thinkingAt: 0,
            model: null, modelReasoningEffort: null, effort: null, serviceTier: null,
            resumeWithSessionModel: false
        }
        type State = { blocks: VisibleChatBlock[]; version: number; extra: string }
        let updateState!: React.Dispatch<React.SetStateAction<State>>
        function ThreadHost({ extra }: { extra: string }) {
            const extras = useAuiState((state) => state.thread.extras) as { messagesVersion: number }
            return (
                <ExtraContext.Provider value={`${extra}:${extras.messagesVersion}`}>
                    <ThreadMessagesById components={components} />
                </ExtraContext.Provider>
            )
        }
        function Harness() {
            const [state, setState] = useState<State>({ blocks: [answer], version: 1, extra: 'v1' })
            updateState = setState
            const runtime = useHappyRuntime({
                session: baseSession, blocks: state.blocks, messagesVersion: state.version,
                historyVersion: 0, viewMode: 'tail', isSending: false,
                isRunning: state.blocks.length > 0,
                onSendMessage: () => {}, onAbort: async () => {}
            })
            return (
                <AssistantRuntimeProvider runtime={runtime}>
                    <ThreadHost extra={state.extra} />
                </AssistantRuntimeProvider>
            )
        }

        render(<Harness />)
        await act(async () => {
            updateState({ blocks: [answer, optimistic], version: 2, extra: 'v2' })
        })
        const user = screen.getByTestId('user')
        expect(user).toHaveTextContent(`user-text:${localId}`)

        const nextBlocks = operation === 'echo'
            ? [answer, { ...optimistic, id: 'server-999' }]
            : operation === 'remove' ? [answer] : []
        await act(async () => {
            // Commit the repository update, then re-render a context consumer
            // before the deferred assistant-ui message-list notification runs.
            flushSync(() => updateState({ blocks: nextBlocks, version: 3, extra: 'v3' }))
            flushSync(() => updateState((previous) => ({ ...previous, extra: 'v4' })))
        })

        if (operation === 'echo') {
            expect(screen.getByTestId('user')).toBe(user)
            expect(user).toHaveTextContent(`user-text:${localId}`)
            expect(user).toHaveAttribute('data-hub-id', 'server-999')
            expect(user).toHaveAttribute('data-extra', 'v4:3')
        } else {
            expect(screen.queryByTestId('user')).not.toBeInTheDocument()
            if (operation === 'remove') {
                expect(screen.getByTestId('assistant')).toHaveTextContent('agent-text:turn-1')
            } else {
                expect(screen.queryByTestId('assistant')).not.toBeInTheDocument()
            }
        }
    })
})

function rect(values: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>): DOMRect {
    return {
        left: 0,
        right: 300,
        width: 300,
        height: values.bottom - values.top,
        x: 0,
        y: values.top,
        toJSON: () => ({}),
        ...values
    } as DOMRect
}

function renderPanel(props: Partial<ComponentProps<typeof ConversationOutlinePanel>> = {}) {
    return render(
        <I18nProvider>
            <ConversationOutlinePanel
                items={outlineItems}
                hasMoreMessages={false}
                isLoadingMoreMessages={false}
                onLoadMore={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('ConversationOutlinePanel', () => {
    it('renders outline items and selects an item', () => {
        const onSelect = vi.fn()
        renderPanel({ onSelect })

        fireEvent.click(screen.getByText('Implement the panel'))

        expect(onSelect).toHaveBeenCalledWith(outlineItems[0])
    })

    it('shows each message time instead of a redundant user label', () => {
        const { container } = renderPanel()

        const timestamps = container.querySelectorAll('time')
        expect(timestamps).toHaveLength(outlineItems.length)
        expect(timestamps[0]).toHaveAttribute('dateTime', new Date(outlineItems[0].createdAt).toISOString())
        expect(timestamps[0]).toHaveAttribute('title')
        expect(screen.queryByText('User')).not.toBeInTheDocument()
    })

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('uses a concise placeholder for outline search', () => {
        renderPanel()

        expect(screen.getByPlaceholderText('Search outline')).toBeInTheDocument()
    })

    it('filters loaded outline items without hiding load earlier', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'SECOND' }
        })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
        expect(screen.getByText('1 of 2 items')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('supports wildcard patterns in outline search', () => {
        renderPanel()

        const searchbox = screen.getByRole('searchbox', { name: 'Search outline items' })
        fireEvent.change(searchbox, { target: { value: 'Implement*' } })

        expect(screen.getByText('Implement the panel')).toBeInTheDocument()
        expect(screen.queryByText('Second user prompt')).not.toBeInTheDocument()

        fireEvent.change(searchbox, { target: { value: 'Second user p?????' } })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
    })

    it('lets the shared matcher normalize outline queries consistently', () => {
        const toLocaleLowerCase = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
            return this.toString() === 'I' ? 'ı' : this.toLowerCase()
        })
        try {
            renderPanel({
                items: [
                    ...outlineItems,
                    {
                        id: 'outline:user-text:m3',
                        targetMessageId: 'user-text:m3',
                        kind: 'user',
                        label: 'Istanbul deployment',
                        createdAt: 3000
                    }
                ]
            })
            fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
                target: { value: 'I' }
            })

            expect(screen.getByText('Istanbul deployment')).toBeInTheDocument()
        } finally {
            toLocaleLowerCase.mockRestore()
        }
    })

    it('shows a search-specific empty state', () => {
        renderPanel()

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'missing' }
        })

        expect(screen.getByText('No matching outline items')).toBeInTheDocument()
        expect(screen.queryByText('No outline items in loaded messages')).not.toBeInTheDocument()
    })

    it('keeps an in-panel close action available', () => {
        const onClose = vi.fn()
        renderPanel({ onClose })

        const closeButton = screen.getByRole('button', { name: 'Close' })
        expect(closeButton).toHaveClass('border', 'rounded-md', 'h-9', 'w-9')
        fireEvent.click(closeButton)

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders an empty state', () => {
        renderPanel({ items: [] })

        expect(screen.getByText('No outline items in loaded messages')).toBeInTheDocument()
    })
})

describe('scroll anchor helpers', () => {
    it('captures the first visible message relative to the viewport', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        viewport.className = 'viewport'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'second-message',
            topOffset: 20
        })

        viewport.remove()
    })

    it('treats upward motion near the bottom as manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 690,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 12,
            isNearBottom: false,
            isScrollingUp: true
        })
    })

    it('does not resume tail-following merely because downward reading is close to the bottom', () => {
        expect(getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 590,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 92,
            isNearBottom: false,
            isScrollingUp: false
        })
    })

    it('does not classify downward movement as upward manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 0,
            isNearBottom: true,
            isScrollingUp: false
        })
    })

    it('cancels initial scroll settling when the user scrolls up away from the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 520,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 182,
            isScrollingUp: true
        })
        expect(shouldCancelInitialScrollSettling(intent, true)).toBe(true)
    })

    it('keeps initial scroll settling for programmatic upward movement', () => {
        const intent = getScrollIntent({
            scrollTop: 0,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('keeps initial scroll settling for negligible movement at the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 0,
            isScrollingUp: false
        })
        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('restores the captured message to the same viewport offset', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 260 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', topOffset: 30 })).toBe(true)
        expect(viewport.scrollTop).toBe(250)
        viewport.remove()
    })

    it('offsets scrollTop by height growth when older blocks are prepended inside the anchored split turn', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        const splitTurn = document.createElement('div')
        splitTurn.id = 'hapi-message-split-turn'
        messages.append(splitTurn)
        viewport.append(messages)
        document.body.append(viewport)
        viewport.scrollTop = 0

        let currentHeight = 400
        let prependedAbove = 0
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 700 }))
        vi.spyOn(splitTurn, 'getBoundingClientRect').mockImplementation(() => rect({
            top: 100 + prependedAbove - viewport.scrollTop,
            bottom: 100 + prependedAbove + currentHeight - viewport.scrollTop
        }))

        const anchor = captureScrollAnchor(viewport)
        expect(anchor).toEqual({
            id: 'hapi-message-split-turn',
            topOffset: 0
        })

        // Prepending earlier blocks inside the split turn grows its height by 600px at the top,
        // plus 200px of an earlier user message inserted above it.
        currentHeight = 1_000
        prependedAbove = 200
        expect(restoreScrollAnchor(viewport, anchor!)).toBe(true)
        expect(viewport.scrollTop).toBe(800)

        // Subsequent pinned-anchor restores (from scroll or ResizeObserver events)
        // must preserve the 800px position rather than snapping back or re-adding bottom growth.
        currentHeight = 1_150
        expect(restoreScrollAnchor(viewport, anchor!)).toBe(true)
        expect(viewport.scrollTop).toBe(800)

        viewport.remove()
    })

    it('anchors on the split turn instead of a hoisted leading system event so prepended steps offset scrollTop', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        const hoistedSystemEvent = document.createElement('div')
        hoistedSystemEvent.id = 'hapi-message-agent-event:title-1'
        hoistedSystemEvent.setAttribute('data-hapi-message-role', 'system')
        const splitTurn = document.createElement('div')
        splitTurn.id = 'hapi-message-split-turn'
        splitTurn.setAttribute('data-hapi-message-role', 'assistant')
        messages.append(hoistedSystemEvent, splitTurn)
        viewport.append(messages)
        document.body.append(viewport)
        viewport.scrollTop = 0

        let currentHeight = 500
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 700 }))
        vi.spyOn(hoistedSystemEvent, 'getBoundingClientRect').mockImplementation(() => rect({
            top: 100 - viewport.scrollTop,
            bottom: 124 - viewport.scrollTop
        }))
        vi.spyOn(splitTurn, 'getBoundingClientRect').mockImplementation(() => rect({
            top: 124 - viewport.scrollTop,
            bottom: 124 + currentHeight - viewport.scrollTop
        }))

        const anchor = captureScrollAnchor(viewport)
        expect(anchor).toEqual({
            id: 'hapi-message-split-turn',
            topOffset: 24
        })

        // Prepending earlier blocks inside the split turn grows its height by 900px while
        // the hoisted system event remains at index 0 with height 24px.
        currentHeight = 1_400
        expect(restoreScrollAnchor(viewport, anchor!)).toBe(true)
        expect(viewport.scrollTop).toBe(900)

        viewport.remove()
    })
    it('does not recapture the anchor once the older page is applied', () => {
        expect(shouldRecapturePendingHistoryAnchor('loading')).toBe(true)
        expect(shouldRecapturePendingHistoryAnchor('awaiting-render')).toBe(false)
        expect(shouldRecapturePendingHistoryAnchor('idle')).toBe(false)
    })

    it('suppresses leftover upward wheel deltas while the anchor is pinned', () => {
        expect(shouldSuppressPinnedWheel(-490, 2_000, 1_900)).toBe(true)
        expect(shouldSuppressPinnedWheel(-490, 1_000, 1_900)).toBe(false)
        expect(shouldSuppressPinnedWheel(120, 2_000, 1_900)).toBe(false)
    })

    it('stops extending the anchor pin once the absolute cap is reached', () => {
        expect(nextPinnedAnchorUntil(1_000, 1_100, 250, ANCHOR_PIN_MAX_MS)).toBe(1_350)
        expect(nextPinnedAnchorUntil(1_000, 1_900, 250, ANCHOR_PIN_MAX_MS)).toBe(2_000)
    })

    it('waits until assistant-ui has applied the loaded history version', () => {
        expect(hasAppliedHistoryVersion(4, 4)).toBe(false)
        expect(hasAppliedHistoryVersion(4, 5)).toBe(true)
    })
})

describe('top-triggered history loading', () => {
    it('recognizes an underfilled viewport and a top sentinel inside the preload margin', () => {
        expect(shouldLoadOlderForViewport({
            scrollHeight: 300,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: 100,
            sentinelBottom: 101
        })).toBe(true)
        expect(shouldLoadOlderForViewport({
            scrollHeight: 1_000,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: -200,
            sentinelBottom: -199
        })).toBe(false)
    })

    it('defers an intersection signal until the initial scroll-settling deadline', () => {
        expect(getHistoryCoverageRetryDelay(2_800, 1_000)).toBe(1_816)
        expect(getHistoryCoverageRetryDelay(900, 1_000)).toBe(16)
    })

    it('shows pull feedback at 16px and arms release loading at 64px', () => {
        expect(getPullToLoadState(15)).toBe('idle')
        expect(getPullToLoadState(16)).toBe('pulling')
        expect(getPullToLoadState(63)).toBe('pulling')
        expect(getPullToLoadState(64)).toBe('ready')
    })
})

describe('outline target loading', () => {
    it('loads older messages through the scroll-preserving wrapper until the target appears', async () => {
        const loadOlderPreservingScroll = vi.fn<() => Promise<boolean>>()
        let loadCount = 0
        loadOlderPreservingScroll.mockImplementation(async () => {
            loadCount += 1
            return true
        })

        const findTarget = vi.fn((anchorId: string) => {
            if (anchorId !== 'hapi-message-user-text:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user-text:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })
})

describe('share turn snapshots', () => {
    it('restores the preceding user prompt when a long rendered turn only contains assistant DOM', () => {
        const assistant = { html: '<div data-hapi-message-role="assistant">answer</div>', text: 'answer', role: 'assistant' as const }
        const user = { html: '', text: 'original long-conversation prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([assistant], user)).toEqual([user, assistant])
    })

    it('does not duplicate a user prompt already captured from the DOM', () => {
        const user = { html: '<div data-hapi-message-role="user">prompt</div>', text: 'prompt' }
        const fallback = { html: '', text: 'prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([user], fallback)).toEqual([user])
    })
})

describe('visible older-history loading', () => {
    it('continues across pages hidden inside a collapsed tool group', async () => {
        let page = 0
        let visibleBoundary = 'current-group'
        const loadOlder = vi.fn(async () => {
            page += 1
            if (page === 3) visibleBoundary = 'older-message'
            return true
        })

        await expect(loadUntilVisibleBoundaryChanges({
            getVisibleBoundary: () => visibleBoundary,
            hasMoreMessages: () => true,
            loadOlder
        })).resolves.toBe(true)
        expect(loadOlder).toHaveBeenCalledTimes(3)
    })

    it('stops when the history source cannot load another page', async () => {
        const loadOlder = vi.fn(async () => false)
        await expect(loadUntilVisibleBoundaryChanges({
            getVisibleBoundary: () => 'current-group',
            hasMoreMessages: () => true,
            loadOlder
        })).resolves.toBe(false)
        expect(loadOlder).toHaveBeenCalledTimes(1)
    })

    it('caps automatic multi-page loads when a huge single turn does not change the top boundary', async () => {
        const loadOlder = vi.fn(async () => true)
        await expect(loadUntilVisibleBoundaryChanges({
            getVisibleBoundary: () => 'same-turn-wrapper',
            hasMoreMessages: () => true,
            loadOlder
        })).resolves.toBe(true)
        expect(loadOlder).toHaveBeenCalledTimes(4)
    })

    it('keeps a split assistant turn and its prepended user prompt on the same visible turn boundary until an earlier turn arrives', () => {
        const viewport = document.createElement('div')
        const container = document.createElement('div')
        container.className = 'happy-thread-messages'
        viewport.append(container)

        const hoistedTitle = document.createElement('div')
        hoistedTitle.id = 'hapi-message-sys-1'
        hoistedTitle.setAttribute('data-hapi-message-role', 'system')

        const assistant1 = document.createElement('div')
        assistant1.id = 'hapi-message-assistant-1'
        assistant1.setAttribute('data-hapi-message-role', 'assistant')

        container.append(hoistedTitle, assistant1)
        expect(getVisibleTurnBoundaryId(viewport)).toBe('hapi-message-assistant-1')

        // Prepending the split turn's own user prompt keeps the same turn boundary id.
        const user1 = document.createElement('div')
        user1.id = 'hapi-message-user-1'
        user1.setAttribute('data-hapi-message-role', 'user')
        container.insertBefore(user1, assistant1)
        expect(getVisibleTurnBoundaryId(viewport)).toBe('hapi-message-assistant-1')

        // Prepending an earlier turn changes the boundary id to the earlier turn's assistant anchor.
        const assistant0 = document.createElement('div')
        assistant0.id = 'hapi-message-assistant-0'
        assistant0.setAttribute('data-hapi-message-role', 'assistant')
        container.insertBefore(assistant0, user1)
        expect(getVisibleTurnBoundaryId(viewport)).toBe('hapi-message-assistant-0')
    })

    it('continues chaining when a newly prepended older turn is still a headless split assistant turn', async () => {
        const viewport = document.createElement('div')
        const container = document.createElement('div')
        container.className = 'happy-thread-messages'
        viewport.append(container)

        const user1 = document.createElement('div')
        user1.id = 'hapi-message-user-1'
        user1.setAttribute('data-hapi-message-role', 'user')
        const assistant1 = document.createElement('div')
        assistant1.id = 'hapi-message-assistant-1'
        assistant1.setAttribute('data-hapi-message-role', 'assistant')
        container.append(user1, assistant1)

        let page = 0
        const assistant0 = document.createElement('div')
        assistant0.id = 'hapi-message-assistant-0'
        assistant0.setAttribute('data-hapi-message-role', 'assistant')
        const user0 = document.createElement('div')
        user0.id = 'hapi-message-user-0'
        user0.setAttribute('data-hapi-message-role', 'user')

        const loadOlder = vi.fn(async () => {
            page += 1
            if (page === 1) {
                container.insertBefore(assistant0, user1)
            } else if (page === 3) {
                container.insertBefore(user0, assistant0)
            }
            return true
        })

        await expect(loadUntilVisibleBoundaryChanges({
            getVisibleBoundary: () => getVisibleTurnBoundaryId(viewport),
            isTopTurnIncomplete: () => isTopTurnHeadlessAssistant(viewport),
            hasMoreMessages: () => true,
            loadOlder
        })).resolves.toBe(true)
        expect(loadOlder).toHaveBeenCalledTimes(3)
        expect(isTopTurnHeadlessAssistant(viewport)).toBe(false)
    })

    it('skips multiple leading hoisted system messages when capturing scroll anchor for a split assistant turn', () => {
        const viewport = document.createElement('div')
        viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 600 })
        const container = document.createElement('div')
        container.className = 'happy-thread-messages'
        viewport.append(container)

        const system1 = document.createElement('div')
        system1.id = 'hapi-message-agent-event-title-1'
        system1.setAttribute('data-hapi-message-role', 'system')
        system1.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 24 })

        const system2 = document.createElement('div')
        system2.id = 'hapi-message-agent-event-title-2'
        system2.setAttribute('data-hapi-message-role', 'system')
        system2.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 24, width: 600, height: 24 })

        const assistant = document.createElement('div')
        assistant.id = 'hapi-message-assistant-split'
        assistant.setAttribute('data-hapi-message-role', 'assistant')
        assistant.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 48, width: 600, height: 500 })

        container.append(system1, system2, assistant)

        const anchor = captureScrollAnchor(viewport)
        expect(anchor?.id).toBe('hapi-message-assistant-split')
        expect(isTopTurnHeadlessAssistant(viewport)).toBe(true)
    })
})
