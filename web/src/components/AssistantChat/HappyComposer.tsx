import type { Attachment } from '@assistant-ui/react'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import type { MutableRefObject } from 'react'
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type { ApiClient } from '@/api/client'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import { ComposerParkingContext } from '@/components/AssistantChat/composerParkingContext'
import { RichComposerInput } from '@/components/AssistantChat/RichComposerInput'
import type {
    RichComposerInputHandle,
    SessionMentionResolveResult,
} from '@/components/AssistantChat/RichComposerInput'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { SortableComposerAttachments } from '@/components/AssistantChat/SortableComposerAttachments'
import { shouldShowComposerStatusBar, StatusBar } from '@/components/AssistantChat/StatusBar'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { FueCallout, FueDot } from '@/components/Fue'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import { isRichComposerMentionsEnabled, resolveComposerPlaceholderKey } from '@/lib/composerSegments'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ScratchlistParkResult } from '@/lib/scratchlistAttachmentFlow'
import { useFue } from '@/lib/use-fue'
import { useTranslation } from '@/lib/use-translation'
import type { ConversationStatus } from '@/realtime/types'
import type { AgentState, GitStatusFiles, ThreadGoal } from '@/types/api'
import type { ComposerFlavorPropsInput } from './composer/ComposerSettingsSheet'
import {
    ComposerSettingsSheet,
    normalizeComposerFlavorProps,
    useComposerSettingsSheet,
} from './composer/ComposerSettingsSheet'
import {
    useComposerDictationController,
    useComposerKeyboardAndInputHandlers,
    useOrderedComposerAttachments,
} from './composer/composerInputHelpers'
import type {
    ComposerSendError,
    SessionFlavorModelController,
} from './composer/types'
import { useComposerDraftAndSendLifecycle } from './composer/useComposerDraftAndSendLifecycle'
const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export interface HappyComposerProps extends ComposerFlavorPropsInput {
    sessionId?: string
    onUploadDraftSnapshot?: (text: string, attachments: AttachmentDraftInput[]) => void
    canRestoreAttachments?: boolean
    disabled?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    activityLabel?: string | null
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    /** Model for the context-window heuristic; see StatusBar.contextModel. */
    contextModel?: string | null
    threadGoal?: ThreadGoal | null
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    // Voice assistant props
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle?: () => void
    onVoiceMicToggle?: () => void
    voiceTranscriptionApi?: ApiClient
    // Schedule props (lifted from internal state when provided)
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    // Scratchlist drawer props - SessionChat owns the state. Threaded
    // straight through to ComposerButtons. When undefined, the toggle
    // button doesn't render (back-compat for any other consumer).
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    /**
     * Prepare a scratchlist park (migrate only). Caller validates the
     * composer snapshot, then commit()/abort()/beforeClear().
     */
    onParkScratchlist?: (
        text: string,
        pending: readonly Attachment[],
    ) => Promise<ScratchlistParkResult>
    /** Parent disables DragDropZone / scratchlist promote while park is in flight. */
    onScratchlistParkingChange?: (parking: boolean) => void
    // Set when the most recent send failed (4xx/5xx/network).  The composer
    // restores the original text once per `sendError.id` and renders an
    // inline error affordance until the user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    /** Emitted by SessionChat after a send is accepted. Null attempt ids are settled scratchlist sends. */
    sendAcceptance?: { attemptId: string | null } | null
    /** Terminal result for a chat mutation, including attachment-bearing failures. */
    sendSettlement?: { attemptId: string; status: 'success' | 'error' } | null
    /** Notifies the chat shell so the floating dock can yield the screen while expanded. */
    onExpandedChange?: (expanded: boolean) => void
    /**
     * Resume/handoff path for inactive drafts that only exist in IndexedDB
     * (no visible text/attachments for assistant-ui to append).
     */
    onResumeStoredDraft?: () => void | Promise<void>
    /**
     * One-shot intent bridge consumed by useHappyRuntime's onNew callback.
     * SessionChat owns this ref so the composer never retains an explicit
     * queue request after a scratchlist/scheduled/failed early path.
     */
    pendingSendIntentRef?: MutableRefObject<ComposerSendIntent>
    /** Shared order ref consumed by useHappyRuntime when the message is sent. */
    attachmentOrderRef?: MutableRefObject<string[]>
    /** Chip hover / aria-label resolver (SessionChat → useSessions). */
    resolveSessionMentionTooltip?: (id: string, title: string) => SessionMentionResolveResult
    gitBranch?: string | null
    gitStatus?: GitStatusFiles | null
    onViewFiles?: () => void
}

