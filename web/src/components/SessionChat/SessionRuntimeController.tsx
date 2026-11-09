import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { isSteeringSupportedForSession } from '@hapi/protocol'
import type { SessionEntityStoreSnapshot } from '@/chat/store/sessionEntityStore'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import { HappyComposer, type HappyComposerProps } from '@/components/AssistantChat/HappyComposer'
import { useSessionFlavorModelController } from '@/components/AssistantChat/composer/useSessionFlavorModelController'
import { useSessionComposerSendBridge } from '@/components/AssistantChat/composer/useSessionComposerSendBridge'
import { useSessionMentionTooltipResolver } from '@/components/AssistantChat/SessionChatSurfaces'
import { ScratchlistMigrationBanner } from '@/components/AssistantChat/ScratchlistMigrationBanner'
import { COMPOSER_DOCK_SLOTS, ChatSlotHost, type ComposerDockSlotContext } from '@/components/AssistantChat/slotRegistry'
import { ShareSeedConsumer } from '@/components/ShareSeedConsumer'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSessionTodoSnapshot } from '@/hooks/queries/useSession'
import { VoiceBackendSession, useSessionVoiceBridge } from '@/hooks/useSessionVoiceBridge'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import type { ScratchlistMigrationStatus } from '@/lib/use-hub-scratchlist'
import { useTranslation } from '@/lib/use-translation'
import type { Session } from '@/types/api'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import {
    sameShallowSelection,
    selectHasRunningChildAgent,
    selectTimelineVersion,
    selectVisibleMessageCount,
    useSessionControlSession,
    useSessionSurfaceSelector,
} from './sessionState'
import type { SessionSurfaceProps } from './types'

type RuntimeComposerValue = {
    session: Session
    composerProps: HappyComposerProps
    dockContext: Omit<ComposerDockSlotContext, 'todos'>
    migrationStatus: ScratchlistMigrationStatus
    dismissMigrationBanner: () => void
    codexModelsError: string | null
}

const RuntimeComposerContext = createContext<RuntimeComposerValue | null>(null)
const selectRuntimeBlocks = (snapshot: SessionEntityStoreSnapshot) => snapshot.blocksWithThreadIds

