import type { Attachment } from '@assistant-ui/react'
import {
    type FormEvent as ReactFormEvent,
    type MutableRefObject,
    type RefObject,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react'
import type { RichComposerInputHandle } from '@/components/AssistantChat/RichComposerInput'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { useComposerDraft } from '@/hooks/useComposerDraft'
import { moveAttachmentId, orderItemsById } from '@/lib/attachmentOrder'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import {
    attachmentDraftRevision,
    persistInactiveComposerAttachments,
    resetInactiveComposerAttachmentVisibility,
    setComposerDraftSnapshot,
    updateComposerDraftTextSnapshot,
} from '@/lib/composer-draft-transfer'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ScratchlistParkResult } from '@/lib/scratchlistAttachmentFlow'
import { composerParkSnapshotUnchanged } from './composerInputHelpers'
import type { ComposerSendError } from './types'

export type ComposerSendAcceptance = {
    attemptId: string | null
}

export type ComposerSendSettlement = {
    attemptId: string
    status: 'success' | 'error'
}

type ComposerAttachmentItem = {
    id: string
    file?: File
    status: { type: string }
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

type ComposerRuntimeApi = {
    composer: () => {
        setText: (text: string) => void
        addAttachment: (file: File) => Promise<void>
        getState: () => {
            text: string
            attachments: readonly Attachment[]
        }
        clearAttachments: () => Promise<void> | void
        send: () => void
    }
}

export interface UseComposerDraftAndSendLifecycleParams {
    api: ComposerRuntimeApi
    sessionId?: string
    active: boolean
    allowSendWhenInactive: boolean
    disabled: boolean
    threadIsDisabled: boolean
    controlledByUser: boolean
    composerText: string
    attachments: readonly ComposerAttachmentItem[]
    orderedAttachments: readonly ComposerAttachmentItem[]
    attachmentOrderRef: MutableRefObject<string[]>
    canRestoreAttachments?: boolean
    onUploadDraftSnapshot?: (text: string, attachments: AttachmentDraftInput[]) => void
    onResumeStoredDraft?: () => void | Promise<void>
    scratchlistMode?: boolean
    onParkScratchlist?: (
        text: string,
        pending: readonly Attachment[],
    ) => Promise<ScratchlistParkResult>
    onScratchlistParkingChange?: (parking: boolean) => void
    pendingScheduleProp?: PendingSchedule | null
    onScheduleProp?: (schedule: PendingSchedule) => void
    onClearScheduleProp?: () => void
    sendError: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (errorId: number) => void
    pendingSendIntentRef?: MutableRefObject<ComposerSendIntent>
    sendAcceptance?: ComposerSendAcceptance | null
    sendSettlement?: ComposerSendSettlement | null
    onExpandedChange?: (expanded: boolean) => void
    richMentionsEnabled: boolean
    richInputRef: RefObject<RichComposerInputHandle | null>
}

export function useComposerDraftAndSendLifecycle(params: UseComposerDraftAndSendLifecycleParams) {
    const {
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
        canRestoreAttachments,
        onUploadDraftSnapshot,
        onResumeStoredDraft,
        scratchlistMode,
        onParkScratchlist,
        onScratchlistParkingChange,
        pendingScheduleProp,
        onScheduleProp,
        onClearScheduleProp,
        sendError,
        onClearSendError,
        onSuppressSendErrorRestore,
        pendingSendIntentRef,
        sendAcceptance,
        sendSettlement,
        onExpandedChange,
        richMentionsEnabled,
        richInputRef,
    } = params

    const [isParkingScratchlist, setIsParkingScratchlist] = useState(false)
    const parkInFlightRef = useRef(false)

    useEffect(() => {
        onScratchlistParkingChange?.(isParkingScratchlist)
    }, [isParkingScratchlist, onScratchlistParkingChange])

    const configurationControlsDisabled = (!active && !allowSendWhenInactive) || isParkingScratchlist
    const controlsDisabled = disabled || threadIsDisabled || configurationControlsDisabled
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasAttachments = attachments.length > 0
    const attachmentsReady = !hasAttachments || attachments.every((attachment) => {
        if (attachment.status.type === 'complete') {
            return true
        }
        if (attachment.status.type !== 'requires-action') {
            return false
        }
        const path = attachment.path
        return typeof path === 'string' && path.length > 0
    })

    const [isExpanded, setIsExpanded] = useState(false)
    const isExpandedRef = useRef(false)
    const onExpandedChangeRef = useRef(onExpandedChange)
    onExpandedChangeRef.current = onExpandedChange
    const setExpanded = useCallback((next: boolean) => {
        isExpandedRef.current = next
        setIsExpanded(next)
        onExpandedChangeRef.current?.(next)
    }, [])

    const lastSendAcceptanceRef = useRef(sendAcceptance)
    const pendingSendAttemptIdRef = useRef<string | null>(null)
    const [showContinueHint, setShowContinueHint] = useState(false)
    // pendingSchedule is controlled externally when onSchedule prop is provided; otherwise local state
    const [pendingScheduleLocal, setPendingScheduleLocal] = useState<PendingSchedule | null>(null)
    const isControlled = onScheduleProp !== undefined
    const pendingSchedule = isControlled ? (pendingScheduleProp ?? null) : pendingScheduleLocal
    const setPendingSchedule = isControlled ? onScheduleProp : setPendingScheduleLocal

    useEffect(() => {
        const acceptance = sendAcceptance
        if (!acceptance || acceptance === lastSendAcceptanceRef.current) return
        lastSendAcceptanceRef.current = acceptance
        if (acceptance.attemptId === null) {
            pendingSendAttemptIdRef.current = null
            setExpanded(false)
            return
        }
        pendingSendAttemptIdRef.current = acceptance.attemptId
        const settlement = sendSettlement
        if (!settlement || settlement.attemptId !== acceptance.attemptId) return
        pendingSendAttemptIdRef.current = null
        if (settlement.status === 'success') setExpanded(false)
    }, [sendAcceptance, sendSettlement, setExpanded])

    // Match the terminal mutation result to the exact accepted attempt. Text
    // failures also expose sendError for draft restoration, while attachment
    // failures intentionally do not, so settlement must be the outcome source.
    useEffect(() => {
        const settlement = sendSettlement
        if (!settlement || settlement.attemptId !== pendingSendAttemptIdRef.current) return
        pendingSendAttemptIdRef.current = null
        if (settlement.status === 'success') setExpanded(false)
    }, [sendSettlement, setExpanded])

    // `composer.text === ''` alone is not enough to identify the empty state
    // created by a send. A user can type and delete a fresh draft before the
    // failed mutation reports back. Keep monotonic interaction generations so
    // history still wins over a visually identical empty composer.
    const userEditGenerationRef = useRef(0)
    const userScheduleGenerationRef = useRef(0)
    const userAttachmentGenerationRef = useRef(0)
    const observedAttachmentIdsRef = useRef(new Set(attachments.map((attachment) => attachment.id)))
    const sendRestoreGuardRef = useRef<{
        userEditGeneration: number
        userScheduleGeneration: number
        userAttachmentGeneration: number
    } | null>(null)
    const prevControlledByUser = useRef(controlledByUser)

    const recordUserEdit = useCallback(() => {
        userEditGenerationRef.current += 1
    }, [])

    const handleUserEdit = useCallback(() => {
        recordUserEdit()
        // Editing the restored text is the operator's "I'm handling it"
        // signal -- drop the inline error so the affordance doesn't shout
        // at them while they fix the message.
        if (sendError && onClearSendError) {
            onClearSendError()
        }
    }, [recordUserEdit, sendError, onClearSendError])

    const attachmentDrafts = orderedAttachments.flatMap((attachment) => {
        if (!attachment.file) return []
        return [{
            id: attachment.id,
            file: attachment.file,
            path: attachment.path,
            previewUrl: attachment.previewUrl,
            uploadSessionId: attachment.uploadSessionId,
        }]
    })
    const attachmentRevision = attachmentDraftRevision(attachmentDrafts)
    const latestComposerTextRef = useRef(composerText)
    latestComposerTextRef.current = composerText
    const attachmentDraftsRef = useRef(attachmentDrafts)
    attachmentDraftsRef.current = attachmentDrafts
    const draftHydration = useComposerDraft(
        sessionId,
        composerText,
        attachmentDrafts,
        canRestoreAttachments ?? active,
        (text) => api.composer().setText(text),
        (file) => api.composer().addAttachment(file),
    )
    const canHydrateAttachments = canRestoreAttachments ?? active
    const hiddenAttachmentStatePending =
        !canHydrateAttachments
        && (draftHydration.sessionId !== sessionId || !draftHydration.complete)
    const hasHiddenAttachments =
        !canHydrateAttachments && draftHydration.hasStoredAttachments
    const hasAnyAttachments = hasAttachments || hasHiddenAttachments
    const blocksScheduling =
        hasAttachments || hasHiddenAttachments || hiddenAttachmentStatePending
    const canSend = (hasText || hasAnyAttachments) && attachmentsReady && !controlsDisabled

    useEffect(() => {
        if (!sessionId) return
        const canHydrate = canRestoreAttachments ?? active
        if (canHydrate) return
        // A remount starts with an empty visible list by design; do not treat
        // previously persisted failed-resume picks as operator removals.
        resetInactiveComposerAttachmentVisibility(sessionId)
    }, [active, canRestoreAttachments, sessionId])

    useEffect(() => {
        if (draftHydration.sessionId !== sessionId || !draftHydration.complete || !sessionId) return
        // Inactive sessions do not restore stored attachments into the adapter.
        // Keep IndexedDB intact when nothing new is visible; when the user did
        // pick files (even if resume failed), merge them into storage so reopen
        // does not drop them.
        const canHydrate = canRestoreAttachments ?? active
        if (canHydrate) {
            setComposerDraftSnapshot(sessionId, composerText, attachmentDraftsRef.current)
            onUploadDraftSnapshot?.(composerText, attachmentDraftsRef.current)
            return
        }
        // Text is cheap (sessionStorage); do not queue a blob merge per keystroke.
        updateComposerDraftTextSnapshot(sessionId, composerText)
    }, [active, attachmentRevision, composerText, draftHydration.complete, draftHydration.sessionId, canRestoreAttachments, onUploadDraftSnapshot, sessionId])

    useEffect(() => {
        if (draftHydration.sessionId !== sessionId || !draftHydration.complete || !sessionId) return
        const canHydrate = canRestoreAttachments ?? active
        if (canHydrate) return
        void persistInactiveComposerAttachments(
            sessionId,
            latestComposerTextRef.current,
            attachmentDraftsRef.current,
        ).catch((error) => {
            console.warn('[composer-draft] inactive persistence failed', error)
        })
    }, [active, attachmentRevision, draftHydration.complete, draftHydration.sessionId, canRestoreAttachments, sessionId])

    // assistant-ui clears `composer.text` synchronously the moment a send is
    // invoked AND `SessionChat.handleSend` clears `pendingSchedule` after the
    // mutation is accepted. A failure must put the text and absolute schedule
    // back as one atomic recovery unit, but only while the composer still
    // reflects that send's cleared state. A blank composer alone is not enough:
    // a user might type then delete a replacement draft before onError arrives.
    const restoredErrorIdRef = useRef<number | null>(null)
    const restoredErrorSnapshotRef = useRef<{ id: number; text: string; observed: boolean } | null>(null)
    useEffect(() => {
        if (!sendError || restoredErrorIdRef.current === sendError.id) {
            return
        }
        if (sendError.restoreSuppressed) {
            // Route retains the error UI for the retry attempt, but this id
            // must never repopulate a composer after a keyed remount.
            restoredErrorIdRef.current = sendError.id
            return
        }

        const guard = sendRestoreGuardRef.current
        // A resolved inactive session navigates to a keyed, fresh composer
        // before the target mutation can fail. That new instance has no local
        // send snapshot, but its zero mount-time generations still prove no
        // user interaction has happened there. Treat that as an implicit guard;
        // any edit, schedule interaction, or newly observed attachment makes
        // the error terminally unsafe just like the explicit snapshot path.
        if (!guard) {
            // The implicit guard is only for a keyed remount. Wait until the
            // session-keyed draft hydration has conclusively run: its RAF may
            // still restore a persisted replacement after this effect.
            if (draftHydration.sessionId !== sessionId || !draftHydration.complete) return
            if (draftHydration.restoredAny) {
                restoredErrorIdRef.current = sendError.id
                onClearSendError?.()
                return
            }
        }
        const interactionChanged = guard
            ? userEditGenerationRef.current !== guard.userEditGeneration
                || userScheduleGenerationRef.current !== guard.userScheduleGeneration
                || userAttachmentGenerationRef.current !== guard.userAttachmentGeneration
            : userEditGenerationRef.current !== 0
                || userScheduleGenerationRef.current !== 0
                || userAttachmentGenerationRef.current !== 0
        const textOrAttachmentChanged = composerText.length !== 0 || attachments.length !== 0

        if (interactionChanged || textOrAttachmentChanged) {
            // This error id is now conclusively unsafe. Do not retry if the
            // user later deletes their replacement text or attachment. Clear
            // route-level state as well: a remount otherwise loses this local
            // consumed marker and can replay the stale error over the draft.
            restoredErrorIdRef.current = sendError.id
            onClearSendError?.()
            return
        }

        if (sendError.mutationStarted && pendingSchedule !== null) {
            // SessionChat clears an accepted send's schedule asynchronously.
            // The mutation's onError can arrive before that parent render, so
            // wait for its null cleared state before restoring text + schedule
            // as one unit. User-selected schedules were rejected above by the
            // schedule generation check.
            return
        }

        restoredErrorIdRef.current = sendError.id
        restoredErrorSnapshotRef.current = { id: sendError.id, text: sendError.text, observed: false }
        api.composer().setText(sendError.text)
        // `scheduledAt` is already absolute (presets resolve at send time), so
        // restore it through the normal controlled schedule path in the same
        // effect as text. For a pre-mutation rejection this updates the still
        // present source schedule to its send-time absolute instant.
        if (sendError.scheduledAt !== null && onScheduleProp) {
            onScheduleProp({ type: 'absolute', ms: sendError.scheduledAt })
        }
    }, [sendError, api, attachments, composerText, draftHydration, onClearSendError, onScheduleProp, pendingSchedule, sessionId])

    // A successful automatic restore keeps its inline error visible so the
    // operator understands why the draft returned. If another path replaces
    // the restored text or inserts an attachment without firing a textarea or
    // rich-input event (scratchlist/queued/draft programmatic writes), consume
    // the route-level error before a keyed remount can replay it over that new
    // state. The exact restored text is intentionally exempt from this check.
    useEffect(() => {
        const restored = restoredErrorSnapshotRef.current
        if (!sendError || !restored || restored.id !== sendError.id) return
        if (!restored.observed) {
            if (composerText === restored.text && attachments.length === 0) {
                restored.observed = true
            }
            return
        }
        if (composerText === restored.text && attachments.length === 0) return
        onClearSendError?.()
    }, [sendError, attachments, composerText, onClearSendError])

    // A user-added attachment must make a recovery unsafe even if it is removed
    // again before the send error arrives. This runs even without a local send
    // guard so a post-resume composer gets the same protection. Attachment IDs
    // already present at mount are the baseline; assistant-ui's send clear only
    // removes IDs and therefore does not look like a user addition.
    useEffect(() => {
        for (const attachment of attachments) {
            if (observedAttachmentIdsRef.current.has(attachment.id)) continue
            observedAttachmentIdsRef.current.add(attachment.id)
            userAttachmentGenerationRef.current += 1
        }
    }, [attachments])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const handleUserSchedule = useCallback((nextPendingSchedule: PendingSchedule) => {
        userScheduleGenerationRef.current += 1
        if (sendError) onClearSendError?.()
        setPendingSchedule(nextPendingSchedule)
    }, [onClearSendError, sendError, setPendingSchedule])

    const handleUserClearSchedule = useCallback(() => {
        userScheduleGenerationRef.current += 1
        if (sendError) onClearSendError?.()
        if (isControlled) {
            onClearScheduleProp?.()
        } else {
            setPendingScheduleLocal(null)
        }
    }, [isControlled, onClearScheduleProp, onClearSendError, sendError])

    // Preserve the original controlled-mode contract: without a parent clear
    // handler the schedule button opens the picker instead of claiming it can
    // clear a value it does not own.
    const onUserClearSchedule = isControlled && !onClearScheduleProp
        ? undefined
        : handleUserClearSchedule

    const resetPendingSendIntent = useCallback(() => {
        if (pendingSendIntentRef) pendingSendIntentRef.current = 'default'
    }, [pendingSendIntentRef])

    const handleSend = useCallback(async (intent: ComposerSendIntent = 'default') => {
        // SessionChat preloads the ref only when restoring a rejected send:
        // queue retries remain queue, while an ordinary fresh send always
        // starts from the explicit/default argument. Capture it before the
        // mandatory early-path reset below, then consume it at send time.
        const restoredIntent = intent === 'default'
            ? (pendingSendIntentRef?.current ?? 'default')
            : intent
        // The runtime consumes this ref from assistant-ui's onNew callback.
        // Clear any prior one-shot value before paths that do not call send(),
        // so a rejected park/schedule path can never leak a stale queue intent
        // into the next normal submission.
        resetPendingSendIntent()

        // Rich chips must be serialized into composer.text before any send or
        // scratchlist park snapshot (RichComposerInput contract).
        if (richMentionsEnabled && richInputRef.current) {
            richInputRef.current.flushSerializedText()
        }

        // Scratchlist parks must not go through assistant-ui's send(): it
        // empties text/chips before onNew, so a rejected add cannot restore
        // retryable composer state (#1226 Major).
        if (
            scratchlistMode
            && pendingSchedule == null
            && onParkScratchlist
        ) {
            if (!canSend || parkInFlightRef.current) return
            parkInFlightRef.current = true
            setIsParkingScratchlist(true)
            try {
                const snapshot = api.composer().getState()
                const prepared = await onParkScratchlist(
                    snapshot.text,
                    orderItemsById(snapshot.attachments, attachmentOrderRef.current),
                )
                if (!prepared) return
                // Validate before irreversible add — otherwise a mid-flight
                // composer edit leaves a parked duplicate while chips remain.
                if (!composerParkSnapshotUnchanged(snapshot, api.composer().getState())) {
                    await prepared.abort()
                    return
                }
                if (!await prepared.commit()) {
                    return
                }
                await prepared.beforeClear()
                api.composer().setText('')
                await api.composer().clearAttachments()
                setExpanded(false)
            } finally {
                parkInFlightRef.current = false
                setIsParkingScratchlist(false)
            }
            return
        }
        // A retry intentionally clears composer state synchronously. It is
        // neither a replacement draft nor a dismissal: route onSuccess/onError
        // owns the inline-error transition for this new attempt. Drop the old
        // restore watcher before the clear so it cannot consume that error.
        restoredErrorSnapshotRef.current = null
        if (sendError) onSuppressSendErrorRestore?.(sendError.id)
        sendRestoreGuardRef.current = {
            userEditGeneration: userEditGenerationRef.current,
            userScheduleGeneration: userScheduleGenerationRef.current,
            userAttachmentGeneration: userAttachmentGenerationRef.current,
        }
        // Scheduled sends retain their existing route. The same is true for a
        // scratchlist route above; only an immediate chat submit may carry the
        // explicit queue intent to SessionChat.
        const effectiveIntent = pendingSchedule == null ? restoredIntent : 'default'
        try {
            if (!hasText && !hasAttachments && draftHydration.hasStoredAttachments) {
                await onResumeStoredDraft?.()
                return
            }
            // Must be adjacent to send(): useHappyRuntime consumes and resets
            // this ref synchronously from assistant-ui's onNew callback.
            if (pendingSendIntentRef) pendingSendIntentRef.current = effectiveIntent
            api.composer().send()
        } catch (error) {
            resetPendingSendIntent()
            throw error
        }
    }, [
        api,
        canSend,
        draftHydration.hasStoredAttachments,
        hasAttachments,
        hasText,
        onSuppressSendErrorRestore,
        pendingSchedule,
        onParkScratchlist,
        onResumeStoredDraft,
        scratchlistMode,
        richMentionsEnabled,
        richInputRef,
        sendError,
        attachmentOrderRef,
        pendingSendIntentRef,
        resetPendingSendIntent,
        setExpanded,
    ])

    const flushAndSend = useCallback((intent: ComposerSendIntent = 'default') => {
        void handleSend(intent)
    }, [handleSend])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        event?.preventDefault()
        if (!attachmentsReady) {
            return
        }
        setShowContinueHint(false)
    }, [attachmentsReady])

    return {
        isParkingScratchlist,
        configurationControlsDisabled,
        controlsDisabled,
        hasText,
        hasAttachments,
        attachmentsReady,
        hasHiddenAttachments,
        blocksScheduling,
        canSend,
        isExpanded,
        isExpandedRef,
        setExpanded,
        showContinueHint,
        setShowContinueHint,
        pendingSchedule,
        recordUserEdit,
        handleUserEdit,
        handleUserSchedule,
        onUserClearSchedule,
        handleSend,
        flushAndSend,
        handleSubmit,
    }
}
