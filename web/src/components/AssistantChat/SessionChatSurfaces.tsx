import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ApiClient } from '@/api/client'
import { areSessionStatusDataEqual, type SessionStatusData } from '@/chat/sessionStatus'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { SessionEntityMetaSnapshot, SessionEntityStore, SessionEntityStoreSnapshot } from '@/chat/store/sessionEntityStore'
import { countUnseenBlocks, createUnseenWatermark, type UnseenWatermark } from '@/chat/unseenBlocks'
import { AgentTerminalView } from '@/components/AgentTerminal/AgentTerminalView'
import { getEffectiveCodexServiceTier } from '@/components/AssistantChat/codexFastMode'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { resolveStructureMessagesVersion } from '@/components/AssistantChat/threadScrollHelpers'
import { CursorMigrationBanner } from '@/components/CursorMigrationBanner'
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary'
import { resolveLatestCompletedBoundaryIdForView } from '@/components/sessionChatHelpers'
import {
    createSessionBase,
    sameShallowSelection,
    selectHasVisibleMessages,
    useSessionCacheSelector,
    useSessionChatQueryClient,
    useSessionSurfaceMetaSelector,
    useSessionSurfaceSelector,
    useSessionSurfaceTimelineSelector,
} from '@/components/SessionChat/sessionState'
import { SessionHeader } from '@/components/SessionHeader'
import { SessionStatusPanel } from '@/components/SessionStatusPanel'
import { TeamPanel } from '@/components/TeamPanel'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import {
    useSessionComposerSlice,
    useSessionHeaderSlice,
    useSessionRunState,
} from '@/hooks/queries/useSession'
import { findLatestCompletedBoundaryId } from '@/lib/assistant-runtime'
import { getMessageWindowState, type OlderLoadOutcome } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { formatRelativeTime } from '@/lib/relativeTime'
import { classifySessionAttention, getSessionAttentionLabelKey } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { type SessionMentionResolveResult } from '@/components/AssistantChat/RichComposerInput'
import { formatSessionMentionTooltip } from '@/lib/sessionReference'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import type { Session, SessionSummary } from '@/types/api'

const EMPTY_OUTLINE_ITEMS: readonly ConversationOutlineItem[] = Object.freeze([])

const selectSessionStatus = (meta: SessionEntityMetaSnapshot): SessionStatusData | null => meta.sessionStatus

export function SessionStatusSlot(props: { entityStore: SessionEntityStore }) {
    const sessionStatus = useSessionSurfaceMetaSelector(
        props.entityStore,
        selectSessionStatus,
        (a, b) => (a === b) || (a !== null && b !== null && areSessionStatusDataEqual(a, b))
    )
    if (!sessionStatus) {
        return null
    }
    return <SessionStatusPanel data={sessionStatus} />
}

