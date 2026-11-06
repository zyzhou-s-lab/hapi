import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, Session } from '@/types/api'
import type { ComposerSendError } from './types'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { useHubScratchlist } from '@/lib/use-hub-scratchlist'
import {
    getRestoredComposerSendIntent,
    resolveMessageDeliveryMode,
    type ComposerSendIntent,
} from '@/lib/messageDelivery'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { isHubScratchlistAttachmentPath } from '@hapi/protocol'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import {
    createScratchlistAttachmentAdapter,
    type ScratchlistAttachmentAdapter,
} from '@/lib/scratchlistAttachmentAdapter'
import {
    attachmentsNeedScratchlistMigration,
    finalizeMigratedScratchlistParkCleanup,
    prepareScratchlistParkAttachments,
    stageScratchlistAttachmentsForComposeSend,
    type PendingParkAttachment,
    type ScratchlistParkResult,
} from '@/lib/scratchlistAttachmentFlow'
import type { SendMessageAcceptance } from '@/hooks/mutations/useSendMessage'
import { handoffComposerDraft } from '@/lib/composer-draft-transfer'
import {
    applyGlobalSelectAll,
    isScratchlistHotkeyBlockedTarget,
    isScratchlistToggleHotkey,
    mergeStagedAttachmentsInOrder,
    shouldAutoClearPendingSchedule,
    shouldRouteToScratchlist,
} from '@/components/sessionChatHelpers'

export type UseSessionComposerSendBridgeParams = {
    api: ApiClient
    session: Session
    agentFlavor?: string | null
    inactiveCanResume: boolean
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | false>
    resolveSessionIdForUpload?: (sessionId: string) => Promise<string>
    onUploadSessionResolved?: (sessionId: string) => void
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onAcceptedChatSend?: () => void
}

