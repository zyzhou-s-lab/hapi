import { useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionMetadataSummary, SessionSummary } from '@/types/api'
import { queryClient as defaultQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'

function useResolvedQueryClient(): QueryClient {
    try {
        return useQueryClient()
    } catch {
        return defaultQueryClient
    }
}

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

export function sameWorktree(
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

export function stabilizeSessionMetadataForId(
    cacheRef: { current: { sessionId: string; metadata: SessionMetadataSummary | null } | null },
    sessionId: string,
    metadata: SessionMetadataSummary | null
): SessionMetadataSummary | null {
    if (
        cacheRef.current
        && cacheRef.current.sessionId === sessionId
        && areSessionMetadataSummariesEqual(cacheRef.current.metadata, metadata)
    ) {
        return cacheRef.current.metadata
    }
    cacheRef.current = { sessionId, metadata }
    return metadata
}

export type SessionRunStateSlice = {
    sessionId: string
    active: boolean
    thinking: boolean
    lifecycleState: Session['lifecycleState']
    activeTurnId: string | null | undefined
    activeTurnStartedAt: number | null | undefined
    backgroundTaskCount: number | undefined
    agentState: Session['agentState']
}

export type SessionTodoSlice = {
    sessionId: string
    todos: Session['todos']
    todosUpdatedAt: number | undefined
}

export type SessionHeaderSlice = {
    sessionId: string
    active: boolean
    pinned: boolean | undefined
    globalPinned: boolean | undefined
    metadata: SessionMetadataSummary | null
    model: string | null | undefined
    modelReasoningEffort: Session['modelReasoningEffort'] | undefined
    effort: Session['effort'] | undefined
    serviceTier: Session['serviceTier'] | undefined
}

export type SessionComposerConfigSlice = {
    sessionId: string
    active: boolean
    permissionMode: Session['permissionMode']
    collaborationMode: Session['collaborationMode']
    copilotAgentMode: Session['copilotAgentMode']
    model: string | null | undefined
    modelReasoningEffort: Session['modelReasoningEffort']
    effort: Session['effort']
    serviceTier: Session['serviceTier']
    resumeWithSessionModel: boolean | undefined
    flavor: string | null | undefined
    machineId: string | undefined
    path: string | undefined
    worktree: SessionMetadataSummary['worktree']
    ompThinking: NonNullable<Session['metadata']>['ompThinking']
}

export function selectSessionRunState(session: Session): SessionRunStateSlice {
    return {
        sessionId: session.id,
        active: session.active,
        thinking: session.thinking,
        lifecycleState: session.lifecycleState,
        activeTurnId: session.activeTurnId,
        activeTurnStartedAt: session.activeTurnStartedAt,
        backgroundTaskCount: session.backgroundTaskCount,
        agentState: session.agentState,
    }
}

export function selectSessionTodoSnapshot(session: Session): SessionTodoSlice {
    return {
        sessionId: session.id,
        todos: session.todos,
        todosUpdatedAt: session.todosUpdatedAt,
    }
}

export function selectSessionHeaderSlice(
    session: Session,
    metadataOverride?: SessionMetadataSummary | null
): SessionHeaderSlice {
    return {
        sessionId: session.id,
        active: session.active,
        pinned: session.pinned,
        globalPinned: session.globalPinned,
        metadata: metadataOverride !== undefined ? metadataOverride : session.metadata,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort,
        serviceTier: session.serviceTier,
    }
}

export function selectSessionComposerConfig(
    session: Session,
    worktreeOverride?: SessionMetadataSummary['worktree']
): SessionComposerConfigSlice {
    const metadata = session.metadata
    return {
        sessionId: session.id,
        active: session.active,
        permissionMode: session.permissionMode,
        collaborationMode: session.collaborationMode,
        copilotAgentMode: session.copilotAgentMode,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort,
        serviceTier: session.serviceTier,
        resumeWithSessionModel: session.resumeWithSessionModel,
        flavor: metadata?.flavor,
        machineId: metadata?.machineId,
        path: metadata?.path,
        worktree: worktreeOverride !== undefined ? worktreeOverride : metadata?.worktree,
        ompThinking: metadata?.ompThinking,
    }
}
export function isSessionNotFoundError(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('HTTP 404') || error.message.includes('Session not found'))
}

// Session detail freshness is driven by SSE events (`useSSE` patches the cache
// directly on `session-updated`).  The REST endpoint is only a cold-start /
// reconnect-recovery path, so a long per-query staleTime extends the global
// default (5s, see `web/src/lib/query-client.ts`) for `useSession` only — this
// suppresses remount-refetch when the user navigates back to a recently-viewed
// session within the window, without making the UI stale.  Explicit
// `invalidateQueries` calls (SSE fallback path, reconnect-recovery in
// `App.tsx`) still refetch active observers regardless of staleTime, so live
// updates and recovery flows continue to work.  See tiann/hapi#884.
export const SESSION_DETAIL_STALE_TIME_MS = 30_000

export function useSession(api: ApiClient | null, sessionId: string | null): {
    session: Session | null
    isPlaceholderData: boolean
    isLoading: boolean
    error: string | null
    notFound: boolean
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const resolvedSessionId = sessionId ?? 'unknown'
    const metadataRef = useRef<{ sessionId: string; metadata: SessionMetadataSummary | null } | null>(null)
    const selectSessionWithStableMetadata = useCallback((data: { session: Session }): { session: Session } => {
        const stableMetadata = stabilizeSessionMetadataForId(
            metadataRef,
            data.session.id,
            data.session.metadata
        )
        if (stableMetadata === data.session.metadata) {
            return data
        }
        return {
            ...data,
            session: {
                ...data.session,
                metadata: stableMetadata,
            },
        }
    }, [])
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        select: selectSessionWithStableMetadata,
        placeholderData: () => {
            if (!sessionId) {
                return undefined
            }
            const cachedSessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
            const summary = cachedSessions?.sessions.find((item) => item.id === sessionId)
            if (!summary) {
                return undefined
            }
            return {
                session: {
                    id: summary.id,
                    namespace: 'default',
                    seq: 0,
                    createdAt: summary.updatedAt,
                    updatedAt: summary.updatedAt,
                    pinned: summary.pinned,
                    globalPinned: summary.globalPinned,
                    active: summary.active,
                    activeAt: summary.activeAt,
                    metadata: summary.metadata
                        ? {
                            path: summary.metadata.path,
                            host: summary.metadata.host ?? '',
                            name: summary.metadata.name,
                            summary: summary.metadata.summary
                                ? { text: summary.metadata.summary.text, updatedAt: summary.updatedAt }
                                : undefined,
                            machineId: summary.metadata.machineId,
                            flavor: summary.metadata.flavor,
                            worktree: summary.metadata.worktree,
                            lifecycleState: summary.metadata.lifecycleState,
                            hapiMcpUrl: summary.metadata.hapiMcpUrl,
                            archivedAt: summary.metadata.archivedAt,
                        }
                        : null,
                    metadataVersion: summary.metadataVersion,
                    agentState: null,
                    agentStateVersion: summary.agentStateVersion,
                    thinking: summary.thinking,
                    thinkingAt: 0,
                    backgroundTaskCount: summary.backgroundTaskCount,
                    todosUpdatedAt: summary.todosUpdatedAt,
                    model: summary.model,
                    modelReasoningEffort: summary.modelReasoningEffort ?? null,
                    effort: summary.effort,
                    serviceTier: null,
                    resumeWithSessionModel: false,
                },
            }
        },
        enabled: Boolean(api && sessionId),
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    return {
        session: query.data?.session ?? null,
        isPlaceholderData: query.isPlaceholderData,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound: isSessionNotFoundError(query.error) && !query.isFetching,
        refetch: query.refetch,
    }
}

function isSessionSliceObserverEnabled(
    queryClient: QueryClient,
    resolvedSessionId: string,
    api: ApiClient | null,
    sessionId: string | null,
    fallbackSession: Session | null | undefined
): boolean {
    if (!resolvedSessionId || resolvedSessionId === 'unknown') return false
    if (queryClient.getQueryData(queryKeys.session(resolvedSessionId)) !== undefined) {
        return true
    }
    return Boolean(api && typeof api.getSession === 'function' && sessionId && !fallbackSession)
}

function shouldUseQuerySlice(
    queryClient: QueryClient,
    resolvedSessionId: string,
    hasQueryData: boolean,
    fallbackSession: Session | null | undefined
): boolean {
    if (!hasQueryData) return false
    if (!fallbackSession || fallbackSession.id !== resolvedSessionId) return true
    const cached = queryClient.getQueryData<{ session?: Session }>(queryKeys.session(resolvedSessionId))?.session
    if (!cached || cached.id !== resolvedSessionId) return false
    if (cached.seq !== fallbackSession.seq) {
        return cached.seq > fallbackSession.seq
    }
    return cached.updatedAt >= fallbackSession.updatedAt
}

export function useSessionRunState(
    api: ApiClient | null,
    sessionId: string | null,
    fallbackSession?: Session | null
): SessionRunStateSlice | null {
    const queryClient = useResolvedQueryClient()
    const resolvedSessionId = sessionId ?? fallbackSession?.id ?? 'unknown'
    const selectSlice = useCallback(
        (data: { session: Session }): SessionRunStateSlice => selectSessionRunState(data.session),
        []
    )
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: isSessionSliceObserverEnabled(queryClient, resolvedSessionId, api, sessionId, fallbackSession),
        staleTime: Infinity,
        select: selectSlice,
        retry: false,
    }, queryClient)

    const fallbackSlice = useMemo<SessionRunStateSlice | null>(() => {
        if (!fallbackSession || fallbackSession.id !== resolvedSessionId) return null
        return {
            sessionId: fallbackSession.id,
            active: fallbackSession.active,
            thinking: fallbackSession.thinking,
            lifecycleState: fallbackSession.lifecycleState,
            activeTurnId: fallbackSession.activeTurnId,
            activeTurnStartedAt: fallbackSession.activeTurnStartedAt,
            backgroundTaskCount: fallbackSession.backgroundTaskCount,
            agentState: fallbackSession.agentState,
        }
    }, [
        fallbackSession?.id,
        fallbackSession?.active,
        fallbackSession?.thinking,
        fallbackSession?.lifecycleState,
        fallbackSession?.activeTurnId,
        fallbackSession?.activeTurnStartedAt,
        fallbackSession?.backgroundTaskCount,
        fallbackSession?.agentState,
        resolvedSessionId,
    ])

    if (
        query.data
        && query.data.sessionId === resolvedSessionId
        && shouldUseQuerySlice(queryClient, resolvedSessionId, true, fallbackSession)
    ) {
        return query.data
    }
    return fallbackSlice
}

