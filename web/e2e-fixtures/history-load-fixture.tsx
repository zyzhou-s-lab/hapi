import { useEffect, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isHumanTurnStart, TURN_PAGE_ROW_MAX, TURN_PAGE_SIZE } from '@hapi/protocol/turnBoundary'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage, MessagesResponse, Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { useMessages } from '../src/hooks/queries/useMessages'
import { createSessionEntityStore } from '../src/chat/store/sessionEntityStore'
import { SessionEntityStoreProvider } from '../src/hooks/useSessionEntityStore'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import { getMessageWindowState } from '../src/lib/message-window-store'

// Drives the real message-window store + chat pipeline + HappyThread against a
// fake paginated message API, so e2e tests can exercise older-history loading
// without a hub. `window.__probe.requests` records every API call for
// assertions (e.g. "exactly one older page per top-approach").

const SESSION_ID = 'history-load-fixture'
// Leave more than one row-budget page of meta-only history for filteredOlder.
const TOTAL_MESSAGES = 2400
const BASE_AT = 1_700_000_000_000

type Probe = {
    requests: { direction: string; beforeSeq: number | null; limit: number | undefined; turns: number | undefined; at: number }[]
    refetch: () => Promise<void>
    windowState: () => { messageCount: number; oldestSeq: number | null; newestSeq: number | null }
}

declare global {
    interface Window {
        __probe: Probe
    }
}

window.__probe = {
    requests: [],
    refetch: async () => {},
    windowState: () => {
        const state = getMessageWindowState(SESSION_ID)
        return {
            messageCount: state.messages.length,
            oldestSeq: state.oldestSeq,
            newestSeq: state.newestSeq
        }
    }
}

// Test knobs via query params:
// - ?shortPages=1  — `before` pages have a two-row response budget, so
//   one page is shorter than the preload margin and cannot push the top
//   sentinel out of the observed box (no intersection transition).
// - ?failBefore=N  — the first N `before` requests reject, mimicking a
//   transient network failure while the sentinel stays covered.
// - ?filteredOlder=1 — every row older than the initial tail page is an
//   agent meta row that normalizeDecryptedMessage filters out, so a loaded
//   page renders zero height and the sentinel cannot move.
// - ?epochBump=1 — `before` responses carry a newer epoch than the tail, so
//   every older-page request hits the store's deliberate epoch-mismatch stop
//   (reset + tail resync, typed terminal stop).
// - ?slowBefore=1 — delay older-page responses long enough for a normal tail
//   synchronization to invalidate an in-flight request.
const fixtureParams = new URLSearchParams(window.location.search)
const shortPages = fixtureParams.has('shortPages')
const failBeforeCount = Number(fixtureParams.get('failBefore') ?? '0')
const filteredOlder = fixtureParams.has('filteredOlder')
const epochBump = fixtureParams.has('epochBump')
const slowBefore = fixtureParams.has('slowBefore')
let beforeAttempts = 0

const allMessages: DecryptedMessage[] = Array.from({ length: TOTAL_MESSAGES }, (_, index) => {
    const seq = index + 1
    const filtered = filteredOlder && seq <= TOTAL_MESSAGES - TURN_PAGE_SIZE
    // Eight normal turns must overflow the viewport; short older pages must
    // still leave the sentinel covered after the prepend is restored.
    const body = shortPages && seq <= TOTAL_MESSAGES - TURN_PAGE_SIZE
        ? ''
        : `\n${'History anchor content.\n'.repeat(5)}`
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        content: filtered
            ? { role: 'agent', content: { type: 'output', data: { isMeta: true } } }
            : { role: 'user', content: { type: 'text', text: `Fixture message ${seq}${body}` } },
        createdAt: BASE_AT + seq,
        invokedAt: BASE_AT + seq
    } as DecryptedMessage
})

