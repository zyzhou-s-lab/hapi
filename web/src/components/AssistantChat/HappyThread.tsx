import { useEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive, unstable_useThreadMessageIds, useAuiState } from '@assistant-ui/react'
import type { ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { HappyRuntimeExtras } from '@/lib/assistant-runtime'
import type { Session, SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import type { SessionEntityStore, SessionEntityStoreSnapshot } from '@/chat/store/sessionEntityStore'
import {
    HappyChatHistoryContext,
    HappyChatSessionStateContext,
    HappyChatStaticContext,
    HappyChatTodosContext,
    type HappyChatHistoryContextValue,
    type HappyChatSessionStateContextValue,
    type HappyChatStaticContextValue,
    type HappyChatTodosContextValue,
    type OlderHistoryLoadResult,
} from '@/components/AssistantChat/context'
import { sameShallowSelection, useSessionCacheSelector } from '@/components/SessionChat/sessionState'
import {
    stabilizeSessionMetadataForId,
    useSessionHeaderSlice,
    useSessionRunState,
    useSessionTodoSnapshot,
} from '@/hooks/queries/useSession'
import {
    useOptionalSessionEntityStore,
    useSessionEntitySelector,
    useSessionTimelineIndex,
} from '@/hooks/useSessionEntityStore'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'
import { ShareTurnDialog } from '@/components/AssistantChat/ShareTurnDialog'
import { useShareTurnCapture } from '@/components/AssistantChat/useShareTurnCapture'
import { useThreadScrollAndHistoryController } from '@/components/AssistantChat/useThreadScrollAndHistoryController'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { matchesSearchQuery } from '@hapi/protocol'

function NewMessagesIndicator(props: { count: number; onClick: () => void; bottomInsetPx: number }) {
    const { t } = useTranslation()
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            style={props.bottomInsetPx > 0
                ? { bottom: `calc(${props.bottomInsetPx}px + 0.75rem)` }
                : undefined}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {t('misc.newMessage', { n: props.count })} &#8595;
        </button>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']

/**
 * Render messages by stable id instead of their current array index.
 *
 * Rewind can replace a non-empty transcript with an empty one in a single
 * external-runtime update. Index-based providers may then ask assistant-ui
 * for message 0 while its lookup table is already empty. Stable id providers
 * unmount removed rows without consulting a stale index.
 */
function StoreThreadMessagesById(props: {
    store: SessionEntityStore
    components: ThreadMessageComponents
}) {
    const timelineEntries = useSessionTimelineIndex(props.store)
    const UserComponent = (props.components?.UserMessage ?? HappyUserMessage) as React.ComponentType<{ messageId?: string }>
    const AssistantComponent = (props.components?.AssistantMessage ?? HappyAssistantMessage) as React.ComponentType<{ messageId?: string }>
    const SystemComponent = (props.components?.SystemMessage ?? HappySystemMessage) as React.ComponentType<{ messageId?: string }>
    return (
        <>
            {timelineEntries.map((entry) => {
                if (entry.role === 'user') {
                    return <UserComponent key={entry.id} messageId={entry.id} />
                }
                if (entry.role === 'system') {
                    return <SystemComponent key={entry.id} messageId={entry.id} />
                }
                return <AssistantComponent key={entry.id} messageId={entry.id} />
            })}
        </>
    )
}

function RuntimeThreadMessagesById(props: { components: ThreadMessageComponents }) {
    const messageIds = unstable_useThreadMessageIds()
    return (
        <>
            {messageIds.map((messageId) => (
                <ThreadPrimitive.Unstable_MessageById
                    key={messageId}
                    messageId={messageId}
                    components={props.components}
                />
            ))}
        </>
    )
}

export function ThreadMessagesById({ components }: { components: ThreadMessageComponents }) {
    const store = useOptionalSessionEntityStore()
    if (store) {
        return <StoreThreadMessagesById store={store} components={components} />
    }
    return <RuntimeThreadMessagesById components={components} />
}

const selectOutlineItems = (snapshot: SessionEntityStoreSnapshot): readonly ConversationOutlineItem[] => snapshot.outlineItems

function StoreConversationOutlineSlot(props: {
    store: SessionEntityStore
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
    bottomInsetPx?: number
}) {
    const items = useSessionEntitySelector(props.store, selectOutlineItems)
    return (
        <ConversationOutlinePanel
            items={items}
            hasMoreMessages={props.hasMoreMessages}
            isLoadingMoreMessages={props.isLoadingMoreMessages}
            onLoadMore={props.onLoadMore}
            onSelect={props.onSelect}
            onClose={props.onClose}
            bottomInsetPx={props.bottomInsetPx}
        />
    )
}

function selectThreadStaticControlFlags(session: Session | undefined): {
    active: boolean | undefined
    controlledByUser: boolean
} {
    return {
        active: session?.active,
        controlledByUser: session?.agentState?.controlledByUser === true,
    }
}

function HappyThreadStaticSliceProvider(props: {
    api: ApiClient
    session: Session
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: HappyChatStaticContextValue['terminalToolDisplayMode']
    showSessionSummaryInChat: boolean
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onShareTurn: HappyChatStaticContextValue['onShareTurn']
    onNestedScrollFollowChange: HappyChatStaticContextValue['onNestedScrollFollowChange']
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
    children: React.ReactNode
}) {
    const headerSlice = useSessionHeaderSlice(props.api, props.sessionId, props.session, props.metadata)
    const controlFlags = useSessionCacheSelector(
        props.sessionId,
        props.session,
        selectThreadStaticControlFlags,
        sameShallowSelection
    )
    const metadataCacheRef = useRef<{ sessionId: string; metadata: SessionMetadataSummary | null } | null>(null)
    const stableMetadata = stabilizeSessionMetadataForId(
        metadataCacheRef,
        props.sessionId,
        headerSlice?.metadata ?? props.metadata ?? null
    )
    const effectiveDisabled = props.disabled || (controlFlags.active !== undefined ? !controlFlags.active : false)
    const effectiveFork = controlFlags.controlledByUser ? undefined : props.onForkConversation
    const effectiveRewind = controlFlags.controlledByUser ? undefined : props.onRewindConversation
    const staticValue = useMemo<HappyChatStaticContextValue>(() => ({
        api: props.api,
        sessionId: props.sessionId,
        metadata: stableMetadata,
        terminalToolDisplayMode: props.terminalToolDisplayMode,
        showSessionSummaryInChat: props.showSessionSummaryInChat,
        disabled: effectiveDisabled,
        onRefresh: props.onRefresh,
        onRetryMessage: props.onRetryMessage,
        onForkConversation: effectiveFork,
        onRewindConversation: effectiveRewind,
        isLatestCompletedBoundary: props.isLatestCompletedBoundary,
        onShareTurn: props.onShareTurn,
        onNestedScrollFollowChange: props.onNestedScrollFollowChange,
        loadOlderMessagesPreservingScroll: props.loadOlderMessagesPreservingScroll,
    }), [
        effectiveDisabled,
        effectiveFork,
        effectiveRewind,
        props.api,
        props.isLatestCompletedBoundary,
        props.loadOlderMessagesPreservingScroll,
        props.onNestedScrollFollowChange,
        props.onRefresh,
        props.onRetryMessage,
        props.onShareTurn,
        props.sessionId,
        props.showSessionSummaryInChat,
        props.terminalToolDisplayMode,
        stableMetadata,
    ])
    return (
        <HappyChatStaticContext.Provider value={staticValue}>
            {props.children}
        </HappyChatStaticContext.Provider>
    )
}

function HappyThreadTodoSliceProvider(props: {
    api: ApiClient
    sessionId: string
    session: Session
    children: React.ReactNode
}) {
    const todoSlice = useSessionTodoSnapshot(props.api, props.sessionId, props.session)
    const todos = todoSlice?.todos !== undefined ? todoSlice.todos : props.session?.todos
    const todosValue = useMemo<HappyChatTodosContextValue>(() => ({
        todos,
    }), [todos])
    return (
        <HappyChatTodosContext.Provider value={todosValue}>
            {props.children}
        </HappyChatTodosContext.Provider>
    )
}

function HappyThreadSessionStateSliceProvider(props: {
    api: ApiClient
    sessionId: string
    session: Session
    children: React.ReactNode
}) {
    const runStateSlice = useSessionRunState(props.api, props.sessionId, props.session)
    const sessionThinking = runStateSlice?.thinking ?? props.session?.thinking
    const activeTurnStartedAt = runStateSlice?.activeTurnStartedAt !== undefined
        ? runStateSlice.activeTurnStartedAt
        : (props.session?.activeTurnStartedAt ?? null)
    const sessionStateValue = useMemo<HappyChatSessionStateContextValue>(() => ({
        sessionThinking,
        activeTurnStartedAt,
    }), [activeTurnStartedAt, sessionThinking])
    return (
        <HappyChatSessionStateContext.Provider value={sessionStateValue}>
            {props.children}
        </HappyChatSessionStateContext.Provider>
    )
}
export function ConversationOutlinePanel(props: {
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
    bottomInsetPx?: number
}) {
    const { t, locale } = useTranslation()
    const [searchQuery, setSearchQuery] = useState('')
    const normalizedSearchQuery = searchQuery.trim()
    const filteredItems = useMemo(() => {
        if (normalizedSearchQuery.length === 0) {
            return props.items
        }
        return props.items.filter((item) => (
            matchesSearchQuery(item.label, normalizedSearchQuery)
        ))
    }, [normalizedSearchQuery, props.items])

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            style={props.bottomInsetPx && props.bottomInsetPx > 0 ? { bottom: props.bottomInsetPx } : undefined}
            aria-label={t('session.outline.title')}
        >
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -left-px w-px bg-[var(--app-border)]" />
            <div className="border-b border-[var(--app-border)] p-3">
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
                            aria-hidden="true"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('session.outline.searchPlaceholder')}
                            aria-label={t('session.outline.searchLabel')}
                            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-3 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                    </div>
                    {props.hasMoreMessages ? (
                        <Button
                            variant="outline"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                            aria-busy={props.isLoadingMoreMessages}
                            aria-label={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            title={props.isLoadingMoreMessages ? t('misc.loading') : t('session.outline.loadOlder')}
                            className="h-9 w-9 shrink-0 px-0"
                        >
                            {props.isLoadingMoreMessages ? (
                                <Spinner size="sm" label={null} className="text-current" />
                            ) : (
                                <span className="text-base leading-none" aria-hidden="true">↑</span>
                            )}
                        </Button>
                    ) : null}
                    <Button
                        variant="outline"
                        type="button"
                        onClick={props.onClose}
                        aria-label={t('button.close')}
                        title={t('button.close')}
                        className="h-9 w-9 shrink-0 px-0"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </Button>
                </div>
                {normalizedSearchQuery.length > 0 ? (
                    <div className="mt-1.5 text-right text-xs text-[var(--app-hint)]" aria-live="polite">
                        {t('session.outline.searchResults', {
                            matched: filteredItems.length,
                            total: props.items.length
                        })}
                    </div>
                ) : null}
            </div>

            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : filteredItems.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.noSearchResults')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {filteredItems.map((item) => {
                            const createdAt = new Date(item.createdAt)
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group block w-full min-w-0 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                        <time
                                            dateTime={createdAt.toISOString()}
                                            title={formatMessageTimestampTitle(createdAt)}
                                            className="truncate"
                                        >
                                            {formatOutlineTimestamp(createdAt, locale)}
                                        </time>
                                    </span>
                                    <span className="mt-0.5 line-clamp-2 pl-4 text-sm leading-snug text-[var(--app-fg)]">
                                        {item.label}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    session: Session
    serviceTier?: string | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onViewModeChange: (mode: 'tail' | 'history') => void
    isSyncingTail: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    unseenCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    historyVersion: number
    timelineStructureKey?: string
    forceScrollToken: number
    outlineOpen: boolean
    outlineItems: readonly ConversationOutlineItem[]
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    /** Pixels of scroll content kept clear of the floating composer dock. */
    bottomInsetPx?: number
}) {
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const hubSettingsQuery = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => props.api.getHubSettings(),
        enabled: Boolean(props.api),
        staleTime: 30_000,
        refetchInterval: 30_000,
        retry: false,
    })
    const showSessionSummaryInChat = hubSettingsQuery.data?.sessionSummaryInChat === true
    const runtimeExtras = useAuiState((s) => s.thread.extras) as HappyRuntimeExtras | undefined
    const appliedMessagesVersion = runtimeExtras?.messagesVersion ?? props.messagesVersion
    const appliedHistoryVersion = runtimeExtras?.historyVersion ?? props.historyVersion
    const isAwaitingMessagesRender = appliedMessagesVersion < props.messagesVersion
    const isAwaitingHistoryRender = appliedHistoryVersion < props.historyVersion

    const {
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
    } = useThreadScrollAndHistoryController({
        sessionId: props.sessionId,
        isLoadingMoreMessages: props.isLoadingMoreMessages,
        hasMoreMessages: props.hasMoreMessages,
        isSyncingTail: props.isSyncingTail,
        onLoadMore: props.onLoadMore,
        onCancelLoadMore: props.onCancelLoadMore,
        onViewModeChange: props.onViewModeChange,
        forceScrollToken: props.forceScrollToken,
        rawMessagesCount: props.rawMessagesCount,
        messagesVersion: props.messagesVersion,
        appliedMessagesVersion,
        appliedHistoryVersion,
        isAwaitingMessagesRender,
        isAwaitingHistoryRender,
        timelineStructureKey: props.timelineStructureKey,
        onOutlineOpenChange: props.onOutlineOpenChange,
        onOutlineItemClick: props.onOutlineItemClick,
        bottomInsetPx: props.bottomInsetPx,
    })
    const {
        shareTurn,
        shareTitle,
        shareMetadataItems,
        handleShareTurn,
        closeShareTurn,
    } = useShareTurnCapture({
        api: props.api,
        session: props.session,
        serviceTier: props.serviceTier,
        contentRef,
    })

    const isLoadingMoreOrApplying = props.isLoadingMoreMessages || isAwaitingHistoryRender
    const showSkeleton = (props.isSyncingTail && props.rawMessagesCount === 0)
        || (isAwaitingMessagesRender && appliedMessagesVersion === 0)
    const showLoadEarlierButton = (props.hasMoreMessages || isAwaitingHistoryRender)
        && !props.isSyncingTail
        && !showSkeleton
    const entityStore = useOptionalSessionEntityStore()
    const historyValue = useMemo<HappyChatHistoryContextValue>(() => ({
        historyActionPending: props.historyActionPending,
        hasMoreMessages: props.hasMoreMessages,
        isSyncingTail: props.isSyncingTail,
        isLoadingMoreMessages: props.isLoadingMoreMessages,
    }), [
        props.hasMoreMessages,
        props.historyActionPending,
        props.isLoadingMoreMessages,
        props.isSyncingTail,
    ])
    return (
        <HappyThreadStaticSliceProvider
            api={props.api}
            session={props.session}
            sessionId={props.sessionId}
            metadata={props.metadata}
            terminalToolDisplayMode={terminalToolDisplayMode}
            showSessionSummaryInChat={showSessionSummaryInChat}
            disabled={props.disabled}
            onRefresh={props.onRefresh}
            onRetryMessage={props.onRetryMessage}
            onForkConversation={props.onForkConversation}
            onRewindConversation={props.onRewindConversation}
            isLatestCompletedBoundary={props.isLatestCompletedBoundary}
            onShareTurn={handleShareTurn}
            onNestedScrollFollowChange={handleNestedScrollFollowChange}
            loadOlderMessagesPreservingScroll={loadOlderFromConsumer}
        >
            <HappyThreadTodoSliceProvider api={props.api} sessionId={props.sessionId} session={props.session}>
                <HappyThreadSessionStateSliceProvider api={props.api} sessionId={props.sessionId} session={props.session}>
                    <HappyChatHistoryContext.Provider value={historyValue}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {!props.isSyncingTail && (
                    isLoadingMoreOrApplying || pullToLoadState !== 'idle'
                ) ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur"
                    >
                        {isLoadingMoreOrApplying ? (
                            <Spinner size="sm" label={null} className="text-current" />
                        ) : null}
                        <span>
                            {isLoadingMoreOrApplying
                                ? t('misc.loading')
                                : pullToLoadState === 'ready'
                                    ? t('misc.releaseToLoadOlder')
                                    : t('misc.pullToLoadOlder')}
                        </span>
                    </div>
                ) : null}
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div
                        ref={viewportRef}
                        className="app-scroll-y chat-scroll-y min-h-0 flex-1 overflow-x-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
                        tabIndex={0}
                    >
                        <div
                            ref={contentRef}
                            className="chat-scroll-content mx-auto w-full max-w-content min-w-0 p-3"
                            style={bottomInsetPx > 0 ? { paddingBottom: bottomInsetPx } : undefined}
                        >
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {showLoadEarlierButton ? (
                                        <div className="py-1 mb-2">
                                            <div className="mx-auto w-fit">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        void loadOlderUntilVisible()
                                                    }}
                                                    disabled={isLoadingMoreOrApplying || props.isSyncingTail}
                                                    aria-busy={isLoadingMoreOrApplying}
                                                    className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                                >
                                                    <span aria-hidden="true" className="inline-flex w-4 shrink-0 items-center justify-center">
                                                        {isLoadingMoreOrApplying ? (
                                                            <Spinner size="sm" label={null} className="text-current" />
                                                        ) : (
                                                            '↑'
                                                        )}
                                                    </span>
                                                    {t('session.outline.loadOlder')}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}
                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadMessagesById components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator
                    count={props.unseenCount}
                    onClick={scrollToBottom}
                    bottomInsetPx={bottomInsetPx}
                />
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            style={bottomInsetPx > 0 ? { bottom: bottomInsetPx } : undefined}
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        {entityStore ? (
                            <StoreConversationOutlineSlot
                                store={entityStore}
                                hasMoreMessages={props.hasMoreMessages}
                                isLoadingMoreMessages={props.isLoadingMoreMessages}
                                onLoadMore={() => {
                                    void loadOlderFromConsumer()
                                }}
                                onSelect={handleOutlineSelect}
                                onClose={() => props.onOutlineOpenChange(false)}
                                bottomInsetPx={bottomInsetPx}
                            />
                        ) : (
                            <ConversationOutlinePanel
                                items={props.outlineItems}
                                hasMoreMessages={props.hasMoreMessages}
                                isLoadingMoreMessages={props.isLoadingMoreMessages}
                                onLoadMore={() => {
                                    void loadOlderFromConsumer()
                                }}
                                onSelect={handleOutlineSelect}
                                onClose={() => props.onOutlineOpenChange(false)}
                                bottomInsetPx={bottomInsetPx}
                            />
                        )}
                    </>
                ) : null}
                <ShareTurnDialog
                    key={shareTurn?.id ?? 'closed'}
                    isOpen={shareTurn !== null}
                    title={shareTitle}
                    metadataItems={shareMetadataItems}
                    sourceSnapshots={shareTurn?.snapshots ?? []}
                    sourceContentWidth={shareTurn?.sourceContentWidth ?? null}
                    onClose={closeShareTurn}
                />
            </ThreadPrimitive.Root>
                    </HappyChatHistoryContext.Provider>
                </HappyThreadSessionStateSliceProvider>
            </HappyThreadTodoSliceProvider>
        </HappyThreadStaticSliceProvider>
    )
}