export function useSessionTodoSnapshot(
    api: ApiClient | null,
    sessionId: string | null,
    fallbackSession?: Session | null
): SessionTodoSlice | null {
    const queryClient = useResolvedQueryClient()
    const resolvedSessionId = sessionId ?? fallbackSession?.id ?? 'unknown'
    const selectSlice = useCallback(
        (data: { session: Session }): SessionTodoSlice => selectSessionTodoSnapshot(data.session),
        []
    )
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: isSessionSliceObserverEnabled(queryClient, resolvedSessionId, api, sessionId, fallbackSession),
        staleTime: Infinity,
        select: selectSlice,
        retry: false,
    }, queryClient)

    const fallbackSlice = useMemo<SessionTodoSlice | null>(() => {
        if (!fallbackSession || fallbackSession.id !== resolvedSessionId) return null
        return {
            sessionId: fallbackSession.id,
            todos: fallbackSession.todos,
            todosUpdatedAt: fallbackSession.todosUpdatedAt,
        }
    }, [
        fallbackSession?.id,
        fallbackSession?.todos,
        fallbackSession?.todosUpdatedAt,
        resolvedSessionId,
    ])

    if (
        query.data
        && query.data.sessionId === resolvedSessionId
        && shouldUseQuerySlice(queryClient, resolvedSessionId, true, fallbackSession)
    ) {
        return query.data
    }
    return fallbackSlice
}