function positionOf(message: DecryptedMessage): { at: number; seq: number } {
    return { at: message.invokedAt ?? message.createdAt, seq: message.seq ?? 0 }
}

function pageFrom(messages: DecryptedMessage[], overrides: Partial<MessagesResponse['page']>): MessagesResponse['page'] {
    const oldest = messages[0] ?? null
    const newest = messages[messages.length - 1] ?? null
    return {
        direction: 'latest',
        limit: 200,
        epoch: 1,
        reset: false,
        nextBeforeSeq: oldest?.seq ?? null,
        nextBeforeAt: oldest ? positionOf(oldest).at : null,
        nextAfterSeq: newest?.seq ?? null,
        nextAfterAt: newest ? positionOf(newest).at : null,
        snapshotHeadSeq: newest?.seq ?? null,
        snapshotHeadAt: newest ? positionOf(newest).at : null,
        hasMore: false,
        ...overrides
    }
}

// Match the backward API contract: stop at the requested human-turn boundary
// or the row budget. Meta-only history can exhaust the budget without a turn.
function backwardPage(messages: DecryptedMessage[], turns: number, rowBudget: number): DecryptedMessage[] {
    let start = messages.length
    let humanTurns = 0
    while (start > 0 && messages.length - start < rowBudget) {
        start -= 1
        if (isHumanTurnStart(messages[start]!) && ++humanTurns === turns) break
    }
    return messages.slice(start)
}

const fakeApi = {
    getMessages: async (_sessionId: string, query: NonNullable<Parameters<ApiClient['getMessages']>[1]>): Promise<MessagesResponse> => {
        const limit = query.limit ?? 200
        const turns = query.turns ?? TURN_PAGE_SIZE
        let direction = 'latest'
        if (query.beforeSeq != null || query.beforeAt != null) direction = 'before'
        else if (query.afterSeq != null || query.afterAt != null) direction = 'after'
        window.__probe.requests.push({
            direction,
            beforeSeq: query.beforeSeq ?? null,
            limit: query.limit,
            turns: query.turns,
            at: Date.now()
        })
        // Small async delay to mimic latency. Some tests deliberately keep an
        // older request in flight while a normal tail synchronization runs.
        await new Promise((resolve) => setTimeout(
            resolve,
            direction === 'before' && slowBefore ? 500 : 50
        ))

        if (direction === 'before') {
            beforeAttempts += 1
            if (beforeAttempts <= failBeforeCount) {
                throw new Error('fixture: forced before-page failure')
            }
            const cursorAt = query.beforeAt ?? Number.POSITIVE_INFINITY
            const cursorSeq = query.beforeSeq ?? Number.POSITIVE_INFINITY
            const older = allMessages.filter((message) => {
                const position = positionOf(message)
                return position.at < cursorAt || (position.at === cursorAt && position.seq < cursorSeq)
            })
            const pageMessages = backwardPage(older, turns, shortPages ? 2 : TURN_PAGE_ROW_MAX)
            const oldest = pageMessages[0] ?? null
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'before',
                    limit,
                    epoch: epochBump ? 2 : 1,
                    hasMore: older.length > pageMessages.length,
                    nextBeforeSeq: oldest?.seq ?? null,
                    nextBeforeAt: oldest ? positionOf(oldest).at : null,
                    nextAfterSeq: null,
                    nextAfterAt: null,
                    snapshotHeadSeq: null,
                    snapshotHeadAt: null
                })
            }
        }

        if (direction === 'after') {
            const cursorAt = query.afterAt ?? Number.NEGATIVE_INFINITY
            const cursorSeq = query.afterSeq ?? Number.NEGATIVE_INFINITY
            const newer = allMessages.filter((message) => {
                const position = positionOf(message)
                const after = position.at > cursorAt || (position.at === cursorAt && position.seq > cursorSeq)
                const withinSnapshot = query.untilAt == null || position.at < query.untilAt
                    || (position.at === query.untilAt && position.seq <= (query.untilSeq ?? Number.POSITIVE_INFINITY))
                return after && withinSnapshot
            })
            const pageMessages = newer.slice(0, limit)
            const head = allMessages[allMessages.length - 1]!
            return {
                messages: pageMessages,
                page: pageFrom(pageMessages, {
                    direction: 'after',
                    limit,
                    hasMore: newer.length > pageMessages.length,
                    nextBeforeAt: null,
                    nextBeforeSeq: null,
                    snapshotHeadAt: positionOf(head).at,
                    snapshotHeadSeq: head.seq ?? null
                })
            }
        }

        const pageMessages = backwardPage(allMessages, turns, TURN_PAGE_ROW_MAX)
        // After an epoch bump the "rewritten" tail renders taller rows, so
        // the reset changes content height — this is what re-fires the
        // ResizeObserver coverage re-check in the epoch-reset scenario.
        const rewritten = epochBump && beforeAttempts > 0
        return {
            messages: rewritten
                ? pageMessages.map((message) => ({
                    ...message,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: `Fixture message ${message.seq}\n${'Epoch reset anchor content.\n'.repeat(10)}` }
                    }
                }) as DecryptedMessage)
                : pageMessages,
            page: pageFrom(pageMessages, {
                direction: 'latest',
                limit,
                reset: true,
                hasMore: allMessages.length > pageMessages.length
            })
        }
    }
} as unknown as ApiClient

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: false,
    agentState: null,
    metadata: { path: '/tmp/fixture', host: 'fixture' }
} as unknown as Session

