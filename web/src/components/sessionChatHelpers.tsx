import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useAui } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, PiModelSummary, Session } from '@/types/api'
import type { ChatBlock, ModelRefusalFallbackEvent, NormalizedMessage } from '@/chat/types'
import { buildConversationOutline, type ConversationOutlineItem } from '@/chat/outline'
import { areSessionStatusDataEqual, buildSessionStatusData, type SessionStatusData } from '@/chat/sessionStatus'
import {
    buildGoalStateMessages,
    createSessionEntityStore,
    hasAbortableAgentRun,
    type SessionEntityStore,
} from '@/chat/store/sessionEntityStore'
import { useUnseenBlockCount } from '@/hooks/useUnseenBlockCount'
import { useCodexExplorationCollapse } from '@/hooks/useCodexExplorationCollapse'
import { findLatestCompletedBoundaryId } from '@/lib/assistant-runtime'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import type { MessageDeliveryMode } from '@hapi/protocol'
import { isHubScratchlistAttachmentPath } from '@hapi/protocol'
import type { SendMessageAcceptance } from '@/hooks/mutations/useSendMessage'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { ScratchlistDrawer } from '@/components/AssistantChat/ScratchlistPanel'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import { rehydrateScratchlistAttachmentsToComposer, stageScratchlistAttachmentsForComposeSend } from '@/lib/scratchlistAttachmentFlow'
import type { SessionModelSelection } from './AssistantChat/composer/types'

// Pure session policies and the scratchlist runtime consumer.
export function resolvePiContextWindow(
    models: PiModelSummary[] | undefined,
    selectedModel: { provider: string; modelId: string } | null | undefined,
    legacyModelId: string
): number | undefined {
    const model = selectedModel
        ? models?.find((candidate) => (
            candidate.provider === selectedModel.provider
            && candidate.modelId === selectedModel.modelId
        ))
        : models?.find((candidate) => candidate.modelId === legacyModelId)

    return model?.contextWindow
}

export async function applyModelChangeWithReasoningRollback(args: {
    model: SessionModelSelection
    previousModelReasoningEffort: string | null
    shouldClearReasoningEffort: boolean
    setModel: (model: SessionModelSelection) => Promise<void>
    setModelReasoningEffort: (effort: string | null) => Promise<void>
}): Promise<void> {
    let clearedReasoningEffort = false

    try {
        if (args.shouldClearReasoningEffort) {
            await args.setModelReasoningEffort(null)
            clearedReasoningEffort = true
        }
        await args.setModel(args.model)
    } catch (error) {
        if (clearedReasoningEffort && args.previousModelReasoningEffort) {
            await args.setModelReasoningEffort(args.previousModelReasoningEffort).catch((restoreError) => {
                console.error('Failed to restore model reasoning effort:', restoreError)
            })
        }
        throw error
    }
}

/**
 * Returns whether a PendingSchedule should trigger an auto-clear timer.
 *
 * Only 'absolute' schedules expire (the chosen instant passes).
 * 'preset' schedules are relative to send time and have no fixed expiry.
 *
 * Used both by the auto-clear useEffect and by unit tests, so a future
 * variant of PendingSchedule only needs to update this single helper.
 */
export function shouldAutoClearPendingSchedule(pending: PendingSchedule | null): boolean {
    return pending !== null && pending.type === 'absolute'
}

/**
 * True if the keystroke matches the scratchlist-mode toggle shortcut
 * (Ctrl/Cmd + Shift + S, no Alt). Pure / exported for unit tests.
 *
 * Convention: matches the v1 always-visible panel's shortcut so muscle
 * memory carries over. Sibling globals follow the same modifier shape
 * (Ctrl/Cmd-m cycles agent model in HappyComposer).
 */
export function isScratchlistToggleHotkey(e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    key: string
}): boolean {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (!e.shiftKey) return false
    if (e.altKey) return false
    return e.key === 'S' || e.key === 's'
}

/**
 * True when the global scratchlist hotkey should be SKIPPED for the
 * given event target. Window-level shortcuts that fire regardless of
 * focus can quietly toggle modes "behind" modal dialogs (rename,
 * schedule picker, FUE callout) and that's the kind of UX bug the bot
 * caught on PR #798.
 *
 * Block targets:
 *   - any descendant of an open dialog (Radix UI's DialogContent renders
 *     role="dialog", as do FueCallout / ScheduleTimePicker / ImagePreview)
 *   - HTMLInputElement (single-line inputs)
 *   - HTMLSelectElement
 *   - any contentEditable host
 *
 * NOT blocked:
 *   - HTMLTextAreaElement (the composer textarea is the normal focus
 *     target when the operator presses the hotkey - blocking it would
 *     defeat the shortcut)
 *   - the document body / unfocused targets
 *
 * Pure / exported for unit tests.
 */
