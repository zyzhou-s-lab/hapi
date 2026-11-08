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

export type SessionExtendedMetadata = SessionMetadataSummary & {
    ompSessionFile?: string
    piSessionFile?: string
    piThinkingLevel?: string | null
    claudePromptCacheTtl?: string | number | null
    ccSwitchProviderName?: string
    kiloSessionId?: string
    rovoSessionId?: string
    droidSessionId?: string
}

function sameSummaryText(
    a: SessionMetadataSummary['summary'],
    b: SessionMetadataSummary['summary']
): boolean {
    if (a === b) return true
    const aText = a?.text ?? undefined
    const bText = b?.text ?? undefined
    return aText === bText
}

function sameOmpSession(
    a: SessionMetadataSummary['ompSession'],
    b: SessionMetadataSummary['ompSession']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.id === b.id && a.file === b.file && a.name === b.name
}

export function sameOmpThinking(
    a: SessionMetadataSummary['ompThinking'],
    b: SessionMetadataSummary['ompThinking']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.thinkingLevel === b.thinkingLevel
        && a.configured === b.configured
        && a.resolved === b.resolved
}

export function samePiSelectedModel(
    a: SessionMetadataSummary['piSelectedModel'],
    b: SessionMetadataSummary['piSelectedModel']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.provider === b.provider && a.modelId === b.modelId
}

export function samePiAvailableModels(
    a: SessionMetadataSummary['piAvailableModels'],
    b: SessionMetadataSummary['piAvailableModels']
): boolean {
    if (a === b) return true
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i]
        const right = b[i]
        if (left === right) continue
        if (!left || !right) return false
        if (
            left.provider !== right.provider
            || left.id !== right.id
            || left.name !== right.name
            || left.reasoning !== right.reasoning
            || left.contextWindow !== right.contextWindow
        ) {
            return false
        }
    }
    return true
}