export function HappyComposer(props: HappyComposerProps) {
    const { t } = useTranslation()
    const flavor = normalizeComposerFlavorProps(props)
    const {
        sessionId,
        disabled = false,
        allowSendWhenInactive = false,
        thinking = false,
        agentState = null,
        activityLabel = null,
        backgroundTaskCount,
        contextSize,
        contextCacheRead,
        contextModel,
        threadGoal,
        onTerminal,
        terminalUnsupported = false,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
        voiceStatus = 'disconnected',
        voiceMicMuted = false,
        onVoiceToggle,
        onVoiceMicToggle,
        pendingSchedule: pendingScheduleProp,
        onSchedule: onScheduleProp,
        onClearSchedule: onClearScheduleProp,
        sendError = null,
        onClearSendError,
        onSuppressSendErrorRestore,
        pendingSendIntentRef,
        attachmentOrderRef: externalAttachmentOrderRef,
        resolveSessionMentionTooltip,
    } = props

    const {
        agentFlavor,
        active,
        controlledByUser,
        permissionMode,
        collaborationMode,
        copilotAgentMode,
        model,
        modelReasoningEffort,
        effort,
        contextWindow,
        availableModelOptions,
        ompThinkingState,
        onPermissionModeChange,
        onModelChange,
        onCycleModel,
        serviceTier,
        onSwitchToRemote,
    } = flavor
    const api = useAui()
    const composerText = useAuiState((s) => s.composer.text)
    const attachments = useAuiState((s) => s.composer.attachments)
    const {
        attachmentOrderRef,
        orderedAttachmentIds,
        orderedAttachments,
        handleAttachmentReorder,
    } = useOrderedComposerAttachments(attachments, externalAttachmentOrderRef)
    const threadIsRunning = useAuiState((s) => s.thread.isRunning)
    const threadIsDisabled = useAuiState((s) => s.thread.isDisabled)

    const {
        dictation,
        dictationActive,
        effectiveVoiceStatus,
        effectiveVoiceToggle,
    } = useComposerDictationController({
        api,
        composerText,
        voiceTranscriptionApi: props.voiceTranscriptionApi,
        voiceStatus,
        onVoiceToggle,
    })

    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const richInputRef = useRef<RichComposerInputHandle>(null)
    const richComposerFueAnchorRef = useRef<HTMLDivElement>(null)
    // Kill-switch only (?richMentions=0 / localStorage=0 / VITE=false). Mount-time
    // read — hard reload required, so no per-keystroke localStorage/URL parse.
    const [richMentionsEnabled] = useState(() => isRichComposerMentionsEnabled())
    const {
        status: richComposerFueStatus,
        engage: engageRichComposerFue,
        dismiss: dismissRichComposerFue,
    } = useFue('rich-composer-mentions')

    // Composer itself is the affordance: open the FUE callout once the rich
    // path is live. Relying on DOM focus alone is flaky (programmatic
    // autofocus / Playwright headless often skip the focus event).
    useEffect(() => {
        if (!richMentionsEnabled) return
        engageRichComposerFue()
    }, [richMentionsEnabled, engageRichComposerFue])

    const {
        isParkingScratchlist,
        configurationControlsDisabled,
        controlsDisabled,
        canSend,
        blocksScheduling,
        isExpanded,
        isExpandedRef,
        setExpanded,
        showContinueHint,
        setShowContinueHint,
        pendingSchedule,
        handleUserSchedule,
        onUserClearSchedule,
        recordUserEdit,
        handleUserEdit,
        handleSend,
        flushAndSend,
        handleSubmit,
    } = useComposerDraftAndSendLifecycle({
        api,
        sessionId,
        active,
        allowSendWhenInactive,
        disabled,
        threadIsDisabled,
        controlledByUser,
        composerText,
        attachments,
        orderedAttachments,
        attachmentOrderRef,
        canRestoreAttachments: props.canRestoreAttachments,
        onUploadDraftSnapshot: props.onUploadDraftSnapshot,
        onResumeStoredDraft: props.onResumeStoredDraft,
        scratchlistMode: props.scratchlistMode,
        onParkScratchlist: props.onParkScratchlist,
        onScratchlistParkingChange: props.onScratchlistParkingChange,
        pendingScheduleProp,
        onScheduleProp,
        onClearScheduleProp,
        sendError,
        onClearSendError,
        onSuppressSendErrorRestore,
        pendingSendIntentRef,
        sendAcceptance: props.sendAcceptance,
        sendSettlement: props.sendSettlement,
        onExpandedChange: props.onExpandedChange,
        richMentionsEnabled,
        richInputRef,
    })

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const { isStandalone, isIOS } = usePWAInstall()
    const isIOSPWA = isIOS && isStandalone
    const bottomPaddingClass = isIOSPWA ? 'pb-0' : 'pb-3'

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const abortDisabled = controlsDisabled || isAborting || !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal || terminalUnsupported)
    const terminalDisabled = controlsDisabled || terminalUnsupported
    const terminalLabel = terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal')
    const showAbortButton = true
    const voiceEnabled = Boolean(effectiveVoiceToggle)

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const {
        showSettings,
        settingsSection,
        settingsButtonRef,
        modelValueButtonRef,
        effortValueButtonRef,
        permissionModes,
        showSettingsButton,
        modelEffortControlsDisabled,
        modelValueLabel,
        effortValueLabel,
        handleGearToggle,
        handleModelValueToggle,
        handleEffortValueToggle,
        hasVisibleSettingsSheet,
        sheetProps,
    } = useComposerSettingsSheet({
        ...flavor,
        controlsDisabled,
        configurationControlsDisabled,
        haptic,
    })

    const {
        suggestions,
        selectedIndex,
        handleRichValueChange,
        handleRichMirrorChange,
        handleRichEdit,
        handleExpandedToggle,
        handleSuggestionSelect,
        handleKeyDown,
        handleChange,
        handleSelect,
        handlePaste,
    } = useComposerKeyboardAndInputHandlers({
        api,
        composerText,
        richMentionsEnabled,
        textareaRef,
        richInputRef,
        autocompletePrefixes,
        autocompleteSuggestions,
        isExpanded,
        isExpandedRef,
        setExpanded,
        setShowContinueHint,
        canSend,
        flushAndSend,
        threadIsRunning,
        handleAbort,
        richComposerFueStatus,
        dismissRichComposerFue,
        permissionMode,
        permissionModes,
        onPermissionModeChange,
        agentFlavor,
        model,
        availableModelOptions,
        onModelChange,
        onCycleModel,
        pendingSchedule,
        sendError,
        onClearSendError,
        recordUserEdit,
        handleUserEdit,
        haptic,
    })

    const overlayPositionClass = isExpanded
        ? 'absolute z-10 bottom-12 mb-2'
        : 'absolute z-10 bottom-[100%] mb-2'

    const overlays = useMemo(() => {
        if (hasVisibleSettingsSheet) {
            return <ComposerSettingsSheet {...sheetProps} overlayPositionClass={overlayPositionClass} />
        }

        if (suggestions.length > 0) {
            return (
                <div className={`${overlayPositionClass} w-full`}>
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        hasVisibleSettingsSheet,
        sheetProps,
        suggestions,
        selectedIndex,
        handleSuggestionSelect,
        overlayPositionClass,
    ])

    const [inlineLeadingSlot, setInlineLeadingSlot] = useState<HTMLDivElement | null>(null)
    const [inlineTrailingSlot, setInlineTrailingSlot] = useState<HTMLDivElement | null>(null)
    const shellClassName = isExpanded
        ? `z-[60] flex min-h-0 flex-col bg-[var(--app-bg)] px-3 ${bottomPaddingClass} max-sm:fixed max-sm:inset-x-0 max-sm:top-0 max-sm:h-[var(--tg-viewport-stable-height,var(--app-viewport-height,100dvh))] max-sm:pt-[calc(0.5rem+env(safe-area-inset-top))] sm:absolute sm:inset-0 sm:pt-2`
        : `composer-floating-shell${isIOSPWA ? ' composer-floating-shell-ios-pwa' : ''}`
    const innerClassName = isExpanded
        ? 'mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col'
        : 'pointer-events-auto relative mx-auto w-full max-w-content'
    const rootClassName = isExpanded
        ? 'relative flex min-h-0 flex-1 flex-col'
        : 'relative'
    const editorClassName = isExpanded
        ? 'app-input-text h-full min-h-[var(--app-line-input)] flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[var(--app-fg)] outline-none outline-0 focus:outline-none focus-visible:outline-none focus-visible:outline-0'
        : 'app-input-text max-h-[7.5rem] min-h-[var(--app-line-input)] flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[var(--app-fg)] outline-none outline-0 focus:outline-none focus-visible:outline-none focus-visible:outline-0'
    const frameClassName = `overflow-hidden ${
        isExpanded
            ? 'flex min-h-0 flex-1 flex-col rounded-[20px] bg-[var(--app-secondary-bg)]'
            : 'composer-floating-frame backdrop-blur-md'
    } ${sendError ? 'ring-1 ring-[var(--app-badge-error-text)]' : ''}`

    return (
        <ComposerParkingContext.Provider value={isParkingScratchlist}>
            <div
                className={shellClassName}
                data-testid="composer-shell"
                data-expanded={isExpanded || undefined}
                data-floating={isExpanded ? undefined : 'true'}
            >
                <div className={innerClassName}>
                    <ComposerPrimitive.Root className={rootClassName} onSubmit={handleSubmit}>
                        {overlays}

                        {shouldShowComposerStatusBar(agentFlavor) ? (
                            <StatusBar
                                active={active}
                                thinking={thinking}
                                agentState={agentState}
                                activityLabel={activityLabel}
                                backgroundTaskCount={backgroundTaskCount}
                                contextSize={contextSize}
                                contextCacheRead={contextCacheRead}
                                contextWindow={contextWindow}
                                contextModel={contextModel}
                                model={model}
                                modelReasoningEffort={modelReasoningEffort}
                                effort={effort}
                                ompThinkingState={ompThinkingState}
                                serviceTier={serviceTier}
                                permissionMode={permissionMode}
                                collaborationMode={collaborationMode}
                                copilotAgentMode={copilotAgentMode}
                                threadGoal={threadGoal}
                                agentFlavor={agentFlavor}
                                voiceStatus={effectiveVoiceStatus}
                                gitBranch={props.gitBranch}
                                gitStatus={props.gitStatus}
                                onViewFiles={props.onViewFiles}
                                hideContextUsage
                            />
                        ) : null}

                        {dictationActive && dictation.partialTranscript ? (
                            <div
                                role="status"
                                aria-live="polite"
                                className="mb-2 max-h-20 overflow-y-auto rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            >
                                {dictation.partialTranscript}
                            </div>
                        ) : null}

                        {dictationActive && dictation.error ? (
                            <div role="alert" className="mb-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-badge-error-text)]">
                                {dictation.error}
                            </div>
                        ) : null}

                        {sendError ? (
                            <div
                                role="alert"
                                data-testid="composer-send-error"
                                className="mb-2 flex items-center justify-between gap-3 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-badge-error-text)]"
                            >
                                <span className="flex-1">{sendError.message}</span>
                                {sendError.action ? (
                                    <button
                                        type="button"
                                        data-testid="composer-send-error-action"
                                        onClick={sendError.action.onClick}
                                        disabled={sendError.action.pending}
                                        className="shrink-0 rounded-md border border-[var(--app-badge-error-border)] px-2 py-1 text-xs font-medium text-[var(--app-badge-error-text)] hover:bg-[var(--app-badge-error-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {sendError.action.label}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}

                        <div data-testid="composer-frame" className={frameClassName}>
                            {attachments.length > 0 ? (
                                <div className={`flex flex-wrap gap-2 px-4 pt-3 ${
                                    isExpanded ? 'max-h-[35%] shrink-0 overflow-y-auto' : ''
                                }`}>
                                    <SortableComposerAttachments
                                        attachments={attachments}
                                        orderedAttachmentIds={orderedAttachmentIds}
                                        disabled={controlsDisabled}
                                        onReorder={handleAttachmentReorder}
                                    />
                                </div>
                            ) : null}

                            <div className={`flex gap-2.5 px-3.5 py-2.5 ${
                                isExpanded ? 'min-h-0 flex-1 items-stretch' : 'items-center'
                            }`}>
                                <div
                                    ref={setInlineLeadingSlot}
                                    data-testid="composer-inline-leading"
                                    className={`flex shrink-0 items-center ${isExpanded ? 'self-end pb-0.5' : ''}`}
                                />
                                {richMentionsEnabled ? (
                                    <div
                                        ref={richComposerFueAnchorRef}
                                        className="relative flex min-w-0 flex-1"
                                        data-testid="rich-composer-fue-anchor"
                                    >
                                        <RichComposerInput
                                            ref={richInputRef}
                                            value={composerText}
                                            autoFocus={!controlsDisabled && !isTouch}
                                            placeholder={t(resolveComposerPlaceholderKey({
                                                richMentionsEnabled: true,
                                                showContinueHint,
                                            }))}
                                            disabled={controlsDisabled}
                                            onValueChange={handleRichValueChange}
                                            onMirrorChange={handleRichMirrorChange}
                                            onKeyDown={handleKeyDown}
                                            onPaste={handlePaste}
                                            onFocus={() => engageRichComposerFue()}
                                            resolveSessionMentionTooltip={resolveSessionMentionTooltip}
                                            onEdit={handleRichEdit}
                                            className={editorClassName}
                                        />
                                        {richComposerFueStatus !== 'acknowledged' ? (
                                            <FueDot
                                                pulsing={richComposerFueStatus === 'unseen'}
                                                ariaLabel={t('fue.newFeatureDot')}
                                            />
                                        ) : null}
                                    </div>
                                ) : isExpanded ? (
                                    <ComposerPrimitive.Input
                                        asChild
                                        ref={textareaRef}
                                        autoFocus={!controlsDisabled && !isTouch}
                                        submitOnEnter={false}
                                        cancelOnEscape={false}
                                        onChange={handleChange}
                                        onSelect={handleSelect}
                                        onKeyDown={handleKeyDown}
                                        onPaste={handlePaste}
                                    >
                                        <textarea
                                            placeholder={t(resolveComposerPlaceholderKey({
                                                richMentionsEnabled: false,
                                                showContinueHint,
                                            }))}
                                            disabled={controlsDisabled}
                                            className="app-input-text h-full min-h-0 flex-1 resize-none overflow-y-auto bg-transparent text-[var(--app-fg)] placeholder-[var(--app-hint)] outline-none outline-0 focus:outline-none focus-visible:outline-none focus-visible:outline-0 disabled:cursor-not-allowed disabled:opacity-50"
                                        />
                                    </ComposerPrimitive.Input>
                                ) : (
                                    <ComposerPrimitive.Input
                                        ref={textareaRef}
                                        autoFocus={!controlsDisabled && !isTouch}
                                        placeholder={t(resolveComposerPlaceholderKey({
                                            richMentionsEnabled: false,
                                            showContinueHint,
                                        }))}
                                        disabled={controlsDisabled}
                                        maxRows={5}
                                        submitOnEnter={false}
                                        cancelOnEscape={false}
                                        onChange={handleChange}
                                        onSelect={handleSelect}
                                        onKeyDown={handleKeyDown}
                                        onPaste={handlePaste}
                                        className="app-input-text flex-1 resize-none bg-transparent text-[var(--app-fg)] placeholder-[var(--app-hint)] outline-none outline-0 focus:outline-none focus-visible:outline-none focus-visible:outline-0 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                )}
                                <div
                                    ref={setInlineTrailingSlot}
                                    data-testid="composer-inline-trailing"
                                    className={`flex shrink-0 items-center gap-1.5 ${isExpanded ? 'self-end pb-0.5' : ''}`}
                                />
                            </div>
                            {richMentionsEnabled && richComposerFueStatus === 'engaging' ? (
                                <FueCallout
                                    title={t('richComposer.fueTitle')}
                                    body={t('richComposer.fueBody')}
                                    onDismiss={dismissRichComposerFue}
                                    dismissLabel={t('fue.gotIt')}
                                    closeAriaLabel={t('fue.closeAriaLabel')}
                                    anchorRef={richComposerFueAnchorRef}
                                    width={288}
                                />
                            ) : null}
                        </div>

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showSettingsButton={showSettingsButton}
                            settingsButtonRef={settingsButtonRef}
                            settingsDisabled={modelEffortControlsDisabled}
                            modelValueButtonRef={modelValueButtonRef}
                            effortValueButtonRef={effortValueButtonRef}
                            onSettingsToggle={handleGearToggle}
                            expanded={isExpanded}
                            onExpandedToggle={handleExpandedToggle}
                            showTerminalButton={showTerminalButton}
                            terminalDisabled={terminalDisabled}
                            terminalLabel={terminalLabel}
                            onTerminal={onTerminal ?? (() => {})}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                            showSwitchButton={showSwitchButton}
                            switchDisabled={switchDisabled}
                            isSwitching={isSwitching}
                            onSwitch={handleSwitch}
                            voiceEnabled={voiceEnabled}
                            dictationEnabled={dictationActive}
                            voiceStatus={effectiveVoiceStatus}
                            voiceMicMuted={dictationActive ? false : voiceMicMuted}
                            onVoiceToggle={effectiveVoiceToggle ?? (() => {})}
                            onVoiceMicToggle={dictationActive ? undefined : onVoiceMicToggle}
                            onSend={handleSend}
                            pendingSchedule={pendingSchedule}
                            onSchedule={handleUserSchedule}
                            onClearSchedule={onUserClearSchedule}
                            hasAttachments={blocksScheduling}
                            modelValueLabel={modelValueLabel}
                            modelValueDisabled={modelEffortControlsDisabled}
                            modelValueOpen={showSettings && settingsSection !== 'effort'}
                            onModelValueToggle={handleModelValueToggle}
                            effortValueLabel={effortValueLabel}
                            effortValueDisabled={modelEffortControlsDisabled}
                            effortValueOpen={showSettings && settingsSection !== 'model'}
                            onEffortValueToggle={handleEffortValueToggle}
                            scratchlistMode={props.scratchlistMode}
                            scratchlistCount={props.scratchlistCount}
                            onScratchlistToggle={props.onScratchlistToggle}
                            inlineLeadingSlot={inlineLeadingSlot}
                            inlineTrailingSlot={inlineTrailingSlot}
                            contextSize={contextSize}
                            contextCacheRead={contextCacheRead}
                            contextWindow={contextWindow}
                            contextModel={contextModel}
                            model={model}
                            agentFlavor={agentFlavor}
                        />
                    </ComposerPrimitive.Root>
                </div>
            </div>
        </ComposerParkingContext.Provider>
    )
}