export function useSessionComposerSendBridge(props: UseSessionComposerSendBridgeParams) {
    const { agentFlavor, inactiveCanResume } = props
    const onAcceptedChatSendRef = useRef(props.onAcceptedChatSend)
    onAcceptedChatSendRef.current = props.onAcceptedChatSend
    const scratchlist = useHubScratchlist(props.session.id, props.api)
    const [scratchlistMode, setScratchlistMode] = useState(false)
    const [isScratchlistParking, setIsScratchlistParking] = useState(false)
    // Mode resets across sessions implicitly: SessionChat is keyed by
    // session.id at the public-export boundary, so a session switch
    // remounts SessionChatInner from scratch and `scratchlistMode`
    // initializes to false again. (Previous effect-based reset was
    // racy on first paint - see public-export comment for context.)
    const handleScratchlistToggle = useCallback(() => {
        if (isScratchlistParking) return
        setScratchlistMode((m) => !m)
    }, [isScratchlistParking])
    /**
     * Global keyboard shortcut: Ctrl/Cmd + Shift + S toggles scratchlist
     * mode (open/close drawer + flip composer routing).
     *
     * Convention matches the v1 always-visible panel's shortcut so muscle
     * memory carries over. Other composer-adjacent globals in the app use
     * the same modifier shape: Ctrl/Cmd-m cycles agent model in
     * HappyComposer. Ctrl/Cmd-Shift-S is unreserved by Chrome / Firefox /
     * Safari at the app level (browser Save As is Ctrl-S / Cmd-S, no
     * Shift), so requiring Shift keeps the user's save-page muscle memory
     * working. Bound at SessionChat scope (not the drawer) because the
     * drawer is unmounted while mode is off — a drawer-scoped listener
     * couldn't reopen it.
     *
     * Skipped when focus is inside an open dialog or single-line input
     * (see isScratchlistHotkeyBlockedTarget). Otherwise fires for any
     * focus target - composer textarea is the expected case so it's
     * deliberately allowed. Window-level shortcut without target
     * filtering would silently toggle mode "behind" modal dialogs
     * (rename, schedule picker, FUE callout); the bot caught this on
     * PR #798.
     */
    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if (isScratchlistParking) return
            if (!isScratchlistToggleHotkey(e)) return
            if (isScratchlistHotkeyBlockedTarget(e.target)) return
            e.preventDefault()
            setScratchlistMode((m) => !m)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [isScratchlistParking])
    /**
     * Global select-all takeover: see applyGlobalSelectAll. Bound at
     * window scope because the broken case is focus on the page body /
     * message thread, which never routes keydown through the composer or
     * the thread viewport.
     */
    useEffect(() => {
        window.addEventListener('keydown', applyGlobalSelectAll)
        return () => window.removeEventListener('keydown', applyGlobalSelectAll)
    }, [])
    /**
     * onSend wrapper: when scratchlist mode is on AND the submission is
     * not scheduled, route to scratchlist (text and/or hub attachments).
     *
     * The composer (HappyComposer) uses the boolean return value to
     * decide whether to clear text/attachments/schedule, so we resolve
     * true on a successful add - the operator's text gets cleared and
     * they can keep adding entries while sticky-mode is on. If add()
     * returns false (empty after trim, at-cap), we resolve false so
     * the composer keeps its text and the operator can fix it.
     *
     * Chat-path chips attached before scratchlist mode are migrated in
     * the scratchlist attachment adapter's send() (#1226). If any
     * non-hub path still reaches this wrapper, fail closed — never park
     * text-only and clear chips.
     */
    // Stable handle so HappyComposer can release parked chips without
    // deleting hub blobs when clearAttachments() calls adapter.remove().
    const scratchlistAdapterRef = useRef<ScratchlistAttachmentAdapter | null>(null)

    /**
     * Park from a live composer snapshot *before* assistant-ui's
     * `composer.send()` empties text/chips. Returning false leaves the
     * composer intact for retry (at-cap / hub error).
     */
    const onParkScratchlist = useCallback(
        async (
            text: string,
            pending: readonly PendingParkAttachment[],
        ): Promise<ScratchlistParkResult> => {
            let prepared
            try {
                prepared = await prepareScratchlistParkAttachments(
                    props.api,
                    props.session.id,
                    pending,
                )
            } catch {
                return false
            }
            let aborted = false
            const abort = async () => {
                if (aborted) return
                aborted = true
                await finalizeMigratedScratchlistParkCleanup(
                    props.api,
                    props.session.id,
                    prepared,
                    false,
                )
            }
            return {
                abort,
                commit: async () => {
                    const accepted = await scratchlist.add(text, prepared)
                    if (!accepted) {
                        await abort()
                        return false
                    }
                    return true
                },
                beforeClear: async () => {
                    await finalizeMigratedScratchlistParkCleanup(
                        props.api,
                        props.session.id,
                        prepared,
                        true,
                    )
                    scratchlistAdapterRef.current?.releaseWithoutDelete(
                        pending.map((chip) => chip.id),
                    )
                },
            }
        },
        [props.api, props.session.id, scratchlist],
    )

    const onSendForComposer = useCallback(
        async (
            text: string,
            attachments?: AttachmentMetadata[],
            scheduledAt?: number | null,
            deliveryMode: MessageDeliveryMode = 'queue',
        ): Promise<{ attemptId: string | null } | false> => {
            if (
                scratchlistMode
                && scheduledAt == null
                && attachmentsNeedScratchlistMigration(attachments)
            ) {
                return false
            }
            if (shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)) {
                // Legacy path if something still calls composer.send() while
                // scratchlist mode is on. Prefer onParkScratchlist (clears
                // only after accept).
                const accepted = await scratchlist.add(text, attachments)
                await finalizeMigratedScratchlistParkCleanup(
                    props.api,
                    props.session.id,
                    attachments,
                    accepted,
                )
                return accepted ? { attemptId: null } : false
            }
            // If the user uploaded while scratchlist mode was on, then toggled
            // it off before send, pending items still carry hub paths. Stage
            // those through the normal CLI upload dir before chat send.
            const list = attachments ?? []
            const hubItems = list.filter((att) => isHubScratchlistAttachmentPath(att.path))
            if (hubItems.length > 0) {
                const staged = await stageScratchlistAttachmentsForComposeSend(
                    props.api,
                    props.session.id,
                    hubItems,
                )
                const ordered = mergeStagedAttachmentsInOrder(list, staged)
                const accepted = await props.onSend(
                    text,
                    ordered,
                    scheduledAt,
                    deliveryMode,
                )
                if (accepted) {
                    // Hub blobs were copied into the normal upload dir; drop the
                    // scratchlist copies so they stop counting against the session cap.
                    await Promise.allSettled(
                        hubItems.map((att) => props.api.deleteScratchlistAttachment(props.session.id, att.id))
                    )
                }
                return accepted
            }
            return props.onSend(text, attachments, scheduledAt, deliveryMode)
        },
        [props.onSend, props.api, props.session.id, scratchlist, scratchlistMode],
    )
    // Scheduled message state — lifted here so useHappyRuntime can read the ref.
    //
    // pendingSchedule holds what the user selected (preset or absolute ms).
    // The ref is read at send time; resolvePendingSchedule converts it to an
    // absolute epoch-ms using Date.now() at that moment (send-time base for presets).
    const [pendingSchedule, setPendingSchedule] = useState<PendingSchedule | null>(null)
    const [pendingScheduleRevision, setPendingScheduleRevision] = useState(0)
    const [sendAcceptance, setSendAcceptance] = useState<{ attemptId: string | null } | null>(null)
    const updatePendingSchedule = useCallback((next: PendingSchedule | null) => {
        setPendingSchedule(next)
        setPendingScheduleRevision((revision) => revision + 1)
    }, [])
    const pendingScheduleRef = useRef<PendingSchedule | null>(null)
    // Keep render ref in sync so onNew can snapshot at send time
    pendingScheduleRef.current = pendingSchedule
    // The single, shared intent ref travels HappyComposer -> useHappyRuntime
    // -> handleSend. The runtime consumes and resets it in the same submit
    // turn, so explicit or retry-safe queue intents never stick to later
    // ordinary sends.
    const pendingSendIntentRef = useRef<ComposerSendIntent>('default')
    const attachmentOrderRef = useRef<string[]>([])
    const restoredSendErrorIdRef = useRef<number | null>(null)

    useEffect(() => {
        const error = props.sendError
        if (!error) {
            restoredSendErrorIdRef.current = null
            return
        }
        if (restoredSendErrorIdRef.current === error.id) return
        // A retry cannot carry the original Pi streaming generation. Preserve
        // queue, but deliberately downgrade a failed turn-scoped steer to the
        // HAPI queue so a later active turn is never steered by stale text.
        pendingSendIntentRef.current = getRestoredComposerSendIntent(error.deliveryMode)
        restoredSendErrorIdRef.current = error.id
    }, [props.sendError])

    const handleClearSendError = useCallback(() => {
        pendingSendIntentRef.current = 'default'
        props.onClearSendError?.()
    }, [props.onClearSendError])

    // Auto-clear absolute-type pendingSchedule when the chosen time expires so
    // the composer clock button doesn't stay active past the scheduled instant.
    // Preset-type schedules are relative so they don't expire until send — the
    // shouldAutoClearPendingSchedule predicate is the single source of truth so
    // adding a new PendingSchedule variant only needs to update that helper.
    useEffect(() => {
        if (!shouldAutoClearPendingSchedule(pendingSchedule)) return
        // Narrowed to 'absolute' by the predicate above.
        const ms = (pendingSchedule as Extract<PendingSchedule, { type: 'absolute' }>).ms
        const remaining = ms - Date.now()
        if (remaining <= 0) {
            updatePendingSchedule(null)
            return
        }
        const timer = setTimeout(() => updatePendingSchedule(null), remaining)
        return () => clearTimeout(timer)
    }, [pendingSchedule, updatePendingSchedule])

    const handleSend = useCallback(async (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        intent: ComposerSendIntent = 'default',
    ) => {
        // Route through the scratchlist-aware wrapper. When scratchlistMode
        // is on AND the payload is pure text, this turns into
        // addScratchlistEntry; otherwise it goes to props.onSend (the chat
        // send path). The wrapper resolves true on success either way so
        // the composer-clear is shared, but the schedule-clear / scroll
        // dance below must gate on the actual route taken (not just
        // scratchlistMode), or a scheduled chat send made while the
        // scratchlist toggle is on will leave pendingSchedule sticky and
        // the next normal send would reuse the same schedule. (Per
        // upstream review on PR #798: [Major] "Clear accepted scheduled
        // chat sends after scratchlist fallback".)
        const routedToScratchlist = shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)
        const deliveryMode = resolveMessageDeliveryMode({
            agentFlavor,
            // Do not use assistant-ui's broader `isRunning` here: a
            // child-agent run is not the Pi main session's steer target.
            isSessionThinking: props.session.thinking,
            intent,
            scheduledAt,
            routesToScratchlist: routedToScratchlist,
        })
        const accepted = await onSendForComposer(text, attachments, scheduledAt, deliveryMode)
        if (!accepted) return
        setSendAcceptance({ attemptId: accepted.attemptId })
        if (!routedToScratchlist) {
            // Clear pendingSchedule only after the mutation is actually
            // accepted - covers both pre-mutation guards AND async
            // inactive-session resume failure. SessionChat is the single
            // owner of schedule clear (HappyComposer no longer clears on
            // its own send path). Schedule clear / forced scroll only
            // matter for chat sends; scratchlist adds don't have a
            // schedule and shouldn't move the chat viewport.
            updatePendingSchedule(null)
            onAcceptedChatSendRef.current?.()
        }
    }, [agentFlavor, onSendForComposer, props.session.thinking, scratchlistMode, updatePendingSchedule])

    const attachmentAdapter = useMemo(() => {
        if (props.session.active && scratchlistMode) {
            const adapter = createScratchlistAttachmentAdapter(props.api, props.session.id)
            scratchlistAdapterRef.current = adapter
            return adapter
        }
        scratchlistAdapterRef.current = null
        if (props.session.active) {
            return createAttachmentAdapter(props.api, props.session.id)
        }
        // Only offer attachments on inactive sessions that can actually resume;
        // otherwise file picks become stuck error attachments that cannot send.
        if (!inactiveCanResume || !props.resolveSessionIdForUpload) {
            return undefined
        }
        // Keep one resume promise for every generator created by this adapter
        // instance. Preview generation can outlive navigation; a remount clears
        // the router cache, so a second file must reuse this closure's promise
        // instead of starting a fresh resume against the retired source id.
        let uploadResolution: Promise<string> | undefined
        const resolveUploadSession = () => {
            uploadResolution ??= props.resolveSessionIdForUpload!(props.session.id).catch((error) => {
                uploadResolution = undefined
                throw error
            })
            return uploadResolution
        }
        return createAttachmentAdapter(
            props.api,
            props.session.id,
            resolveUploadSession,
            async (resolvedSessionId, pending) => {
                // Include the in-flight file and coalesce multi-file drops into
                // one transfer + navigation before the source composer unmounts.
                // isCancelled is sampled at save time so a mid-handoff remove
                // still drops the file (and any prior inactive persist of it).
                await handoffComposerDraft(
                    props.session.id,
                    resolvedSessionId,
                    pending,
                    async (targetSessionId) => {
                        props.onUploadSessionResolved?.(targetSessionId)
                    },
                )
            },
        )
    }, [props.api, props.session.id, props.session.active, props.resolveSessionIdForUpload, scratchlistMode, inactiveCanResume])

    return {
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
    }
}