function sameForkedFrom(
    a: SessionMetadataSummary['forkedFrom'],
    b: SessionMetadataSummary['forkedFrom']
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.sessionId === b.sessionId
        && a.mode === b.mode
        && a.seq === b.seq
        && a.messageId === b.messageId
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

function sameRouteReadinessMetadataFields(
    a: SessionMetadataSummary,
    b: SessionMetadataSummary
): boolean {
    const aExt = a as SessionExtendedMetadata
    const bExt = b as SessionExtendedMetadata
    return a.path === b.path
        && a.host === b.host
        && a.name === b.name
        && a.machineId === b.machineId
        && a.flavor === b.flavor
        && a.startingMode === b.startingMode
        && sameCapabilities(a.capabilities, b.capabilities)
        && sameWorktree(a.worktree, b.worktree)
        && a.lifecycleState === b.lifecycleState
        && a.archivedAt === b.archivedAt
        && a.hapiMcpUrl === b.hapiMcpUrl
        && a.supersededBySessionId === b.supersededBySessionId
        && sameForkedFrom(a.forkedFrom, b.forkedFrom)
        && a.claudeSessionId === b.claudeSessionId
        && a.codexSessionId === b.codexSessionId
        && a.codexSourceSessionId === b.codexSourceSessionId
        && a.cursorSessionId === b.cursorSessionId
        && a.cursorSessionProtocol === b.cursorSessionProtocol
        && a.cursorMigrationState === b.cursorMigrationState
        && a.geminiSessionId === b.geminiSessionId
        && a.opencodeSessionId === b.opencodeSessionId
        && a.grokSessionId === b.grokSessionId
        && a.agySessionId === b.agySessionId
        && a.kimiSessionId === b.kimiSessionId
        && a.copilotSessionId === b.copilotSessionId
        && a.piSessionId === b.piSessionId
        && sameOmpSession(a.ompSession, b.ompSession)
        && aExt.ompSessionFile === bExt.ompSessionFile
        && aExt.piSessionFile === bExt.piSessionFile
        && aExt.kiloSessionId === bExt.kiloSessionId
        && aExt.rovoSessionId === bExt.rovoSessionId
        && aExt.droidSessionId === bExt.droidSessionId
}

export function areSessionMetadataSummariesEqual(
    a: SessionMetadataSummary | null | undefined,
    b: SessionMetadataSummary | null | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    const aExt = a as SessionExtendedMetadata
    const bExt = b as SessionExtendedMetadata
    return sameRouteReadinessMetadataFields(a, b)
        && a.version === b.version
        && a.os === b.os
        && sameSummary(a.summary, b.summary)
        && sameStringArray(a.tools, b.tools)
        && sameShallowRecord(a.conversationHistoryPoints, b.conversationHistoryPoints)
        && sameShallowRecord(a.conversationHistoryIndexes, b.conversationHistoryIndexes)
        && sameShallowRecord(a.conversationHistoryTurns, b.conversationHistoryTurns)
        && sameShallowRecord(a.conversationHistoryEntryIds, b.conversationHistoryEntryIds)
        && a.conversationHistoryDiverged === b.conversationHistoryDiverged
        && sameOmpThinking(a.ompThinking, b.ompThinking)
        && samePiSelectedModel(a.piSelectedModel, b.piSelectedModel)
        && samePiAvailableModels(a.piAvailableModels, b.piAvailableModels)
        && a.ccSwitchProviderId === b.ccSwitchProviderId
        && aExt.piThinkingLevel === bExt.piThinkingLevel
        && aExt.claudePromptCacheTtl === bExt.claudePromptCacheTtl
        && aExt.ccSwitchProviderName === bExt.ccSwitchProviderName
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
    piAvailableModels?: NonNullable<Session['metadata']>['piAvailableModels']
    piSelectedModel?: NonNullable<Session['metadata']>['piSelectedModel']
    piThinkingLevel?: string | null
    claudePromptCacheTtl?: string | number | null
    ccSwitchProviderId?: NonNullable<Session['metadata']>['ccSwitchProviderId']
    ccSwitchProviderName?: string
}

export type SessionRouteMetadataSlice = {
    path: string
    host: string
    name?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    flavor?: string | null
    startingMode?: 'local' | 'remote'
    capabilities?: SessionMetadataSummary['capabilities']
    worktree?: SessionMetadataSummary['worktree']
    lifecycleState?: SessionMetadataSummary['lifecycleState']
    archivedAt?: number | null
    hapiMcpUrl?: string
    supersededBySessionId?: string
    forkedFrom?: SessionMetadataSummary['forkedFrom']
    claudeSessionId?: string
    codexSessionId?: string
    codexSourceSessionId?: string
    cursorSessionId?: string
    cursorSessionProtocol?: SessionMetadataSummary['cursorSessionProtocol']
    cursorMigrationState?: SessionMetadataSummary['cursorMigrationState']
    geminiSessionId?: string
    opencodeSessionId?: string
    grokSessionId?: string
    agySessionId?: string
    kimiSessionId?: string
    copilotSessionId?: string
    piSessionId?: string
    piSessionFile?: string
    ompSession?: SessionMetadataSummary['ompSession']
    ompSessionFile?: string
    kiloSessionId?: string
    rovoSessionId?: string
    droidSessionId?: string
}

export type SessionRouteState = {
    id: string
    active: boolean
    permissionMode?: Session['permissionMode']
    metadata: SessionRouteMetadataSlice | null
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

export type SessionComposerMetadataOverrides = {
    worktree?: SessionMetadataSummary['worktree']
    ompThinking?: NonNullable<Session['metadata']>['ompThinking']
    piAvailableModels?: NonNullable<Session['metadata']>['piAvailableModels']
    piSelectedModel?: NonNullable<Session['metadata']>['piSelectedModel']
}

export function selectSessionComposerConfig(
    session: Session,
    worktreeOrOverrides?: SessionMetadataSummary['worktree'] | SessionComposerMetadataOverrides
): SessionComposerConfigSlice {
    const metadata = session.metadata as SessionExtendedMetadata | null
    const isOverridesObject = Boolean(
        worktreeOrOverrides
        && typeof worktreeOrOverrides === 'object'
        && !('basePath' in worktreeOrOverrides)
        && !('worktreePath' in worktreeOrOverrides)
    )
    const overrides = isOverridesObject
        ? (worktreeOrOverrides as SessionComposerMetadataOverrides)
        : undefined
    const worktreeOverride = isOverridesObject
        ? overrides?.worktree
        : (worktreeOrOverrides as SessionMetadataSummary['worktree'])
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
        ompThinking: overrides && 'ompThinking' in overrides ? overrides.ompThinking : metadata?.ompThinking,
        piAvailableModels: overrides && 'piAvailableModels' in overrides
            ? overrides.piAvailableModels
            : metadata?.piAvailableModels,
        piSelectedModel: overrides && 'piSelectedModel' in overrides
            ? overrides.piSelectedModel
            : metadata?.piSelectedModel,
        piThinkingLevel: metadata?.piThinkingLevel,
        claudePromptCacheTtl: metadata?.claudePromptCacheTtl,
        ccSwitchProviderId: metadata?.ccSwitchProviderId,
        ccSwitchProviderName: metadata?.ccSwitchProviderName,
    }
}

export function selectSessionRouteMetadata(
    metadata: Session['metadata'] | null | undefined
): SessionRouteMetadataSlice | null {
    if (!metadata) return null
    const ext = metadata as SessionExtendedMetadata
    return {
        path: metadata.path,
        host: metadata.host,
        name: metadata.name,
        summary: metadata.summary ? { text: metadata.summary.text, updatedAt: 0 } : undefined,
        machineId: metadata.machineId,
        flavor: metadata.flavor,
        startingMode: metadata.startingMode,
        capabilities: metadata.capabilities,
        worktree: metadata.worktree,
        lifecycleState: metadata.lifecycleState,
        archivedAt: metadata.archivedAt,
        hapiMcpUrl: metadata.hapiMcpUrl,
        supersededBySessionId: metadata.supersededBySessionId,
        forkedFrom: metadata.forkedFrom,
        claudeSessionId: metadata.claudeSessionId,
        codexSessionId: metadata.codexSessionId,
        codexSourceSessionId: metadata.codexSourceSessionId,
        cursorSessionId: metadata.cursorSessionId,
        cursorSessionProtocol: metadata.cursorSessionProtocol,
        cursorMigrationState: metadata.cursorMigrationState,
        geminiSessionId: metadata.geminiSessionId,
        opencodeSessionId: metadata.opencodeSessionId,
        grokSessionId: metadata.grokSessionId,
        agySessionId: metadata.agySessionId,
        kimiSessionId: metadata.kimiSessionId,
        copilotSessionId: metadata.copilotSessionId,
        piSessionId: metadata.piSessionId,
        piSessionFile: ext.piSessionFile,
        ompSession: metadata.ompSession,
        ompSessionFile: ext.ompSessionFile,
        kiloSessionId: ext.kiloSessionId,
        rovoSessionId: ext.rovoSessionId,
        droidSessionId: ext.droidSessionId,
    }
}

export function areSessionRouteMetadataEqual(
    a: SessionRouteMetadataSlice | null | undefined,
    b: SessionRouteMetadataSlice | null | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return sameRouteReadinessMetadataFields(a as SessionMetadataSummary, b as SessionMetadataSummary)
        && sameSummaryText(a.summary, b.summary)
}

export function selectSessionRouteState(
    session: Session,
    metadataOverride?: SessionRouteMetadataSlice | null
): SessionRouteState {
    return {
        id: session.id,
        active: session.active,
        permissionMode: session.permissionMode,
        metadata: metadataOverride !== undefined
            ? metadataOverride
            : selectSessionRouteMetadata(session.metadata),
    }
}

export function areSessionRouteStatesEqual(
    a: SessionRouteState | null | undefined,
    b: SessionRouteState | null | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.id === b.id
        && a.active === b.active
        && a.permissionMode === b.permissionMode
        && areSessionRouteMetadataEqual(a.metadata, b.metadata)
}

export function isSessionNotFoundError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = error.status
        if (status === 404 || status === 410) {
            return true
        }
    }
    return error instanceof Error
        && (
            error.message.includes('HTTP 404')
            || error.message.includes('HTTP 410')
            || error.message.includes('Session not found')
            || error.message.includes('Session gone')
        )
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

