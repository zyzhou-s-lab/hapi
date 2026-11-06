import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'
import type { TodoItem } from '@hapi/protocol/types'

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

function sameSummary(
    a: SessionMetadataSummary['summary'],
    b: SessionMetadataSummary['summary']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.text === b.text && a.updatedAt === b.updatedAt
}

function sameStringArray(
    a: readonly string[] | undefined,
    b: readonly string[] | undefined
): boolean {
    if (a === b) return true
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

function sameConversationHistoryCapabilities(
    a: NonNullable<SessionMetadataSummary['capabilities']>['conversationHistory'],
    b: NonNullable<SessionMetadataSummary['capabilities']>['conversationHistory']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.forkCurrent === b.forkCurrent
        && a.forkAtMessage === b.forkAtMessage
        && a.rewindToMessage === b.rewindToMessage
}

function sameCapabilities(
    a: SessionMetadataSummary['capabilities'],
    b: SessionMetadataSummary['capabilities']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.terminal === b.terminal
        && sameConversationHistoryCapabilities(a.conversationHistory, b.conversationHistory)
}

function sameShallowRecord<T extends string | number | boolean>(
    a: Record<string, T> | undefined,
    b: Record<string, T> | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) {
            return false
        }
    }
    return true
}

function sameWorktree(
    a: SessionMetadataSummary['worktree'],
    b: SessionMetadataSummary['worktree']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.basePath === b.basePath
        && a.branch === b.branch
        && a.name === b.name
        && a.worktreePath === b.worktreePath
        && a.createdAt === b.createdAt
}

export function areSessionMetadataSummariesEqual(
    a: SessionMetadataSummary | null | undefined,
    b: SessionMetadataSummary | null | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.path === b.path
        && a.host === b.host
        && a.version === b.version
        && a.name === b.name
        && a.os === b.os
        && sameSummary(a.summary, b.summary)
        && a.machineId === b.machineId
        && sameStringArray(a.tools, b.tools)
        && a.flavor === b.flavor
        && a.startingMode === b.startingMode
        && sameCapabilities(a.capabilities, b.capabilities)
        && sameShallowRecord(a.conversationHistoryPoints, b.conversationHistoryPoints)
        && sameShallowRecord(a.conversationHistoryIndexes, b.conversationHistoryIndexes)
        && sameShallowRecord(a.conversationHistoryTurns, b.conversationHistoryTurns)
        && sameShallowRecord(a.conversationHistoryEntryIds, b.conversationHistoryEntryIds)
        && a.conversationHistoryDiverged === b.conversationHistoryDiverged
        && sameWorktree(a.worktree, b.worktree)
}

export function useStableSessionMetadata(
    metadata: SessionMetadataSummary | null
): SessionMetadataSummary | null {
    const ref = useRef<SessionMetadataSummary | null>(metadata)
    if (!areSessionMetadataSummariesEqual(ref.current, metadata)) {
        ref.current = metadata
    }
    return ref.current
}

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    const { value, children } = props
    const stableMetadata = useStableSessionMetadata(value.metadata)

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