/** Own all send-time capabilities synchronously, and preserve children identity. */
export function SessionRuntimeController(props: SessionSurfaceProps & {
    children: ReactNode
    onAcceptedChatSend: () => void
}) {
    const session = useSessionControlSession(props.api, props.sessionId, props.session)
    const visibleMessagesCount = useSessionSurfaceSelector(props.entityStore, selectVisibleMessageCount)
    const hasRunningChildAgent = useSessionSurfaceSelector(props.entityStore, selectHasRunningChildAgent)
    const timelineVersion = useSessionSurfaceSelector(props.entityStore, selectTimelineVersion)
    const runtimeBlocks = useSessionSurfaceSelector(props.entityStore, selectRuntimeBlocks)
    const inactiveCanResume = inactiveSessionCanResume(session, visibleMessagesCount, props.cursorChatOnDisk)
    const flavorController = useSessionFlavorModelController({
        api: props.api,
        session,
        onRefresh: props.onRefresh,
    })
    const sendBridge = useSessionComposerSendBridge({
        api: props.api,
        session,
        agentFlavor: flavorController.agentFlavor,
        inactiveCanResume,
        onSend: props.onSend,
        resolveSessionIdForUpload: props.resolveSessionIdForUpload,
        onUploadSessionResolved: props.onUploadSessionResolved,
        sendError: props.sendError,
        onClearSendError: props.onClearSendError,
        onAcceptedChatSend: props.onAcceptedChatSend,
    })
    const voiceBridge = useSessionVoiceBridge({
        api: props.api,
        session,
        messages: props.messages,
        onSend: props.onSend,
        onRefresh: props.onRefresh,
    })
    const runtimeInputs = {
        entityStore: props.entityStore,
        session,
        blocksWithThreadIds: runtimeBlocks,
        messagesVersion: timelineVersion,
        historyVersion: props.historyVersion,
        viewMode: props.viewMode,
        isSyncingTail: props.isSyncingTail,
        isLoadingMore: props.isLoadingMoreMessages,
        isSending: props.isSending,
        isRunning: session.thinking || hasRunningChildAgent,
        onSendMessage: sendBridge.handleSend,
        attachmentOrderRef: sendBridge.attachmentOrderRef,
        onAbort: flavorController.handleAbort,
        attachmentAdapter: sendBridge.attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef: sendBridge.pendingScheduleRef,
        pendingSendIntentRef: sendBridge.pendingSendIntentRef,
    }
    const runtime = useHappyRuntime(runtimeInputs)
    const exitScratchlistMode = useCallback(() => sendBridge.setScratchlistMode(false), [sendBridge.setScratchlistMode])
    const clearSchedule = useCallback(() => sendBridge.updatePendingSchedule(null), [sendBridge.updatePendingSchedule])
    const resumeStoredDraft = useCallback(() => sendBridge.handleSend('', undefined, null), [sendBridge.handleSend])
    const { voice } = voiceBridge
    const terminalSupported = isRemoteTerminalSupported(session.metadata)
    const value: RuntimeComposerValue = {
        session,
        composerProps: {
            sessionId: props.sessionId,
            canRestoreAttachments: session.active,
            attachmentOrderRef: sendBridge.attachmentOrderRef,
            disabled: props.isSending,
            pendingSchedule: sendBridge.pendingSchedule,
            sendAcceptance: sendBridge.sendAcceptance,
            sendSettlement: props.sendSettlement,
            onSchedule: sendBridge.updatePendingSchedule,
            onClearSchedule: clearSchedule,
            flavorController,
            active: session.active,
            allowSendWhenInactive: true,
            onResumeStoredDraft: resumeStoredDraft,
            thinking: session.thinking,
            agentState: session.agentState,
            backgroundTaskCount: session.backgroundTaskCount,
            onSwitchToRemote: flavorController.handleSwitchToRemote,
            terminalUnsupported: session.active && !terminalSupported,
            autocompleteSuggestions: props.autocompleteSuggestions,
            voiceStatus: voice?.status,
            voiceMicMuted: voice?.micMuted,
            onVoiceToggle: voice && voiceBridge.voiceBackendReady ? voiceBridge.handleVoiceToggle : undefined,
            onVoiceMicToggle: voice && voiceBridge.voiceBackendReady ? voiceBridge.handleVoiceMicToggle : undefined,
            voiceTranscriptionApi: props.api,
            scratchlistMode: sendBridge.scratchlistMode,
            scratchlistCount: sendBridge.scratchlist.entries.length,
            onScratchlistToggle: sendBridge.handleScratchlistToggle,
            onParkScratchlist: sendBridge.onParkScratchlist,
            onScratchlistParkingChange: sendBridge.setIsScratchlistParking,
            sendError: props.sendError ?? null,
            onClearSendError: sendBridge.handleClearSendError,
            onSuppressSendErrorRestore: props.onSuppressSendErrorRestore,
            pendingSendIntentRef: sendBridge.pendingSendIntentRef,
            gitBranch: session.metadata?.worktree?.branch ?? null,
        },
        dockContext: {
            sessionId: props.sessionId,
            api: props.api,
            sessionThinking: session.thinking,
            scratchlistMode: sendBridge.scratchlistMode,
            scratchlistEntries: sendBridge.scratchlist.entries,
            onScratchlistMove: sendBridge.scratchlist.move,
            onScratchlistDelete: sendBridge.scratchlist.remove,
            onSend: props.onSend,
            onExitScratchlistMode: exitScratchlistMode,
            scratchlistDisabled: props.isSending || sendBridge.isScratchlistParking,
            pendingSchedule: sendBridge.pendingSchedule,
            pendingScheduleRevision: sendBridge.pendingScheduleRevision,
            onRestorePendingSchedule: sendBridge.updatePendingSchedule,
            canSteer: isSteeringSupportedForSession(session.metadata)
                && (flavorController.agentFlavor === 'pi' ? session.thinking : session.agentState?.steeringActive === true)
                && !flavorController.controlledByUser,
        },
        migrationStatus: sendBridge.scratchlist.migrationStatus,
        dismissMigrationBanner: sendBridge.scratchlist.dismissMigrationBanner,
        codexModelsError: flavorController.codexCollaborationModeSupported ? flavorController.codexModelsError : null,
    }
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <RuntimeComposerContext.Provider value={value}>
                <ShareSeedConsumer sessionId={props.sessionId} sessionActive={session.active} />
                <DragDropZone disabled={(!session.active && !inactiveCanResume) || props.isSending || sendBridge.pendingSchedule != null || sendBridge.isScratchlistParking}>
                    {props.children}
                </DragDropZone>
                {voice ? (
                    <VoiceBackendSession
                        api={props.api}
                        micMuted={voice.micMuted}
                        onStatusChange={voice.setStatus}
                        onReadyChange={voiceBridge.setVoiceBackendReady}
                    />
                ) : null}
            </RuntimeComposerContext.Provider>
        </AssistantRuntimeProvider>
    )
}