export function buildPlaceholderSessionFromSummary(summary: SessionSummary): Session {
    return {
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
    }
}

export function getCachedSessionOrPlaceholder(
    queryClient: QueryClient,
    sessionId: string | null | undefined
): Session | null {
    if (!sessionId) {
        return null
    }
    const cachedDetail = queryClient.getQueryData<{ session?: Session } | Session>(queryKeys.session(sessionId))
    if (cachedDetail && typeof cachedDetail === 'object') {
        if ('session' in cachedDetail && cachedDetail.session) {
            return cachedDetail.session
        }
        if ('id' in cachedDetail && typeof cachedDetail.id === 'string') {
            return cachedDetail as Session
        }
    }
    const cachedSessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
    const summary = cachedSessions?.sessions.find((item) => item.id === sessionId)
    return summary ? buildPlaceholderSessionFromSummary(summary) : null
}

async function fetchSessionDetailWithEviction(
    queryClient: QueryClient,
    api: ApiClient | null,
    sessionId: string | null
): Promise<{ session: Session }> {
    if (!api || !sessionId) {
        throw new Error('Session unavailable')
    }
    try {
        return await api.getSession(sessionId)
    } catch (error) {
        if (isSessionNotFoundError(error)) {
            queryClient.setQueryData<{ sessions: SessionSummary[] } | undefined>(
                queryKeys.sessions,
                (previous) => {
                    if (!previous || !Array.isArray(previous.sessions)) {
                        return previous
                    }
                    if (!previous.sessions.some((item) => item.id === sessionId)) {
                        return previous
                    }
                    return {
                        ...previous,
                        sessions: previous.sessions.filter((item) => item.id !== sessionId),
                    }
                }
            )
        }
        throw error
    }
}