export function isScratchlistHotkeyBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLSelectElement) return true
    // isContentEditable is the authoritative check in real browsers but
    // jsdom doesn't implement it; the attribute fallback covers both.
    if (target.isContentEditable === true) return true
    return target.getAttribute('contenteditable') === 'true'
}

/**
 * True when a global select-all shortcut (Ctrl/Cmd+A) should be left to
 * the browser default: focus is inside the rich composer
 * (contentEditable), a textarea (the fallback composer), a single-line
 * input/select, or a modal dialog. In every other case the app takes
 * over the shortcut because Chromium's SelectAll collapses to an empty
 * caret when the page contains a contenteditable (the rich composer)
 * but focus is outside it — plain Ctrl+A would select nothing and
 * Ctrl+C would copy nothing (see applyGlobalSelectAll).
 *
 * Deliberately differs from isScratchlistHotkeyBlockedTarget: textareas
 * are blocked here (textarea select-all works natively) while the
 * scratchlist hotkey must keep firing from the composer textarea.
 *
 * Pure / exported for unit tests.
 */
export function isSelectAllTargetBlocked(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLTextAreaElement) return true
    if (target instanceof HTMLSelectElement) return true
    // isContentEditable is the authoritative check in real browsers but
    // jsdom doesn't implement it; the attribute fallback also covers
    // `plaintext-only` composers, which is what the rich composer uses
    // on modern Chromium.
    if (target.isContentEditable === true) return true
    const contenteditable = target.getAttribute('contenteditable')
    return contenteditable !== null && contenteditable !== 'false'
}

/**
 * Chromium quirk: when a page contains a contenteditable element (the
 * rich composer), Ctrl/Cmd+A with focus OUTSIDE the editable collapses
 * to an empty caret instead of selecting the page — Ctrl+C then copies
 * nothing. Reproduced in headless and headed Chrome with both
 * `contenteditable="true"` and `"plaintext-only"`; the bare presence of
 * the editable root is what breaks SelectAll, while focus inside it
 * selects the composer text correctly.
 *
 * This takes over Ctrl/Cmd+A whenever focus is outside the composer
 * (see isSelectAllTargetBlocked) and selects the message thread
 * manually, so select-all + copy restores the expected
 * "select the conversation" behavior.
 *
 * Returns true when the keystroke was handled (preventDefault + range
 * selection). Pure / exported for unit tests and the Playwright fixture.
 */
export function applyGlobalSelectAll(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.repeat) return false
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false
    if (e.key !== 'a' && e.key !== 'A') return false
    if (isSelectAllTargetBlocked(e.target)) return false
    // The thread container is rendered by HappyThread; its class is the
    // stable handle between the page-level shortcut and the message DOM.
    const thread = document.querySelector<HTMLElement>('.happy-thread-messages')
    if (!thread || !thread.textContent) return false
    e.preventDefault()
    const range = document.createRange()
    range.selectNodeContents(thread)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return true
}

/**
 * Decide whether a submit should be routed to the per-session scratchlist
 * or to the regular chat send. Scratchlist entries support text and hub-
 * stored attachments; scheduled sends still fall through to chat.
 *
 * Chat-path chips attached before scratchlist mode are migrated in the
 * park-before-clear path (`prepareScratchlistParkAttachments`, #1226).
 * This predicate still rejects non-hub paths as a fail-closed backstop
 * for any leftover composer.send() route.
 *
 * Pure / exported so it can be unit tested without mounting SessionChat.
 */
export function shouldRouteToScratchlist(
    scratchlistMode: boolean,
    attachments: AttachmentMetadata[] | undefined,
    scheduledAt: number | null | undefined,
): boolean {
    if (!scratchlistMode) return false
    if (scheduledAt != null) return false
    // Only park when every attachment is already hub-resident. Composer
    // uploads made before scratchlist mode was enabled still have normal
    // CLI paths; the hub rejects those as scratchlist metadata.
    return (attachments ?? []).every((att) => isHubScratchlistAttachmentPath(att.path))
}

export function mergeStagedAttachmentsInOrder(
    attachments: readonly AttachmentMetadata[],
    staged: readonly AttachmentMetadata[],
): AttachmentMetadata[] {
    const stagedById = new Map(staged.map((attachment) => [attachment.id, attachment]))
    return attachments.map((attachment) => stagedById.get(attachment.id) ?? attachment)
}

