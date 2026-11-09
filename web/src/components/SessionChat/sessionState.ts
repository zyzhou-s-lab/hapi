import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Session } from '@/types/api'
import type { SessionEntityStoreSnapshot } from '@/chat/store/sessionEntityStore'
import { useSessionEntitySelector } from '@/hooks/useSessionEntityStore'
import {
    areSessionMetadataSummariesEqual,
    type SessionMetadataSummary,
    useSessionComposerSlice,
    useSessionRunState,
} from '@/hooks/queries/useSession'
import { queryClient as defaultQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'

export function useSessionChatQueryClient(): QueryClient {
    try {
        return useQueryClient()
    } catch {
        return defaultQueryClient
    }
}

export function createSessionBase(sessionId: string): Session {
    return {
        id: sessionId, namespace: 'default', seq: 0, createdAt: 0, updatedAt: 0,
        active: false, activeAt: 0, metadata: null, metadataVersion: 0,
        agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null,
        resumeWithSessionModel: false,
    }
}

export function useSessionCacheSelector<T>(
    sessionId: string,
    fallback: Session | undefined,
    select: (session: Session | undefined) => T,
    isEqual: (a: T, b: T) => boolean = Object.is,
): T {
    const queryClient = useSessionChatQueryClient()
    const selectedRef = useRef<{ sessionId: string; value: T } | null>(null)
    const getSnapshot = useCallback(() => {
        const current = queryClient.getQueryData<{ session: Session }>(queryKeys.session(sessionId))?.session
        const next = select(current ?? fallback)
        if (selectedRef.current?.sessionId === sessionId && isEqual(selectedRef.current.value, next)) {
            return selectedRef.current.value
        }
        selectedRef.current = { sessionId, value: next }
        return next
    }, [fallback, isEqual, queryClient, select, sessionId])
    const subscribe = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey
        if (key[0] === 'session' && key[1] === sessionId) listener()
    }), [queryClient, sessionId])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Only control/readiness metadata belongs to the runtime controller. Name,
// summary, Todo and header timestamps remain owned by their display surfaces.
function selectControlMetadata(session: Session | undefined): SessionMetadataSummary | null {
    const metadata = session?.metadata
    if (!metadata) return null
    return {
        path: metadata.path,
        host: metadata.host,
        flavor: metadata.flavor,
        startingMode: metadata.startingMode,
        capabilities: metadata.capabilities,
        machineId: metadata.machineId,
        worktree: metadata.worktree,
        claudeSessionId: metadata.claudeSessionId,
        codexSessionId: metadata.codexSessionId,
        cursorSessionId: metadata.cursorSessionId,
        geminiSessionId: metadata.geminiSessionId,
        opencodeSessionId: metadata.opencodeSessionId,
        grokSessionId: metadata.grokSessionId,
        agySessionId: metadata.agySessionId,
        kimiSessionId: metadata.kimiSessionId,
        copilotSessionId: metadata.copilotSessionId,
        piSessionId: metadata.piSessionId,
        ompSession: metadata.ompSession,
        ompThinking: metadata.ompThinking,
        piAvailableModels: metadata.piAvailableModels,
        piSelectedModel: metadata.piSelectedModel,
        ccSwitchProviderId: metadata.ccSwitchProviderId,
        ...('piThinkingLevel' in metadata ? { piThinkingLevel: metadata.piThinkingLevel } : {}),
        ...('claudePromptCacheTtl' in metadata ? { claudePromptCacheTtl: metadata.claudePromptCacheTtl } : {}),
        ...('ccSwitchProviderName' in metadata ? { ccSwitchProviderName: metadata.ccSwitchProviderName } : {}),
    }
}

export function sameShallowSelection<T>(a: T, b: T): boolean {
    if (Object.is(a, b)) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => Object.is(Reflect.get(a, key), Reflect.get(b, key)))
}

export function useSessionControlSession(api: import('@/api/client').ApiClient, sessionId: string, fallback?: Session): Session {
    const run = useSessionRunState(api, sessionId, fallback)
    const config = useSessionComposerSlice(api, sessionId, fallback)
    const metadata = useSessionCacheSelector(
        sessionId,
        fallback,
        selectControlMetadata,
        areSessionMetadataSummariesEqual
    )
    return useMemo(() => ({
        ...createSessionBase(sessionId),
        active: run?.active ?? config?.active ?? fallback?.active ?? false,
        thinking: run?.thinking ?? fallback?.thinking ?? false,
        agentState: run?.agentState !== undefined ? run.agentState : fallback?.agentState ?? null,
        lifecycleState: run?.lifecycleState,
        activeTurnId: run?.activeTurnId,
        activeTurnStartedAt: run?.activeTurnStartedAt,
        backgroundTaskCount: run?.backgroundTaskCount,
        permissionMode: config?.permissionMode,
        collaborationMode: config?.collaborationMode,
        copilotAgentMode: config?.copilotAgentMode,
        model: config?.model ?? null,
        modelReasoningEffort: config?.modelReasoningEffort ?? null,
        effort: config?.effort ?? null,
        serviceTier: config?.serviceTier ?? null,
        resumeWithSessionModel: config?.resumeWithSessionModel ?? false,
        metadata,
    }), [config, fallback?.active, fallback?.agentState, fallback?.thinking, metadata, run, sessionId])
}

export const useSessionSurfaceSelector = useSessionEntitySelector

export const selectVisibleMessageCount = (snapshot: SessionEntityStoreSnapshot): number => snapshot.visibleMessages.length
export const selectHasRunningChildAgent = (snapshot: SessionEntityStoreSnapshot): boolean => snapshot.hasRunningChildAgent
export const selectTimelineVersion = (snapshot: SessionEntityStoreSnapshot): number => snapshot.timelineVersion
