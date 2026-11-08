import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { stopSpeaking } from '@/realtime/messageSummarySpeaker'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, Session, SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import type { ComposerSendError } from '@/components/AssistantChat/composer/types'
import { useSessionFlavorModelController } from '@/components/AssistantChat/composer/useSessionFlavorModelController'
import { useSessionComposerSendBridge } from '@/components/AssistantChat/composer/useSessionComposerSendBridge'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { measureComposerDockInset } from '@/components/AssistantChat/threadScrollHelpers'
import { COMPOSER_DOCK_SLOTS, ChatSlotHost } from '@/components/AssistantChat/slotRegistry'
import {
    useSessionComposerSlice,
    useSessionHeaderSlice,
    useSessionRunState,
    useSessionTodoSnapshot,
} from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { getSessionTitle } from '@/lib/sessionTitle'
import { formatSessionMentionTooltip } from '@/lib/sessionReference'
import { classifySessionAttention, getSessionAttentionLabelKey } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { ScratchlistMigrationBanner } from '@/components/AssistantChat/ScratchlistMigrationBanner'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { isSteeringSupportedForSession } from '@hapi/protocol'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import { ShareSeedConsumer } from '@/components/ShareSeedConsumer'
import { type AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import { useTranslation } from '@/lib/use-translation'
import type { SendMessageAcceptance, SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { SessionHeader } from '@/components/SessionHeader'
import { CursorMigrationBanner } from '@/components/CursorMigrationBanner'
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary'
import { TeamPanel } from '@/components/TeamPanel'
import { SessionStatusPanel } from '@/components/SessionStatusPanel'
import { AgentTerminalView } from '@/components/AgentTerminal/AgentTerminalView'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import { VoiceBackendSession, useSessionVoiceBridge } from '@/hooks/useSessionVoiceBridge'
import { SessionEntityStoreProvider } from '@/hooks/useSessionEntityStore'
import { AbortRestoreConsumer, chatComposerGridPlacement, useSessionChatPipeline } from '@/components/sessionChatHelpers'

type SessionChatProps = {
    api: ApiClient
    sessionId?: string
    titleSuggestionAvailable?: boolean
    session?: Session
    cursorChatOnDisk?: boolean
    reopenDisabledReason?: string
    reopenHint?: string
    messages?: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    sendSettlement: SendMessageSettlement | null
    viewMode: 'tail' | 'history'
    messagesVersion?: number
    historyVersion: number
    tailRevision: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    // Returns the accepted mutation's attempt id, or false when
    // pre-mutation guards (no-api / no-session / pending) rejected the call OR async
    // inactive-session resume failed. Composer state that should only be cleared on
    // actual send (pendingSchedule) must await this — see handleSend below.
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | false>
    resolveSessionIdForUpload?: (sessionId: string) => Promise<string>
    onUploadSessionResolved?: (sessionId: string) => void
    onViewModeChange: (mode: 'tail' | 'history') => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
    // The latest send the hub rejected (4xx/5xx/network).  When set, the
    // composer is asked to restore the typed text and surface an inline
    // error -- see HappyComposer.  Cleared by `onClearSendError` once the
    // user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    initialOutlineOpen?: boolean
    onInitialOutlineConsumed?: () => void
    // Called when an `abort-restore` event arrives and the composer is not empty,
    // so the caller can surface the aborted text via the existing sendError path.
    onAbortRestore?: (text: string) => void
}


/**
 * Public entry point. Thin wrapper around `SessionChatInner` keyed by
 * the session id so that ALL inner state - including the scratchlist
 * (entries + mode) and the assistant-ui runtime - resets atomically
 * when the operator navigates between sessions on the same route
 * (e.g. /sessions/A -> /sessions/B).
 *
 * Without the key, React reuses the same component instance, and
 * effects run AFTER the first paint of the new session. That window
 * briefly renders the new session with the previous session's
 * scratchlist entries / drawer-open state, which is the bot finding
 * on PR #798 (PRRT_kwDOQuQOSc6HHOsa). The keyed wrapper is the
 * canonical React pattern for "fully reset state on prop change"; it
 * supersedes the effect-based mode-reset that previously lived in
 * SessionChatInner.
 */
export function SessionChat(props: SessionChatProps) {
    const sessionId = props.sessionId ?? props.session?.id ?? ''
    return <SessionChatInner key={sessionId} {...props} />
}

function SessionChatInner(props: SessionChatProps) {
    const sessionId = props.sessionId ?? props.session?.id ?? ''
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [historyActionPending, setHistoryActionPending] = useState(false)
    useEffect(() => stopSpeaking, [])

    const onForkConversation = useCallback(async (messageLocalId?: string) => {
        setHistoryActionPending(true)
        try {
            const result = await props.api.forkConversation(sessionId, messageLocalId)
            await navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: result.sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        } finally {
            setHistoryActionPending(false)
        }
    }, [navigate, props.api, sessionId])

    const onRewindConversation = useCallback(async (messageLocalId: string) => {
        setHistoryActionPending(true)
        try {
            await props.api.rewindConversation(sessionId, messageLocalId)
            props.onRefresh()
        } finally {
            setHistoryActionPending(false)
        }
    }, [props.api, props.onRefresh, sessionId])
    const runStateSlice = useSessionRunState(props.api, sessionId, props.session)
    const todoSlice = useSessionTodoSnapshot(props.api, sessionId, props.session)
    const headerSlice = useSessionHeaderSlice(props.api, sessionId, props.session, props.session?.metadata)
    const composerSlice = useSessionComposerSlice(props.api, sessionId, props.session)
    const resolvedSession = useMemo<Session>(() => {
        const base = props.session
        const createdAt = headerSlice?.createdAt ?? base?.createdAt ?? 0
        const metadata = (headerSlice?.metadata ?? base?.metadata ?? null) as Session['metadata']
        return {
            id: sessionId,
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
            todos: todoSlice?.todos !== undefined ? todoSlice.todos : base?.todos,
            todosUpdatedAt: todoSlice?.todosUpdatedAt !== undefined ? todoSlice.todosUpdatedAt : base?.todosUpdatedAt,
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
    }, [composerSlice, headerSlice, props.session, runStateSlice, sessionId, todoSlice])
    const sessionActive = resolvedSession.active
    const sessionThinking = resolvedSession.thinking
    const sessionMetadata = resolvedSession.metadata
    const sessionTodos = resolvedSession.todos
    const sessionBackgroundTaskCount = resolvedSession.backgroundTaskCount
    const sessionInactive = !sessionActive
    const terminalSupported = isRemoteTerminalSupported(sessionMetadata)
    // Offer the agent terminal only for an ACTIVE PTY session: a 'remote'/SDK
    // session has no agent PTY, and an archived/inactive one has no live PTY (and
    // no buffer once the runner exits), so its terminal would just be an empty,
    // misleadingly "connected" view. Matches the composer terminal button, which
    // is likewise gated on `session.active`.
    const canViewAgentTerminal =
        sessionMetadata?.startingMode === 'pty' && sessionActive
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const uploadDraftSnapshotRef = useRef<{ text: string; attachments: AttachmentDraftInput[] }>({
        text: '',
        attachments: [],
    })
    const [outlineOpen, setOutlineOpen] = useState(props.initialOutlineOpen ?? false)
    const [terminalVisible, setTerminalVisible] = useState(false)
    useEffect(() => {
        if (!props.initialOutlineOpen) {
            return
        }
        setOutlineOpen(true)
        props.onInitialOutlineConsumed?.()
    }, [props.initialOutlineOpen, props.onInitialOutlineConsumed])
    const { sessions: allSessions } = useSessions(props.api)
    const resolveSessionMentionTooltip = useCallback((id: string, title: string) => {
        const hit = allSessions.find((s) => s.id === id) ?? null
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
    }, [allSessions, t])

    const flavorController = useSessionFlavorModelController({
        api: props.api,
        session: resolvedSession,
        onRefresh: props.onRefresh,
    })
    const {
        agentFlavor,
        controlledByUser,
        codexCollaborationModeSupported,
        codexModelsError,
        effectiveCodexServiceTier,
        piContextWindow,
        handleAbort,
        handleSwitchToRemote,
    } = flavorController
    const {
        voice,
        voiceBackendReady,
        setVoiceBackendReady,
        handleVoiceToggle,
        handleVoiceMicToggle,
    } = useSessionVoiceBridge({
        api: props.api,
        session: resolvedSession,
        messages: props.messages,
        onSend: props.onSend,
        onRefresh: props.onRefresh,
    })
    const {
        entityStore,
        timelineStructureKey,
        structureMessagesVersion,
        visibleMessages,
        normalizedMessages,
        reduced,
        sessionStatus,
        hasRunningChildAgent,
        activityLabel,
        visibleBlocks,
        blocksWithThreadIds,
        isLatestCompletedBoundary,
        unseenCount,
        outlineItems,
    } = useSessionChatPipeline({
        session: resolvedSession,
        messages: props.messages,
        hasMoreMessages: props.hasMoreMessages,
        viewMode: props.viewMode,
        tailRevision: props.tailRevision,
        messagesVersion: props.messagesVersion,
        historyVersion: props.historyVersion,
        onResetSessionView: () => setOutlineOpen(false),
    })
    const inactiveCanResume = inactiveSessionCanResume(
        resolvedSession,
        props.messages ? props.messages.length : visibleMessages.length,
        props.cursorChatOnDisk
    )

    const handleToggleFiles = useCallback(() => {
        setOutlineOpen(false)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])
    const { status: composerGitStatus } = useGitStatusFiles(
        props.api,
        sessionActive ? sessionId : null
    )

    const handleToggleConfig = useCallback(() => {
        setOutlineOpen(false)
        navigate({
            to: '/sessions/$sessionId/config',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    const handleToggleOutline = useCallback(() => {
        setOutlineOpen((open) => !open)
    }, [])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])
    const {
        scratchlist,
        scratchlistMode,
        setScratchlistMode,
        isScratchlistParking,
        setIsScratchlistParking,
        handleScratchlistToggle,
        onParkScratchlist,
        pendingSchedule,
        pendingScheduleRevision,
        updatePendingSchedule,
        pendingScheduleRef,
        pendingSendIntentRef,
        attachmentOrderRef,
        sendAcceptance,
        handleClearSendError,
        handleSend,
        attachmentAdapter,
    } = useSessionComposerSendBridge({
        api: props.api,
        session: resolvedSession,
        agentFlavor,
        inactiveCanResume,
        onSend: props.onSend,
        resolveSessionIdForUpload: props.resolveSessionIdForUpload,
        onUploadSessionResolved: props.onUploadSessionResolved,
        sendError: props.sendError,
        onClearSendError: props.onClearSendError,
        onAcceptedChatSend: () => setForceScrollToken((token) => token + 1),
    })

    const runtime = useHappyRuntime({
        session: resolvedSession,
        blocksWithThreadIds,
        messagesVersion: structureMessagesVersion,
        historyVersion: props.historyVersion,
        viewMode: props.viewMode,
        isSyncingTail: props.isSyncingTail,
        isLoadingMore: props.isLoadingMoreMessages,
        isSending: props.isSending,
        isRunning: sessionThinking || hasRunningChildAgent,
        onSendMessage: handleSend,
        attachmentOrderRef,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef,
        pendingSendIntentRef,
    })

    const composerDockRef = useRef<HTMLDivElement>(null)
    const composerExpandedRef = useRef(false)
    const [composerExpanded, setComposerExpanded] = useState(false)
    const [composerDockHeight, setComposerDockHeight] = useState(0)
    const handleComposerExpandedChange = useCallback((expanded: boolean) => {
        composerExpandedRef.current = expanded
        setComposerExpanded(expanded)
        if (expanded) setComposerDockHeight(0)
    }, [])
    useLayoutEffect(() => {
        const dock = composerDockRef.current
        if (!dock) return
        const publish = () => {
            const hidden = dock.getClientRects().length === 0
            const next = measureComposerDockInset(dock.getBoundingClientRect().height, {
                expanded: composerExpandedRef.current,
                hidden,
            })
            setComposerDockHeight((prev) => prev === next ? prev : next)
        }
        publish()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(publish)
        observer.observe(dock)
        const viewport = window.visualViewport
        viewport?.addEventListener('resize', publish)
        window.addEventListener('resize', publish)
        return () => {
            observer.disconnect()
            viewport?.removeEventListener('resize', publish)
            window.removeEventListener('resize', publish)
        }
    }, [])
    const terminalShown = terminalVisible && canViewAgentTerminal
    const composerGrid = chatComposerGridPlacement({
        terminalShown,
        composerExpanded,
        outlineOpen,
    })
    const composerFloating = !terminalShown && !composerExpanded
    const threadBottomInsetPx = measureComposerDockInset(composerDockHeight, {
        expanded: composerExpanded,
        hidden: terminalShown,
    })
    useLayoutEffect(() => {
        const dock = composerDockRef.current
        if (!dock) return
        const next = measureComposerDockInset(dock.getBoundingClientRect().height, {
            expanded: composerExpandedRef.current,
            hidden: dock.getClientRects().length === 0,
        })
        setComposerDockHeight((prev) => prev === next ? prev : next)
    }, [composerExpanded, terminalShown, outlineOpen])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={resolvedSession}
                serviceTier={effectiveCodexServiceTier}
                onBack={props.onBack}
                onToggleFiles={sessionMetadata?.path ? handleToggleFiles : undefined}
                filesActive={false}
                onToggleOutline={handleToggleOutline}
                outlineActive={outlineOpen}
                onToggleConfig={handleToggleConfig}
                configActive={false}
                onToggleTerminal={canViewAgentTerminal ? () => setTerminalVisible(v => !v) : undefined}
                terminalActive={terminalVisible}
                api={props.api}
                titleSuggestionAvailable={props.titleSuggestionAvailable}
                canReopen={inactiveCanResume}
                reopenDisabledReason={props.reopenDisabledReason}
                reopenHint={props.reopenHint}
                onSessionDeleted={props.onBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        sessionId,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: newSessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />

            <CursorMigrationBanner metadata={sessionMetadata} />

            {sessionStatus ? <SessionStatusPanel data={sessionStatus} /> : null}

            <div className="flex flex-col min-h-0 flex-1">
            {resolvedSession.teamState && (
                <FeatureErrorBoundary name="team-panel" resetKey={sessionId}>
                    <TeamPanel teamState={resolvedSession.teamState} />
                </FeatureErrorBoundary>
            )}

            {sessionInactive ? (
                <div className="mx-auto w-full max-w-content bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                    {inactiveCanResume
                        ? t('session.inactive.autoResume')
                        : t('session.inactive.cannotResume')}
                </div>
            ) : null}

            <SessionEntityStoreProvider store={entityStore}>
            <AssistantRuntimeProvider runtime={runtime}>
                <ShareSeedConsumer sessionId={sessionId} sessionActive={sessionActive} />
                <DragDropZone disabled={(!sessionActive && !inactiveCanResume) || props.isSending || pendingSchedule != null || isScratchlistParking}>
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        {canViewAgentTerminal && (
                            // SessionChatInner is keyed by session.id, so switching sessions remounts this subtree.
                            <AgentTerminalView
                                sessionId={sessionId}
                                visible={terminalVisible}
                                className={terminalVisible ? 'flex-1 min-h-0' : 'hidden'}
                            />
                        )}
                        <div className={composerGrid.stage}>
                        <div className={composerGrid.thread}>

                    <HappyThread
                        // Key with prefix: different components under the same session
                        // (thread, scratchlist, composer) must have distinct keys to avoid
                        // React reconciliation issues when switching sessions rapidly.
                        // Without prefixes, React may reuse the wrong component's DOM/localStorage.
                        key={`thread-${sessionId}`}
                        api={props.api}
                        session={resolvedSession}
                        serviceTier={effectiveCodexServiceTier}
                        sessionId={sessionId}
                        metadata={sessionMetadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        historyActionPending={historyActionPending}
                        onForkConversation={controlledByUser ? undefined : onForkConversation}
                        onRewindConversation={controlledByUser ? undefined : onRewindConversation}
                        isLatestCompletedBoundary={isLatestCompletedBoundary}
                        onViewModeChange={props.onViewModeChange}
                        isSyncingTail={props.isSyncingTail}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        onCancelLoadMore={props.onCancelLoadMore}
                        unseenCount={unseenCount}
                        rawMessagesCount={visibleMessages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={structureMessagesVersion}
                        historyVersion={props.historyVersion}
                        timelineStructureKey={timelineStructureKey}
                        forceScrollToken={forceScrollToken}
                        outlineOpen={outlineOpen}
                        bottomInsetPx={threadBottomInsetPx}
                        outlineItems={outlineItems}
                        onOutlineOpenChange={setOutlineOpen}
                    />
                    </div>

                    <div
                        ref={composerDockRef}
                        data-testid="composer-dock"
                        className={composerGrid.dock}
                    >
                    <div className="pointer-events-auto">
                    {codexCollaborationModeSupported && codexModelsError ? (
                        composerFloating ? (
                            <div className="composer-floating-chrome">
                                <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">
                                    {t('session.codexModelsLoadFailed')}: {codexModelsError}
                                </div>
                            </div>
                        ) : (
                            <div className="px-3 pb-2">
                                <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">
                                    {t('session.codexModelsLoadFailed')}: {codexModelsError}
                                </div>
                            </div>
                        )
                    ) : null}

                    {/*
                     * One-time banner shown after local scratchlist entries
                     * migrate into the hub-backed store.
                     */}
                    <ScratchlistMigrationBanner
                        migrationStatus={scratchlist.migrationStatus}
                        onDismiss={scratchlist.dismissMigrationBanner}
                    />

                    <div className="px-3">
                        <ChatSlotHost
                            slots={COMPOSER_DOCK_SLOTS}
                            resetKey={sessionId}
                            ctx={{
                                sessionId,
                                api: props.api,
                                todos: sessionTodos,
                                sessionThinking: Boolean(sessionThinking),
                                scratchlistMode,
                                scratchlistEntries: scratchlist.entries,
                                onScratchlistMove: scratchlist.move,
                                onScratchlistDelete: scratchlist.remove,
                                onSend: props.onSend,
                                onExitScratchlistMode: () => setScratchlistMode(false),
                                scratchlistDisabled: props.isSending || isScratchlistParking,
                                pendingSchedule,
                                pendingScheduleRevision,
                                onRestorePendingSchedule: updatePendingSchedule,
                                canSteer: isSteeringSupportedForSession(sessionMetadata)
                                    && (agentFlavor === 'pi'
                                        ? sessionThinking
                                        : resolvedSession.agentState?.steeringActive === true)
                                    && !controlledByUser,
                            }}
                        />
                    </div>
                    </div>

                    <HappyComposer
                        onExpandedChange={handleComposerExpandedChange}
                        key={`composer-${sessionId}`}
                        sessionId={sessionId}
                        canRestoreAttachments={sessionActive}
                        onUploadDraftSnapshot={(text, attachments) => {
                            uploadDraftSnapshotRef.current = { text, attachments }
                        }}
                        attachmentOrderRef={attachmentOrderRef}
                        resolveSessionMentionTooltip={resolveSessionMentionTooltip}
                        disabled={props.isSending}
                        pendingSchedule={pendingSchedule}
                        sendAcceptance={sendAcceptance}
                        sendSettlement={props.sendSettlement}
                        onSchedule={updatePendingSchedule}
                        onClearSchedule={() => updatePendingSchedule(null)}
                        threadGoal={reduced.latestGoal}
                        flavorController={flavorController}
                        active={sessionActive}
                        allowSendWhenInactive
                        onResumeStoredDraft={() => handleSend('', undefined, null)}
                        thinking={sessionThinking}
                        agentState={resolvedSession.agentState}
                        activityLabel={activityLabel}
                        backgroundTaskCount={sessionBackgroundTaskCount}
                        contextSize={reduced.latestUsage?.contextSize}
                        contextCacheRead={reduced.latestUsage?.cacheRead}
                        contextWindow={reduced.latestUsage?.contextWindow ?? piContextWindow}
                        contextModel={reduced.latestUsage?.model ?? resolvedSession.model}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={sessionActive && terminalSupported ? handleViewTerminal : undefined}
                        terminalUnsupported={sessionActive && !terminalSupported}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice && voiceBackendReady ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice && voiceBackendReady ? handleVoiceMicToggle : undefined}
                        voiceTranscriptionApi={props.api}
                        scratchlistMode={scratchlistMode}
                        scratchlistCount={scratchlist.entries.length}
                        onScratchlistToggle={handleScratchlistToggle}
                        onParkScratchlist={onParkScratchlist}
                        onScratchlistParkingChange={setIsScratchlistParking}
                        sendError={props.sendError ?? null}
                        onClearSendError={handleClearSendError}
                        onSuppressSendErrorRestore={props.onSuppressSendErrorRestore}
                        pendingSendIntentRef={pendingSendIntentRef}
                        gitBranch={sessionMetadata?.worktree?.branch ?? null}
                        gitStatus={composerGitStatus}
                        onViewFiles={sessionActive ? handleToggleFiles : undefined}
                        />
                    </div>
                    </div>
                    </div>
                </DragDropZone>
            </AssistantRuntimeProvider>
            </SessionEntityStoreProvider>
            </div>
            {/* Voice session component - renders nothing but initializes voice backend */}
            {voice && (
                <VoiceBackendSession
                    api={props.api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                    onReadyChange={setVoiceBackendReady}
                />
            )}
        </div>
    )
}