export { buildGoalStateMessages, hasAbortableAgentRun }

/**
 * Watches for incoming `abort-restore` events (emitted by the PTY launcher
 * when the user aborts a running turn) and surfaces the aborted prompt text —
 * carried on the event itself — via the existing sendError path
 * (onAbortRestore prop). Acts only when no user message has been sent after the
 * abort-restore event, so we never replay a prompt the user already resubmitted.
 */
export function AbortRestoreConsumer(props: {
    messages: NormalizedMessage[]
    onAbortRestore: (text: string) => void
}) {
    const lastHandledIdRef = useRef<string | null>(null)

    useEffect(() => {
        // Walk backwards: find an abort-restore event with no user message after it.
        // If a user message comes after the abort-restore, the restore was already
        // acted on — treat it as consumed regardless of page reload.
        let abortRestore: { id: string; text: string } | null = null
        for (let i = props.messages.length - 1; i >= 0; i--) {
            const msg = props.messages[i]
            if (!msg) continue
            if (msg.role === 'user') break  // user message after abort-restore → stale
            if (msg.role !== 'event') continue
            if (msg.content.type === 'abort-restore') {
                // The exact in-flight prompt rides on the event; no need to guess
                // it by scanning historical user turns.
                const text = typeof msg.content.text === 'string' ? msg.content.text : ''
                abortRestore = { id: msg.id, text }
                break
            }
        }
        if (!abortRestore) return
        if (lastHandledIdRef.current === abortRestore.id) return
        lastHandledIdRef.current = abortRestore.id

        // Surface it via the sendError path so HappyComposer restores it the
        // same way it handles a failed send.
        if (abortRestore.text.length > 0) {
            props.onAbortRestore(abortRestore.text)
        }
    }, [props.messages, props.onAbortRestore])

    return null
}

/**
 * Mounts the per-session scratchlist DRAWER (composer-controlled).
 *
 * The drawer renders only when the operator toggles into "scratchlist
 * mode" via the notepad icon in the composer toolbar. While in that mode:
 * - drawer (this component) is visible above the composer
 * - composer's send button repaints amber (handled in ComposerButtons)
 * - SessionChat's wrapped onSend routes adds into the scratchlist
 *
 * Entries state is owned by SessionChat's useScratchlist() so the
 * composer-toolbar counter and the drawer share one source of truth.
 */
export function ScratchlistDrawerHost(props: {
    sessionId: string
    api: ApiClient
    entries: ScratchlistEntry[]
    onMove: (id: string, direction: 'up' | 'down') => void | Promise<void>
    onDelete: (id: string) => void | Promise<void>
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<boolean | SendMessageAcceptance>
    onExitScratchlistMode: () => void
    disabled?: boolean
}) {
    const assistantApi = useAui()
    const handlePromoteToComposer = useCallback(async (entry: ScratchlistEntry) => {
        if (props.disabled) return
        assistantApi.composer().setText(entry.text)
        // Exit scratchlist mode before rehydrating attachments so addAttachment
        // uses the normal chat upload adapter (not the scratchlist hub adapter).
        flushSync(() => {
            props.onExitScratchlistMode()
        })
        if (entry.attachments && entry.attachments.length > 0) {
            await rehydrateScratchlistAttachmentsToComposer(
                props.api,
                props.sessionId,
                entry.attachments,
                assistantApi.composer()
            )
        }
    }, [assistantApi, props.api, props.disabled, props.onExitScratchlistMode, props.sessionId])
    const handlePromoteToQueue = useCallback(async (entry: ScratchlistEntry) => {
        if (props.disabled) return false
        let attachments: AttachmentMetadata[] | undefined
        if (entry.attachments && entry.attachments.length > 0) {
            attachments = await stageScratchlistAttachmentsForComposeSend(
                props.api,
                props.sessionId,
                entry.attachments
            )
        }
        // This action is explicitly labelled “Send to queue”. It must retain
        // that contract even when the Pi session is actively thinking.
        const accepted = await props.onSend(entry.text, attachments, undefined, 'queue')
        if (accepted) {
            props.onExitScratchlistMode()
        }
        return Boolean(accepted)
    }, [props.api, props.disabled, props.onSend, props.onExitScratchlistMode, props.sessionId])
    return (
        <ScratchlistDrawer
            entries={props.entries}
            sessionId={props.sessionId}
            api={props.api}
            onMove={props.onMove}
            onDelete={props.onDelete}
            onPromoteToComposer={handlePromoteToComposer}
            onPromoteToQueue={handlePromoteToQueue}
            disabled={props.disabled}
        />
    )
}