function selectComposerMeta(snapshot: SessionEntityStoreSnapshot) {
    return {
        latestGoal: snapshot.latestGoal,
        latestUsage: snapshot.latestUsage,
        activityLabel: snapshot.activityLabel,
    }
}

export function SessionComposerSection(props: SessionSurfaceProps & {
    composerFloating: boolean
    onExpandedChange: (expanded: boolean) => void
    onViewFiles: () => void
    onViewTerminal: () => void
}) {
    const controller = useContext(RuntimeComposerContext)
    if (!controller) throw new Error('SessionRuntimeController is missing')
    const { t } = useTranslation()
    const todos = useSessionTodoSnapshot(props.api, props.sessionId, props.session)
    const meta = useSessionSurfaceSelector(props.entityStore, selectComposerMeta, sameShallowSelection)
    const { status: gitStatus } = useGitStatusFiles(props.api, controller.session.active ? props.sessionId : null)
    const resolveSessionMentionTooltip = useSessionMentionTooltipResolver(props.api)
    const { composerProps, session } = controller
    const dockContext = useMemo<ComposerDockSlotContext>(() => ({
        ...controller.dockContext,
        todos: todos?.todos,
    }), [controller.dockContext, todos?.todos])
    const terminalSupported = isRemoteTerminalSupported(session.metadata)
    return (
        <>
            <div className="pointer-events-auto">
                {controller.codexModelsError ? (
                    props.composerFloating ? (
                        <div className="composer-floating-chrome">
                            <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">
                                {t('session.codexModelsLoadFailed')}: {controller.codexModelsError}
                            </div>
                        </div>
                    ) : (
                        <div className="px-3 pb-2">
                            <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">
                                {t('session.codexModelsLoadFailed')}: {controller.codexModelsError}
                            </div>
                        </div>
                    )
                ) : null}
                <ScratchlistMigrationBanner migrationStatus={controller.migrationStatus} onDismiss={controller.dismissMigrationBanner} />
                <div className="px-3">
                    <ChatSlotHost slots={COMPOSER_DOCK_SLOTS} resetKey={props.sessionId} ctx={dockContext} />
                </div>
            </div>
            <HappyComposer
                {...composerProps}
                key={`composer-${props.sessionId}`}
                onExpandedChange={props.onExpandedChange}
                resolveSessionMentionTooltip={resolveSessionMentionTooltip}
                threadGoal={meta.latestGoal}
                activityLabel={meta.activityLabel}
                contextSize={meta.latestUsage?.contextSize}
                contextCacheRead={meta.latestUsage?.cacheRead}
                contextWindow={meta.latestUsage?.contextWindow ?? composerProps.flavorController?.piContextWindow}
                contextModel={meta.latestUsage?.model ?? session.model}
                onTerminal={session.active && terminalSupported ? props.onViewTerminal : undefined}
                gitStatus={gitStatus}
                onViewFiles={session.active ? props.onViewFiles : undefined}
            />
        </>
    )
}