export const useSessionTodos = useSessionTodoSnapshot

export function useSessionHeaderSlice(
    api: ApiClient | null,
    sessionId: string | null,
    fallbackSession?: Session | null,
    fallbackMetadata?: SessionMetadataSummary | null
): SessionHeaderSlice | null {
    const queryClient = useResolvedQueryClient()
    const resolvedSessionId = sessionId ?? fallbackSession?.id ?? 'unknown'
    const metadataRef = useRef<{ sessionId: string; metadata: SessionMetadataSummary | null } | null>(null)
    const selectSlice = useCallback((data: { session: Session }): SessionHeaderSlice => {
        const stableMetadata = stabilizeSessionMetadataForId(
            metadataRef,
            data.session.id,
            data.session.metadata
        )
        return selectSessionHeaderSlice(data.session, stableMetadata)
    }, [])
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: isSessionSliceObserverEnabled(queryClient, resolvedSessionId, api, sessionId, fallbackSession),
        staleTime: Infinity,
        select: selectSlice,
        retry: false,
    }, queryClient)

    const rawFallbackMetadata = fallbackMetadata !== undefined
        ? fallbackMetadata
        : (fallbackSession?.metadata ?? null)
    const stableFallbackMetadata = stabilizeSessionMetadataForId(
        metadataRef,
        resolvedSessionId,
        rawFallbackMetadata
    )

    const fallbackSlice = useMemo<SessionHeaderSlice | null>(() => {
        if (!fallbackSession || fallbackSession.id !== resolvedSessionId) {
            if (fallbackMetadata === undefined) return null
            return {
                sessionId: resolvedSessionId,
                active: false,
                pinned: undefined,
                globalPinned: undefined,
                metadata: stableFallbackMetadata,
                model: undefined,
                modelReasoningEffort: undefined,
                effort: undefined,
                serviceTier: undefined,
            }
        }
        return {
            sessionId: fallbackSession.id,
            active: fallbackSession.active,
            pinned: fallbackSession.pinned,
            globalPinned: fallbackSession.globalPinned,
            metadata: stableFallbackMetadata,
            model: fallbackSession.model,
            modelReasoningEffort: fallbackSession.modelReasoningEffort,
            effort: fallbackSession.effort,
            serviceTier: fallbackSession.serviceTier,
        }
    }, [
        fallbackMetadata,
        fallbackSession?.id,
        fallbackSession?.active,
        fallbackSession?.pinned,
        fallbackSession?.globalPinned,
        fallbackSession?.model,
        fallbackSession?.modelReasoningEffort,
        fallbackSession?.effort,
        fallbackSession?.serviceTier,
        resolvedSessionId,
        stableFallbackMetadata,
    ])

    if (
        query.data
        && query.data.sessionId === resolvedSessionId
        && shouldUseQuerySlice(queryClient, resolvedSessionId, true, fallbackSession)
    ) {
        return query.data
    }
    return fallbackSlice
}