export function SessionHeaderSlot(props: {
    api: ApiClient
    sessionId: string
    fallbackSession?: Session
    entityStore: SessionEntityStore
    cursorChatOnDisk?: boolean
    titleSuggestionAvailable?: boolean
    reopenDisabledReason?: string
    reopenHint?: string
    outlineOpen: boolean
    terminalVisible: boolean
    onBack: () => void
    onToggleFiles: () => void
    onToggleOutline: () => void
    onToggleConfig: () => void
    onToggleTerminal: () => void
    onSessionReopened: (newSessionId: string) => Promise<void>
}) {
    const headerSlice = useSessionHeaderSlice(
        props.api,
        props.sessionId,
        props.fallbackSession,
        props.fallbackSession?.metadata
    )
    const runStateSlice = useSessionRunState(props.api, props.sessionId, props.fallbackSession)
    const composerSlice = useSessionComposerSlice(props.api, props.sessionId, props.fallbackSession)
    const hasVisibleMessages = useSessionSurfaceTimelineSelector(props.entityStore, selectHasVisibleMessages)

    const resolvedSession = useMemo<Session>(() => {
        const base = props.fallbackSession
        const createdAt = headerSlice?.createdAt ?? base?.createdAt ?? 0
        const metadata = (headerSlice?.metadata ?? base?.metadata ?? null) as Session['metadata']
        return {
            ...createSessionBase(props.sessionId),
            namespace: base?.namespace ?? 'default',
            seq: base?.seq ?? 0,
            createdAt,
            updatedAt: base?.updatedAt ?? createdAt,
            active: runStateSlice?.active ?? headerSlice?.active ?? base?.active ?? false,
            activeAt: base?.activeAt ?? createdAt,
            pinned: headerSlice?.pinned ?? base?.pinned,
            globalPinned: headerSlice?.globalPinned ?? base?.globalPinned,
            metadata,
            metadataVersion: base?.metadataVersion ?? 0,
            agentState: runStateSlice?.agentState !== undefined ? runStateSlice.agentState : (base?.agentState ?? null),
            agentStateVersion: base?.agentStateVersion ?? 0,
            teamState: headerSlice?.teamState !== undefined ? headerSlice.teamState : base?.teamState,
            teamStateUpdatedAt: base?.teamStateUpdatedAt,
            thinking: runStateSlice?.thinking ?? base?.thinking ?? false,
            thinkingAt: base?.thinkingAt ?? 0,
            lifecycleState: runStateSlice?.lifecycleState !== undefined ? runStateSlice.lifecycleState : base?.lifecycleState,
            activeTurnId: runStateSlice?.activeTurnId !== undefined ? runStateSlice.activeTurnId : base?.activeTurnId,
            activeTurnStartedAt: runStateSlice?.activeTurnStartedAt !== undefined ? runStateSlice.activeTurnStartedAt : base?.activeTurnStartedAt,
            backgroundTaskCount: runStateSlice?.backgroundTaskCount !== undefined ? runStateSlice.backgroundTaskCount : base?.backgroundTaskCount,
            permissionMode: composerSlice?.permissionMode ?? base?.permissionMode,
            collaborationMode: composerSlice?.collaborationMode ?? base?.collaborationMode,
            copilotAgentMode: composerSlice?.copilotAgentMode ?? base?.copilotAgentMode,
            model: composerSlice?.model ?? headerSlice?.model ?? base?.model ?? null,
            modelReasoningEffort: composerSlice?.modelReasoningEffort !== undefined
                ? composerSlice.modelReasoningEffort
                : (headerSlice?.modelReasoningEffort !== undefined ? headerSlice.modelReasoningEffort : (base?.modelReasoningEffort ?? null)),
            effort: composerSlice?.effort ?? headerSlice?.effort ?? base?.effort ?? null,
            serviceTier: composerSlice?.serviceTier !== undefined
                ? composerSlice.serviceTier
                : (headerSlice?.serviceTier !== undefined ? headerSlice.serviceTier : (base?.serviceTier ?? null)),
            resumeWithSessionModel: composerSlice?.resumeWithSessionModel ?? base?.resumeWithSessionModel ?? false,
        }
    }, [composerSlice, headerSlice, props.fallbackSession, props.sessionId, runStateSlice])

    const sessionMetadata = resolvedSession.metadata
    const sessionActive = resolvedSession.active
    const agentFlavor = sessionMetadata?.flavor ?? null
    const controlledByUser = resolvedSession.agentState?.controlledByUser === true
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.sessionId,
        machineId: sessionMetadata?.machineId ?? null,
        enabled: agentFlavor === 'codex'
            && sessionActive
            && !controlledByUser
            && Boolean(sessionMetadata?.machineId),
    })
    const effectiveCodexServiceTier = agentFlavor === 'codex'
        ? getEffectiveCodexServiceTier(
            resolvedSession.serviceTier,
            resolvedSession.model,
            codexModelsState.models
        )
        : undefined
    const inactiveCanResume = inactiveSessionCanResume(
        resolvedSession,
        hasVisibleMessages ? 1 : 0,
        props.cursorChatOnDisk
    )
    const canViewAgentTerminal = sessionMetadata?.startingMode === 'pty' && sessionActive

    return (
        <>
            <SessionHeader
                session={resolvedSession}
                serviceTier={effectiveCodexServiceTier}
                onBack={props.onBack}
                onToggleFiles={sessionMetadata?.path ? props.onToggleFiles : undefined}
                filesActive={false}
                onToggleOutline={props.onToggleOutline}
                outlineActive={props.outlineOpen}
                onToggleConfig={props.onToggleConfig}
                configActive={false}
                onToggleTerminal={canViewAgentTerminal ? props.onToggleTerminal : undefined}
                terminalActive={props.terminalVisible}
                api={props.api}
                titleSuggestionAvailable={props.titleSuggestionAvailable}
                canReopen={inactiveCanResume}
                reopenDisabledReason={props.reopenDisabledReason}
                reopenHint={props.reopenHint}
                onSessionDeleted={props.onBack}
                onSessionReopened={props.onSessionReopened}
            />
            <CursorMigrationBanner metadata={sessionMetadata} />
        </>
    )
}

