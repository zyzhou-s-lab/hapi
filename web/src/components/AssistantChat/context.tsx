import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'
import type { TodoItem } from '@hapi/protocol/types'
import {
    areSessionMetadataSummariesEqual,
    stabilizeSessionMetadataForId,
} from '@/hooks/queries/useSession'

export { areSessionMetadataSummariesEqual }
export type OlderHistoryLoadResult = 'loaded' | 'transient-stop' | 'terminal-stop'

export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    todos?: TodoItem[]
    sessionThinking?: boolean
    activeTurnStartedAt?: number | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    /** Hub-wide AGENT_NOTIFY_SUMMARY chat display; polled once at chat shell. */
    showSessionSummaryInChat: boolean
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onShareTurn?: (
        messageElement: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
    ) => void
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    onNestedScrollFollowChange?: (followLatest: boolean) => void
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
}

export type HappyChatTodosContextValue = Pick<HappyChatContextValue, 'todos'>

export type HappyChatSessionStateContextValue = Pick<
    HappyChatContextValue,
    'sessionThinking' | 'activeTurnStartedAt'
>

export type HappyChatHistoryContextValue = Pick<
    HappyChatContextValue,
    'historyActionPending' | 'hasMoreMessages' | 'isSyncingTail' | 'isLoadingMoreMessages'
>

export type HappyChatStaticContextValue = Omit<
    HappyChatContextValue,
    | keyof HappyChatTodosContextValue
    | keyof HappyChatSessionStateContextValue
    | keyof HappyChatHistoryContextValue
>

export const HappyChatStaticContext = createContext<HappyChatStaticContextValue | null>(null)
export const HappyChatTodosContext = createContext<HappyChatTodosContextValue | null>(null)
export const HappyChatSessionStateContext = createContext<HappyChatSessionStateContextValue | null>(null)
export const HappyChatHistoryContext = createContext<HappyChatHistoryContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    const { value, children } = props
    const metadataCacheRef = useRef<{ sessionId: string; metadata: SessionMetadataSummary | null } | null>(null)
    const stableMetadata = stabilizeSessionMetadataForId(
        metadataCacheRef,
        value.sessionId,
        value.metadata
    )
    const staticValue = useMemo<HappyChatStaticContextValue>(() => ({
        api: value.api,
        sessionId: value.sessionId,
        metadata: stableMetadata,
        terminalToolDisplayMode: value.terminalToolDisplayMode,
        showSessionSummaryInChat: value.showSessionSummaryInChat,
        disabled: value.disabled,
        onRefresh: value.onRefresh,
        onRetryMessage: value.onRetryMessage,
        onForkConversation: value.onForkConversation,
        onRewindConversation: value.onRewindConversation,
        isLatestCompletedBoundary: value.isLatestCompletedBoundary,
        onShareTurn: value.onShareTurn,
        onNestedScrollFollowChange: value.onNestedScrollFollowChange,
        loadOlderMessagesPreservingScroll: value.loadOlderMessagesPreservingScroll
    }), [
        value.api,
        value.sessionId,
        stableMetadata,
        value.terminalToolDisplayMode,
        value.showSessionSummaryInChat,
        value.disabled,
        value.onRefresh,
        value.onRetryMessage,
        value.onForkConversation,
        value.onRewindConversation,
        value.isLatestCompletedBoundary,
        value.onShareTurn,
        value.onNestedScrollFollowChange,
        value.loadOlderMessagesPreservingScroll
    ])

    const todosValue = useMemo<HappyChatTodosContextValue>(() => ({
        todos: value.todos
    }), [value.todos])

    const sessionStateValue = useMemo<HappyChatSessionStateContextValue>(() => ({
        sessionThinking: value.sessionThinking,
        activeTurnStartedAt: value.activeTurnStartedAt
    }), [value.sessionThinking, value.activeTurnStartedAt])

    const historyValue = useMemo<HappyChatHistoryContextValue>(() => ({
        historyActionPending: value.historyActionPending,
        hasMoreMessages: value.hasMoreMessages,
        isSyncingTail: value.isSyncingTail,
        isLoadingMoreMessages: value.isLoadingMoreMessages
    }), [
        value.historyActionPending,
        value.hasMoreMessages,
        value.isSyncingTail,
        value.isLoadingMoreMessages
    ])

    return (
        <HappyChatStaticContext.Provider value={staticValue}>
            <HappyChatTodosContext.Provider value={todosValue}>
                <HappyChatSessionStateContext.Provider value={sessionStateValue}>
                    <HappyChatHistoryContext.Provider value={historyValue}>
                        {children}
                    </HappyChatHistoryContext.Provider>
                </HappyChatSessionStateContext.Provider>
            </HappyChatTodosContext.Provider>
        </HappyChatStaticContext.Provider>
    )
}

export function useOptionalHappyChatStaticContext(): HappyChatStaticContextValue | null {
    return useContext(HappyChatStaticContext)
}

export function useHappyChatStaticContext(): HappyChatStaticContextValue {
    const ctx = useOptionalHappyChatStaticContext()
    if (!ctx) {
        throw new Error('HappyChatStaticContext is missing')
    }
    return ctx
}

export function useOptionalHappyChatTodosContext(): HappyChatTodosContextValue | null {
    return useContext(HappyChatTodosContext)
}

export function useHappyChatTodosContext(): HappyChatTodosContextValue {
    const ctx = useOptionalHappyChatTodosContext()
    if (!ctx) {
        throw new Error('HappyChatTodosContext is missing')
    }
    return ctx
}

export function useOptionalHappyChatSessionStateContext(): HappyChatSessionStateContextValue | null {
    return useContext(HappyChatSessionStateContext)
}

export function useHappyChatSessionStateContext(): HappyChatSessionStateContextValue {
    const ctx = useOptionalHappyChatSessionStateContext()
    if (!ctx) {
        throw new Error('HappyChatSessionStateContext is missing')
    }
    return ctx
}

export function useOptionalHappyChatHistoryContext(): HappyChatHistoryContextValue | null {
    return useContext(HappyChatHistoryContext)
}

export function useHappyChatHistoryContext(): HappyChatHistoryContextValue {
    const ctx = useOptionalHappyChatHistoryContext()
    if (!ctx) {
        throw new Error('HappyChatHistoryContext is missing')
    }
    return ctx
}