export function useSessionComposerConfig(
    api: ApiClient | null,
    sessionId: string | null,
    fallbackSession?: Session | null
): SessionComposerConfigSlice | null {
    const queryClient = useResolvedQueryClient()
    const resolvedSessionId = sessionId ?? fallbackSession?.id ?? 'unknown'
    const worktreeRef = useRef<{ sessionId: string; worktree: SessionMetadataSummary['worktree'] } | null>(null)
    const stabilizeWorktree = useCallback((sid: string, worktree: SessionMetadataSummary['worktree']) => {
        if (
            worktreeRef.current
            && worktreeRef.current.sessionId === sid
            && sameWorktree(worktreeRef.current.worktree, worktree)
        ) {
            return worktreeRef.current.worktree
        }
        worktreeRef.current = { sessionId: sid, worktree }
        return worktree
    }, [])

    const selectSlice = useCallback((data: { session: Session }): SessionComposerConfigSlice => {
        const stableWorktree = stabilizeWorktree(data.session.id, data.session.metadata?.worktree)
        return selectSessionComposerConfig(data.session, stableWorktree)
    }, [stabilizeWorktree])

    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: isSessionSliceObserverEnabled(queryClient, resolvedSessionId, api, sessionId, fallbackSession),
        staleTime: Infinity,
        select: selectSlice,
        retry: false,
    }, queryClient)

    const stableFallbackWorktree = stabilizeWorktree(
        resolvedSessionId,
        fallbackSession?.metadata?.worktree
    )
    const fallbackSlice = useMemo<SessionComposerConfigSlice | null>(() => {
        if (!fallbackSession || fallbackSession.id !== resolvedSessionId) return null
        return selectSessionComposerConfig(fallbackSession, stableFallbackWorktree)
    }, [
        fallbackSession?.id,
        fallbackSession?.active,
        fallbackSession?.permissionMode,
        fallbackSession?.collaborationMode,
        fallbackSession?.copilotAgentMode,
        fallbackSession?.model,
        fallbackSession?.modelReasoningEffort,
        fallbackSession?.effort,
        fallbackSession?.serviceTier,
        fallbackSession?.resumeWithSessionModel,
        fallbackSession?.metadata?.flavor,
        fallbackSession?.metadata?.machineId,
        fallbackSession?.metadata?.path,
        fallbackSession?.metadata?.ompThinking,
        resolvedSessionId,
        stableFallbackWorktree,
    ])

    if (
        query.data
        && query.data.sessionId === resolvedSessionId
        && shouldUseQuerySlice(queryClient, resolvedSessionId, true, fallbackSession)
    ) {
        return query.data
    }
    return fallbackSlice
}

export const useSessionComposerSlice = useSessionComposerConfig