export function SessionTeamAndInactiveSlot(props: {
    api: ApiClient
    sessionId: string
    fallbackSession?: Session
    entityStore: SessionEntityStore
    cursorChatOnDisk?: boolean
}) {
    const { t } = useTranslation()
    const headerSlice = useSessionHeaderSlice(
        props.api,
        props.sessionId,
        props.fallbackSession,
        props.fallbackSession?.metadata
    )
    const runStateSlice = useSessionRunState(props.api, props.sessionId, props.fallbackSession)
    const hasVisibleMessages = useSessionSurfaceTimelineSelector(props.entityStore, selectHasVisibleMessages)

    const sessionActive = runStateSlice?.active ?? headerSlice?.active ?? props.fallbackSession?.active ?? false
    const sessionInactive = !sessionActive
    const teamState = headerSlice?.teamState !== undefined ? headerSlice.teamState : props.fallbackSession?.teamState
    const metadata = (headerSlice?.metadata ?? props.fallbackSession?.metadata ?? null) as Session['metadata']

    const resumeCandidate = useMemo<Session>(() => ({
        ...createSessionBase(props.sessionId),
        active: sessionActive,
        metadata,
    }), [metadata, props.sessionId, sessionActive])

    const inactiveCanResume = sessionInactive
        ? inactiveSessionCanResume(resumeCandidate, hasVisibleMessages ? 1 : 0, props.cursorChatOnDisk)
        : true

    return (
        <>
            {teamState && (
                <FeatureErrorBoundary name="team-panel" resetKey={props.sessionId}>
                    <TeamPanel teamState={teamState} />
                </FeatureErrorBoundary>
            )}
            {sessionInactive ? (
                <div className="mx-auto w-full max-w-content bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    {inactiveCanResume
                        ? t('session.inactive.autoResume')
                        : t('session.inactive.cannotResume')}
                </div>
            ) : null}
        </>
    )
}

function selectTerminalAvailabilityState(session: Session | undefined): {
    active: boolean
    startingMode: NonNullable<Session['metadata']>['startingMode']
} {
    return {
        active: Boolean(session?.active),
        startingMode: session?.metadata?.startingMode,
    }
}

export function SessionAgentTerminalSlot(props: {
    sessionId: string
    fallbackSession?: Session
    terminalVisible: boolean
    onTerminalAvailableChange: (available: boolean) => void
}) {
    const { active, startingMode } = useSessionCacheSelector(
        props.sessionId,
        props.fallbackSession,
        selectTerminalAvailabilityState,
        sameShallowSelection
    )
    const canViewAgentTerminal = startingMode === 'pty' && active
    useEffect(() => {
        props.onTerminalAvailableChange(canViewAgentTerminal)
    }, [canViewAgentTerminal, props.onTerminalAvailableChange])

    if (!canViewAgentTerminal) {
        return null
    }
    return (
        <AgentTerminalView
            sessionId={props.sessionId}
            visible={props.terminalVisible}
            className={props.terminalVisible ? 'flex-1 min-h-0' : 'hidden'}
        />
    )
}

type ThreadSectionStoreSelection = {
    timelineCount: number
    timelineStructureKey: string
    timelineVersion: number
    hasRawMessages: boolean
    hasNormalizedMessages: boolean
    unseenCount: number
}