/**
 * Keep the latest completed fork boundary available while reading history.
 * The history window can no longer contain the tail after older pages are
 * loaded, so recomputing a boundary from that window would either hide the
 * current Fork action or incorrectly mark an older message as current.
 * A live tail revision invalidates the remembered boundary until tail view
 * observes the authoritative current boundary again.
 */
export function resolveLatestCompletedBoundaryIdForView(
    viewMode: 'tail' | 'history',
    currentTailBoundaryId: string | null,
    rememberedTailBoundary: { id: string | null; tailRevision: number } | null,
    currentTailRevision: number
): string | null {
    if (viewMode === 'tail') return currentTailBoundaryId
    if (!rememberedTailBoundary || rememberedTailBoundary.tailRevision !== currentTailRevision) {
        return null
    }
    return rememberedTailBoundary.id
}

export const MODEL_REFUSAL_FALLBACK_TOAST_DURATION_MS = 5000

export function isModelRefusalFallbackEvent(value: unknown): value is ModelRefusalFallbackEvent {
    return Boolean(value) && typeof value === 'object' && value !== null && 'type' in value && value.type === 'model-refusal-fallback'
}


/**
 * Floating chat stage. One explicit column: without `grid-cols-1`, the dock is
 * an auto-placed second item and lands in an implicit column beside the thread.
 * Both children share `col-start-1`; the dock only changes row.
 *
 * Expanded dock is `absolute inset-0` and must not be trapped by the stage.
 * A `relative` stage would be the containing block and collapses to 0 when the
 * terminal is open (thread hidden, dock out of flow). Omitting `relative` while
 * expanded lets the dock cover the chat column — the same positioned ancestor
 * the expanded composer shell uses — and not the session header above it.
 */
export function chatComposerGridPlacement(input: {
    terminalShown: boolean
    composerExpanded: boolean
    outlineOpen: boolean
}): { stage: string | undefined; thread: string; dock: string | undefined } {
    const outlineHide = input.outlineOpen ? ' max-sm:hidden' : ''
    if (input.terminalShown) {
        return {
            stage: input.composerExpanded ? undefined : 'relative',
            thread: 'hidden',
            dock: input.composerExpanded
                ? `absolute inset-0 z-[60] flex min-h-0 flex-col${outlineHide}`
                : (input.outlineOpen ? 'max-sm:hidden' : undefined),
        }
    }
    const stage = input.composerExpanded
        ? 'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto]'
        : 'relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto]'
    return {
        stage,
        thread: 'col-start-1 row-start-1 row-span-2 flex min-h-0 flex-col',
        dock: input.composerExpanded
            ? `absolute inset-0 z-[60] col-start-1 flex min-h-0 flex-col${outlineHide}`
            : `pointer-events-none z-20 col-start-1 row-start-2 overflow-visible${outlineHide}`,
    }
}

export type UseSessionChatPipelineParams = {
    session: Session
    messages: DecryptedMessage[]
    hasMoreMessages: boolean
    viewMode: 'tail' | 'history'
    tailRevision: number
    onResetSessionView?: () => void
}