const noopSend = () => {}
const noopAbort = async () => {}

function FixtureThread() {
    const {
        messages,
        warning,
        isSyncingTail,
        isLoadingMore,
        hasMore,
        messagesVersion,
        historyVersion,
        loadMore,
        cancelLoadMore,
        refetch,
        setViewMode
    } = useMessages(fakeApi, SESSION_ID)

    window.__probe.refetch = refetch

    const entityStore = useMemo(() => createSessionEntityStore(), [])
    const { visibleBlocks, normalizedMessages } = entityStore.reconcileMessages(
        SESSION_ID, messages, hasMore, { deferNotifications: true }
    )
    useEffect(() => entityStore.flushNotifications())

    const runtime = useHappyRuntime({
        session: fakeSession,
        entityStore,
        blocks: visibleBlocks,
        messagesVersion,
        historyVersion,
        isSending: false,
        onSendMessage: noopSend,
        onAbort: noopAbort
    })

    return (
        <SessionEntityStoreProvider store={entityStore}>
            <AssistantRuntimeProvider runtime={runtime}>
                <div className="flex h-screen min-h-0 flex-col">
                    <HappyThread
                        api={fakeApi}
                        session={fakeSession}
                        sessionId={SESSION_ID}
                        metadata={null}
                        disabled={false}
                        onRefresh={() => {}}
                        onViewModeChange={setViewMode}
                        isSyncingTail={isSyncingTail}
                        messagesWarning={warning}
                        hasMoreMessages={hasMore}
                        isLoadingMoreMessages={isLoadingMore}
                        onLoadMore={loadMore}
                        onCancelLoadMore={cancelLoadMore}
                        // This fixture drives HappyThread directly, bypassing the
                        // SessionChat block reduction that computes the real count.
                        unseenCount={0}
                        rawMessagesCount={messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={messagesVersion}
                        historyVersion={historyVersion}
                        forceScrollToken={0}
                        outlineOpen={false}
                        outlineItems={[]}
                        onOutlineOpenChange={() => {}}
                    />
                </div>
            </AssistantRuntimeProvider>
        </SessionEntityStoreProvider>
    )
}

// HappyThread's session-header metadata pulls machines via react-query, so
// the fixture needs a QueryClient even though no query ever resolves here.
const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixtureThread />
        </I18nProvider>
    </QueryClientProvider>
)