export function SessionThreadSection(props: {
    api: ApiClient
    sessionId: string
    baseSession: Session
    entityStore: SessionEntityStore
    viewMode: 'tail' | 'history'
    messagesVersion?: number
    historyVersion: number
    isSyncingTail: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    historyActionPending: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    onViewModeChange: (mode: 'tail' | 'history') => void
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    forceScrollToken: number
    outlineOpen: boolean
    bottomInsetPx: number
    onOutlineOpenChange: (open: boolean) => void
}) {
    const queryClient = useSessionChatQueryClient()
    const viewModeStateRef = useRef<{
        sessionId: string
        viewMode: 'tail' | 'history'
        watermark: UnseenWatermark | null
    }>({
        sessionId: props.sessionId,
        viewMode: props.viewMode,
        watermark: null,
    })
    if (viewModeStateRef.current.sessionId !== props.sessionId) {
        viewModeStateRef.current = {
            sessionId: props.sessionId,
            viewMode: props.viewMode,
            watermark: null,
        }
    } else if (viewModeStateRef.current.viewMode !== props.viewMode) {
        viewModeStateRef.current = {
            sessionId: props.sessionId,
            viewMode: props.viewMode,
            watermark: props.viewMode === 'history'
                ? createUnseenWatermark(props.entityStore.getSnapshot().visibleBlocks)
                : null,
        }
    }

    const versionTrackerRef = useRef({
        sessionId: props.sessionId,
        structureVersion: 0,
        structureKey: '',
        historyVersion: 0,
        rawMessagesCount: 0,
    })

    const selectThreadSection = useCallback((snap: SessionEntityStoreSnapshot): ThreadSectionStoreSelection => {
        let resolvedTimelineVersion: number
        if (props.messagesVersion === undefined) {
            resolvedTimelineVersion = snap.timelineVersion
        } else {
            const liveWindow = props.messagesVersion === undefined
                ? getMessageWindowState(props.sessionId)
                : null
            const rawVersion = props.messagesVersion ?? liveWindow?.messagesVersion ?? 0
            const tracker = versionTrackerRef.current
            const sameSession = tracker.sessionId === (snap.sessionId ?? props.sessionId)
            resolvedTimelineVersion = resolveStructureMessagesVersion({
                messagesVersion: rawVersion,
                previousStructureVersion: sameSession ? tracker.structureVersion : 0,
                previousStructureKey: sameSession ? tracker.structureKey : '',
                nextStructureKey: snap.timelineStructureKey,
                previousHistoryVersion: sameSession ? tracker.historyVersion : 0,
                nextHistoryVersion: props.historyVersion,
                previousRawMessagesCount: sameSession ? tracker.rawMessagesCount : 0,
                nextRawMessagesCount: snap.visibleMessages.length,
            })
            versionTrackerRef.current = {
                sessionId: snap.sessionId ?? props.sessionId,
                structureVersion: resolvedTimelineVersion,
                structureKey: snap.timelineStructureKey,
                historyVersion: props.historyVersion,
                rawMessagesCount: snap.visibleMessages.length,
            }
        }
        const watermark = viewModeStateRef.current.watermark
        return {
            timelineCount: snap.timelineIndex.length,
            timelineStructureKey: snap.timelineStructureKey,
            timelineVersion: resolvedTimelineVersion,
            hasRawMessages: snap.visibleMessages.length > 0,
            hasNormalizedMessages: snap.normalizedMessages.length > 0,
            unseenCount: watermark ? countUnseenBlocks(snap.visibleBlocks, watermark) : 0,
        }
    }, [props.historyVersion, props.messagesVersion, props.sessionId])

    const threadSelectorHook = props.viewMode === 'tail' && props.messagesVersion === undefined
        ? useSessionSurfaceTimelineSelector
        : useSessionSurfaceSelector
    const threadSelection = threadSelectorHook(
        props.entityStore,
        selectThreadSection,
        sameShallowSelection
    )

    const rememberedTailBoundaryRef = useRef<{ id: string | null; tailRevision: number } | null>(null)
    const viewModeRef = useRef(props.viewMode)
    viewModeRef.current = props.viewMode

    const isLatestCompletedBoundary = useCallback((messageId: string): boolean => {
        const snap = props.entityStore.getSnapshot()
        const cachedSession = queryClient.getQueryData<{ session: Session }>(queryKeys.session(props.sessionId))?.session ?? props.baseSession
        const viewMode = viewModeRef.current
        const tailRevision = getMessageWindowState(props.sessionId).tailRevision
        const currentTailBoundaryId = viewMode === 'tail'
            ? findLatestCompletedBoundaryId(
                snap.visibleBlocks,
                Boolean(cachedSession?.thinking),
                cachedSession?.activeTurnStartedAt ?? null,
                snap.blocksWithThreadIds
            )
            : null
        if (viewMode === 'tail') {
            rememberedTailBoundaryRef.current = {
                id: currentTailBoundaryId,
                tailRevision,
            }
        }
        const resolvedBoundaryId = resolveLatestCompletedBoundaryIdForView(
            viewMode,
            currentTailBoundaryId,
            rememberedTailBoundaryRef.current,
            tailRevision
        )
        return resolvedBoundaryId === messageId
    }, [props.baseSession, props.entityStore, props.sessionId, queryClient])

    const rawMessagesCount = threadSelection.hasRawMessages
        ? Math.max(1, threadSelection.timelineCount)
        : 0
    const normalizedMessagesCount = threadSelection.hasNormalizedMessages
        ? Math.max(1, threadSelection.timelineCount)
        : 0

    return (
        <HappyThread
            key={`thread-${props.sessionId}`}
            api={props.api}
            session={props.baseSession}
            sessionId={props.sessionId}
            metadata={props.baseSession.metadata}
            disabled={!props.baseSession.active}
            onRefresh={props.onRefresh}
            onRetryMessage={props.onRetryMessage}
            historyActionPending={props.historyActionPending}
            onForkConversation={props.onForkConversation}
            onRewindConversation={props.onRewindConversation}
            isLatestCompletedBoundary={isLatestCompletedBoundary}
            onViewModeChange={props.onViewModeChange}
            isSyncingTail={props.isSyncingTail}
            messagesWarning={props.messagesWarning}
            hasMoreMessages={props.hasMoreMessages}
            isLoadingMoreMessages={props.isLoadingMoreMessages}
            onLoadMore={props.onLoadMore}
            onCancelLoadMore={props.onCancelLoadMore}
            unseenCount={threadSelection.unseenCount}
            rawMessagesCount={rawMessagesCount}
            normalizedMessagesCount={normalizedMessagesCount}
            messagesVersion={threadSelection.timelineVersion}
            historyVersion={props.historyVersion}
            timelineStructureKey={threadSelection.timelineStructureKey}
            forceScrollToken={props.forceScrollToken}
            outlineOpen={props.outlineOpen}
            bottomInsetPx={props.bottomInsetPx}
            outlineItems={EMPTY_OUTLINE_ITEMS}
            onOutlineOpenChange={props.onOutlineOpenChange}
        />
    )
}