export function useSessionChatPipeline(props: UseSessionChatPipelineParams) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { codexExplorationCollapsed } = useCodexExplorationCollapse()
    const entityStoreRef = useRef<SessionEntityStore | null>(null)
    if (!entityStoreRef.current) {
        entityStoreRef.current = createSessionEntityStore()
    }
    const entityStore = entityStoreRef.current
    const modelRefusalFallbackToastIdsRef = useRef<Set<string>>(new Set())
    const prevSessionStatusRef = useRef<SessionStatusData | null>(null)
    const prevOutlineItemsRef = useRef<ConversationOutlineItem[]>([])
    const [rememberedTailBoundary, setRememberedTailBoundary] = useState<{
        id: string | null
        tailRevision: number
    } | null>(null)
    const onResetSessionViewRef = useRef(props.onResetSessionView)
    onResetSessionViewRef.current = props.onResetSessionView

    useEffect(() => {
        modelRefusalFallbackToastIdsRef.current.clear()
        prevSessionStatusRef.current = null
        prevOutlineItemsRef.current = []
        onResetSessionViewRef.current?.()
    }, [props.session.id])

    const snapshot = useMemo(
        () => entityStore.reconcileInput({
            sessionId: props.session.id,
            messages: props.messages,
            agentState: props.session.agentState,
            hasMoreMessages: props.hasMoreMessages,
            codexExplorationCollapsed,
        }),
        [
            codexExplorationCollapsed,
            entityStore,
            props.hasMoreMessages,
            props.messages,
            props.session.agentState,
            props.session.id,
        ]
    )

    const {
        visibleMessages,
        normalizedMessages,
        visibleBlocks,
        timelineIndex,
        hasRunningChildAgent,
        activityLabel,
    } = snapshot

    const reduced = useMemo(
        () => ({
            blocks: snapshot.blocks,
            hasReadyEvent: snapshot.hasReadyEvent,
            latestGoal: snapshot.latestGoal,
            latestUsage: snapshot.latestUsage,
        }),
        [snapshot.blocks, snapshot.hasReadyEvent, snapshot.latestGoal, snapshot.latestUsage]
    )

    useEffect(() => {
        const displayedIds = modelRefusalFallbackToastIdsRef.current
        for (const message of normalizedMessages) {
            if (message.role !== 'event') continue
            if (!isModelRefusalFallbackEvent(message.content)) continue
            if (displayedIds.has(message.id)) continue

            displayedIds.add(message.id)
            const event = message.content
            addToast({
                title: t('toast.modelRefusalFallback.title'),
                body: t('toast.modelRefusalFallback.body', {
                    originalModel: event.originalModel,
                    message: event.message
                }),
                sessionId: props.session.id,
                url: `/sessions/${props.session.id}`,
                variant: 'warning',
                durationMs: MODEL_REFUSAL_FALLBACK_TOAST_DURATION_MS
            })
        }
    }, [addToast, normalizedMessages, props.session.id, t])

    const sessionStatus = useMemo(() => {
        const next = buildSessionStatusData({
            goal: snapshot.latestGoal,
            blocks: snapshot.blocks,
            messages: normalizedMessages,
            backgroundTaskCount: props.session.backgroundTaskCount,
            includeSubagents: false,
        })
        if (prevSessionStatusRef.current && areSessionStatusDataEqual(prevSessionStatusRef.current, next)) {
            return prevSessionStatusRef.current
        }
        prevSessionStatusRef.current = next
        return next
    }, [
        normalizedMessages,
        props.session.backgroundTaskCount,
        snapshot.blocks,
        snapshot.latestGoal,
    ])

    // Fork-current must compare against assistant-ui message ids (`kind:id`),
    // not raw hub message ids — MessageActions receive the rendered card id,
    // and adjacent assistant blocks join under the first block's id.
    //
    // Calculate the boundary from the tail window, then remember it while the
    // operator reads history. Otherwise changing viewMode to `history` hides
    // a valid current Fork action, and loading older pages can make the last
    // visible historical message look like the current fork boundary.
    const currentTailBoundaryId = useMemo(() => {
        if (props.viewMode !== 'tail') return null
        return findLatestCompletedBoundaryId(
            visibleBlocks,
            props.session.thinking,
            props.session.activeTurnStartedAt ?? null
        )
    }, [props.viewMode, props.session.activeTurnStartedAt, props.session.thinking, visibleBlocks])

    useEffect(() => {
        if (props.viewMode !== 'tail') return
        setRememberedTailBoundary((previous) => (
            previous?.id === currentTailBoundaryId && previous.tailRevision === props.tailRevision
                ? previous
                : { id: currentTailBoundaryId, tailRevision: props.tailRevision }
        ))
    }, [currentTailBoundaryId, props.tailRevision, props.viewMode])

    const latestCompletedBoundaryId = resolveLatestCompletedBoundaryIdForView(
        props.viewMode,
        currentTailBoundaryId,
        rememberedTailBoundary,
        props.tailRevision
    )

    const isLatestCompletedBoundary = useCallback((messageId: string) => {
        return latestCompletedBoundaryId === messageId
    }, [latestCompletedBoundaryId])

    // "N new messages" counts rendered blocks, not raw messages: a subagent run
    // is dozens of sidechain messages but a single Task card, and a tool_use +
    // tool_result pair is one card.
    const unseenCount = useUnseenBlockCount(props.viewMode, visibleBlocks)

    const outlineItems = useMemo(() => {
        const next = buildConversationOutline(snapshot.blocks, prevOutlineItemsRef.current)
        prevOutlineItemsRef.current = next
        return next
    }, [snapshot.blocks])

    return {
        entityStore,
        timelineIndex,
        visibleMessages,
        normalizedMessages,
        reduced,
        sessionStatus,
        hasRunningChildAgent,
        activityLabel,
        visibleBlocks,
        isLatestCompletedBoundary,
        unseenCount,
        outlineItems,
    }
}