function resolvePlaceholderSessionData(
    queryClient: QueryClient,
    sessionId: string | null,
    resolvedSessionId: string
): { session: Session } | undefined {
    if (!sessionId) {
        return undefined
    }
    const existingState = queryClient.getQueryState(queryKeys.session(resolvedSessionId))
    if (existingState?.error && isSessionNotFoundError(existingState.error)) {
        return undefined
    }
    const cachedSessions = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
    const summary = cachedSessions?.sessions.find((item) => item.id === sessionId)
    if (!summary) {
        return undefined
    }
    return {
        session: buildPlaceholderSessionFromSummary(summary),
    }
}

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
        queryFn: () => fetchSessionDetailWithEviction(queryClient, api, sessionId),
        select: selectSessionWithStableMetadata,
        placeholderData: () => resolvePlaceholderSessionData(queryClient, sessionId, resolvedSessionId),
        enabled: Boolean(api && sessionId),
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    const notFound = isSessionNotFoundError(query.error) && !query.isFetching
    return {
        session: notFound ? null : (query.data?.session ?? null),
        isPlaceholderData: notFound ? false : query.isPlaceholderData,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound,
        refetch: query.refetch,
    }
}

export function useSessionRouteState(api: ApiClient | null, sessionId: string | null): {
    session: SessionRouteState | null
    isPlaceholderData: boolean
    isLoading: boolean
    error: string | null
    notFound: boolean
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const resolvedSessionId = sessionId ?? 'unknown'
    const routeStateRef = useRef<{ session: SessionRouteState } | null>(null)
    const selectStableRouteState = useCallback((data: { session: Session }): { session: SessionRouteState } => {
        const prevWrapper = routeStateRef.current
        const prevRoute = prevWrapper?.session.id === data.session.id ? prevWrapper.session : null
        const rawRouteMetadata = selectSessionRouteMetadata(data.session.metadata)
        const stableMetadata = prevRoute && areSessionRouteMetadataEqual(prevRoute.metadata, rawRouteMetadata)
            ? prevRoute.metadata
            : rawRouteMetadata
        const nextRouteState = selectSessionRouteState(data.session, stableMetadata)
        if (prevWrapper && areSessionRouteStatesEqual(prevWrapper.session, nextRouteState)) {
            return prevWrapper
        }
        const nextWrapper = { session: nextRouteState }
        routeStateRef.current = nextWrapper
        return nextWrapper
    }, [])
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: () => fetchSessionDetailWithEviction(queryClient, api, sessionId),
        select: selectStableRouteState,
        placeholderData: () => resolvePlaceholderSessionData(queryClient, sessionId, resolvedSessionId),
        enabled: Boolean(api && sessionId),
        staleTime: SESSION_DETAIL_STALE_TIME_MS,
        retry: (failureCount, error) => {
            if (isSessionNotFoundError(error)) {
                return false
            }
            return failureCount < 2
        },
    })

    const notFound = isSessionNotFoundError(query.error) && !query.isFetching
    return {
        session: notFound ? null : (query.data?.session ?? null),
        isPlaceholderData: notFound ? false : query.isPlaceholderData,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        notFound,
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
    const composerMetaRef = useRef<{
        sessionId: string
        worktree: SessionMetadataSummary['worktree']
        ompThinking: NonNullable<Session['metadata']>['ompThinking']
        piAvailableModels: NonNullable<Session['metadata']>['piAvailableModels']
        piSelectedModel: NonNullable<Session['metadata']>['piSelectedModel']
    } | null>(null)
    const stabilizeComposerMeta = useCallback(
        (sid: string, metadata: Session['metadata'] | null | undefined): SessionComposerMetadataOverrides => {
            const prev = composerMetaRef.current?.sessionId === sid ? composerMetaRef.current : null
            const worktree = prev && sameWorktree(prev.worktree, metadata?.worktree)
                ? prev.worktree
                : metadata?.worktree
            const ompThinking = prev && sameOmpThinking(prev.ompThinking, metadata?.ompThinking)
                ? prev.ompThinking
                : metadata?.ompThinking
            const piAvailableModels = prev && samePiAvailableModels(prev.piAvailableModels, metadata?.piAvailableModels)
                ? prev.piAvailableModels
                : metadata?.piAvailableModels
            const piSelectedModel = prev && samePiSelectedModel(prev.piSelectedModel, metadata?.piSelectedModel)
                ? prev.piSelectedModel
                : metadata?.piSelectedModel
            composerMetaRef.current = {
                sessionId: sid,
                worktree,
                ompThinking,
                piAvailableModels,
                piSelectedModel,
            }
            return {
                worktree,
                ompThinking,
                piAvailableModels,
                piSelectedModel,
            }
        },
        []
    )

    const selectSlice = useCallback((data: { session: Session }): SessionComposerConfigSlice => {
        const overrides = stabilizeComposerMeta(data.session.id, data.session.metadata)
        return selectSessionComposerConfig(data.session, overrides)
    }, [stabilizeComposerMeta])

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

    const fallbackOverrides = stabilizeComposerMeta(
        resolvedSessionId,
        fallbackSession?.metadata
    )
    const fallbackExt = fallbackSession?.metadata as SessionExtendedMetadata | null | undefined
    const fallbackSlice = useMemo<SessionComposerConfigSlice | null>(() => {
        if (!fallbackSession || fallbackSession.id !== resolvedSessionId) return null
        return selectSessionComposerConfig(fallbackSession, fallbackOverrides)
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
        fallbackSession?.metadata?.ccSwitchProviderId,
        fallbackExt?.piThinkingLevel,
        fallbackExt?.claudePromptCacheTtl,
        fallbackExt?.ccSwitchProviderName,
        fallbackOverrides.worktree,
        fallbackOverrides.ompThinking,
        fallbackOverrides.piAvailableModels,
        fallbackOverrides.piSelectedModel,
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

export const useSessionComposerSlice = useSessionComposerConfig