export function useSessionMentionTooltipResolver(api: ApiClient | null): (id: string, title: string) => SessionMentionResolveResult {
    const queryClient = useSessionChatQueryClient()
    const { t } = useTranslation()
    const warmingColdCacheRef = useRef(false)

    return useCallback((id: string, title: string): SessionMentionResolveResult => {
        const cachedList = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
        if (!cachedList && api && typeof api.getSessions === 'function' && !warmingColdCacheRef.current) {
            warmingColdCacheRef.current = true
            void queryClient.fetchQuery({
                queryKey: queryKeys.sessions,
                queryFn: () => api.getSessions(),
            }).catch(() => undefined).finally(() => {
                warmingColdCacheRef.current = false
            })
        }
        const hit = cachedList?.sessions.find((candidate) => candidate.id === id) ?? null
        if (!hit) {
            return {
                model: formatSessionMentionTooltip(null, title, id),
                session: null,
            }
        }
        const attention = classifySessionAttention(hit, {
            selected: false,
            lastSeenAt: getSessionLastSeenAt(hit.id),
        })
        const attentionLabel = attention
            ? t(getSessionAttentionLabelKey(attention))
            : null
        return {
            model: formatSessionMentionTooltip(
                {
                    id: hit.id,
                    title: getSessionTitle(hit),
                    active: hit.active,
                    lifecycleState: hit.metadata?.lifecycleState ?? null,
                    path: hit.metadata?.path ?? null,
                    worktreePath: hit.metadata?.worktree?.worktreePath ?? null,
                    relativeTime: formatRelativeTime(hit.updatedAt, t),
                    thinking: hit.thinking,
                    attentionLabel,
                },
                title,
                id
            ),
            session: hit,
        }
    }, [api, queryClient, t])
}
