import { useCallback, useMemo, useRef } from 'react'
import type React from 'react'
import type { AppendMessage, AttachmentAdapter, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { resolvePendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
    consumeComposerSendIntent,
    type ComposerSendIntent,
} from '@/lib/messageDelivery'
import { safeStringify } from '@hapi/protocol'
import { isInlineCompactionEvent } from '@/chat/reducerEvents'
import { renderEventLabel } from '@/chat/presentation'
import { filterVisibleBlocksForFlavor } from '@/fork-features/omp-product/eventVisibility'
import type { CliOutputBlock, CodexReview, RoundSummary, UsageData } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock } from '@/chat/toolGroups'
import { visibleBlockRole } from '@/chat/toolGroups'
import type { AttachmentMetadata, MessageStatus as HappyMessageStatus, Session } from '@/types/api'
import { orderItemsById } from '@/lib/attachmentOrder'
import {
    type AggregatedAssistantMeta,
    type BlockWithThreadMessageId,
    aggregateResponseGroups,
    assignThreadMessageIds,
    assignThreadMessageIdsWithStableWrappers,
    findLatestCompletedBoundaryId,
    formatCodexReviewText,
    getBlockPresentationTimestamp,
    getResponseGroupTimestamps,
    hoistMidTurnTitleEvents,
    toCompactionToolCallBlock,
} from '@/lib/assistant-runtime-blocks'

export {
    type AggregatedAssistantMeta,
    type BlockWithThreadMessageId,
    aggregateResponseGroups,
    assignThreadMessageIds,
    assignThreadMessageIdsWithStableWrappers,
    findLatestCompletedBoundaryId,
    getBlockPresentationTimestamp,
    getResponseGroupTimestamps,
    hoistMidTurnTitleEvents,
}
export type HappyChatMessageMetadata = {
    kind: 'user' | 'assistant' | 'tool' | 'event' | 'cli-output' | 'codex-review' | 'compact-summary'
    status?: HappyMessageStatus
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
    source?: CliOutputBlock['source']
    attachments?: AttachmentMetadata[]
    invokedAt?: number | null
    steered?: boolean
    durationMs?: number
    usage?: UsageData
    model?: string | null
    roundSummary?: RoundSummary
    review?: CodexReview
    /**
     * Raw hub-DB message id (unprefixed) for user-text blocks. The
     * assistant-ui `message.id` is a presentation key (user-text uses
     * `localId ?? id`; see `assignThreadMessageIdsWithStableWrappers`),
     * which cannot be used against hub's `/api/sessions/:id/fork`
     * because that endpoint matches on the raw hub messageId. Callers
     * that need to talk to hub about a specific stored message (rewind
     * / fork-at-message) MUST read this field, not `message.id`.
     */
    hubMessageId?: string
    /**
     * Distinct turn count when this block carries an aggregated response
     * group footer. Single-turn blocks omit this field so the existing
     * per-message footer is rendered unchanged.
     */
    turnCount?: number
}

export type HappyRuntimeExtras = Readonly<{
    messagesVersion: number
    historyVersion: number
}>

function findTailAssistantBlock(entries: readonly BlockWithThreadMessageId[]): VisibleChatBlock | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const block = entries[index].block
        const role = visibleBlockRole(block)
        if (role === 'user') {
            return null
        }
        if (role === 'assistant') {
            return block
        }
    }
    return null
}

function getTailAssistantMarker(block: VisibleChatBlock | null): string | null {
    if (!block) return null
    const textLength = 'text' in block ? block.text.length : 0
    const toolCount = block.kind === 'tool-group' ? block.tools.length : 0
    const toolState = block.kind === 'tool-call'
        ? block.tool.state
        : block.kind === 'tool-group'
            ? `${block.summary.runningCount}:${block.summary.pendingCount}`
            : ''
    return `${block.id}:${getBlockPresentationTimestamp(block)}:${textLength}:${toolCount}:${toolState}`
}

function isTailAssistantBlockActivelyRunning(
    tailBlock: VisibleChatBlock | null,
    session: Session,
    settledTailMarker: string | null
): boolean {
    if (!tailBlock) return false
    if (session.activeTurnId && 'turnId' in tailBlock && tailBlock.turnId === session.activeTurnId) {
        return true
    }
    if (
        session.lifecycleState === 'tool-executing'
        || session.lifecycleState === 'streaming-answer'
        || session.lifecycleState === 'awaiting-permission'
    ) {
        return true
    }
    if (
        tailBlock.kind === 'tool-call'
        && (tailBlock.tool.state === 'running' || tailBlock.tool.state === 'pending')
    ) {
        return true
    }
    if (
        tailBlock.kind === 'tool-group'
        && (tailBlock.summary.runningCount > 0 || tailBlock.summary.pendingCount > 0)
    ) {
        return true
    }
    const activeTurnStartedAt = session.activeTurnStartedAt ?? null
    if (
        activeTurnStartedAt !== null
        && getBlockPresentationTimestamp(tailBlock) >= activeTurnStartedAt
    ) {
        return true
    }
    if (settledTailMarker === null) {
        return activeTurnStartedAt === null
    }
    return getTailAssistantMarker(tailBlock) !== settledTailMarker
}
function toThreadMessageLike(
    block: VisibleChatBlock,
    threadMessageId: string,
    timestamp: number
): ThreadMessageLike {
    if (block.kind === 'user-text') {
        return {
            role: 'user',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'user',
                    status: block.status,
                    localId: block.localId,
                    originalText: block.originalText,
                    attachments: block.attachments,
                    invokedAt: block.invokedAt,
                    steered: block.steered,
                    hubMessageId: block.id
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-text') {
        const textPart = block.phase !== undefined
            ? ({ type: 'text', text: block.text, phase: block.phase, blockId: block.id } as const)
            : ({ type: 'text', text: block.text, blockId: block.id } as const)
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [textPart as { type: 'text'; text: string }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'generated-image') {
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{
                type: 'tool-call',
                toolCallId: block.id,
                toolName: 'GeneratedImage',
                argsText: '',
                artifact: block
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: block.id,
                    invokedAt: block.invokedAt ?? null
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'generated-file') {
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(block.createdAt),
            content: [{
                type: 'tool-call',
                toolCallId: block.id,
                toolName: 'GeneratedFile',
                argsText: '',
                artifact: block
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: block.id,
                    invokedAt: block.invokedAt ?? null
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-reasoning') {
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{ type: 'reasoning', text: block.text, blockId: block.id } as { type: 'reasoning'; text: string }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'codex-review') {
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: formatCodexReviewText(block.review) }],
            metadata: {
                custom: {
                    kind: 'codex-review',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model,
                    review: block.review
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-event') {
        if (isInlineCompactionEvent(block.event)) {
            const compactionTool = toCompactionToolCallBlock(block)
            const running = compactionTool.tool.state === 'running'
            return {
                role: 'assistant',
                id: threadMessageId,
                createdAt: new Date(timestamp),
                content: [{
                    type: 'tool-call',
                    toolCallId: block.id,
                    toolName: 'ContextCompaction',
                    argsText: '',
                    result: running ? undefined : block.event,
                    isError: compactionTool.tool.state === 'error',
                    artifact: compactionTool
                }],
                metadata: {
                    custom: {
                        kind: 'event',
                        event: block.event,
                        invokedAt: block.invokedAt,
                        model: block.model
                    } satisfies HappyChatMessageMetadata
                }
            }
        }
        // Pi compaction summaries carry a real payload; surface them as a
        // dedicated system message so the chat can render an independent
        // block instead of a small status line.
        if (block.event.type === 'compact-summary' && typeof block.event.summary === 'string') {
            return {
                role: 'system',
                id: threadMessageId,
                createdAt: new Date(timestamp),
                content: [{ type: 'text', text: block.event.summary }],
                metadata: {
                    custom: {
                        kind: 'compact-summary',
                        event: block.event,
                        invokedAt: block.invokedAt,
                        model: block.model
                    } satisfies HappyChatMessageMetadata
                }
            }
        }
        return {
            role: 'system',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: renderEventLabel(block.event) }],
            metadata: {
                custom: {
                    kind: 'event',
                    event: block.event,
                    invokedAt: block.invokedAt,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'cli-output') {
        return {
            role: block.source === 'user' ? 'user' : 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: block.text, blockId: block.id } as { type: 'text'; text: string }],
            metadata: {
                custom: {
                    kind: 'cli-output',
                    source: block.source,
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'tool-group') {
        const groupBlock: ToolGroupBlock = block
        return {
            role: 'assistant',
            id: threadMessageId,
            createdAt: new Date(timestamp),
            content: [{
                type: 'tool-call',
                toolCallId: groupBlock.id,
                toolName: 'ToolGroup',
                argsText: '',
                artifact: groupBlock
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: groupBlock.id,
                    invokedAt: groupBlock.invokedAt ?? null
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    const toolBlock: ToolCallBlock = block
    const inputText = safeStringify(toolBlock.tool.input)

    return {
        role: 'assistant',
        id: threadMessageId,
        createdAt: new Date(timestamp),
        content: [{
            type: 'tool-call',
            toolCallId: toolBlock.id,
            toolName: toolBlock.tool.name,
            argsText: inputText,
            result: toolBlock.tool.result,
            isError: toolBlock.tool.state === 'error',
            artifact: toolBlock
        }],
        metadata: {
            custom: {
                kind: 'tool',
                toolCallId: toolBlock.id,
                invokedAt: toolBlock.invokedAt,
                durationMs: toolBlock.durationMs,
                usage: toolBlock.usage,
                model: toolBlock.model
            } satisfies HappyChatMessageMetadata
        }
    }
}

type TextMessagePart = { type: 'text'; text: string }

function getTextFromParts(parts: readonly { type: string }[] | undefined): string {
    if (!parts) return ''

    return parts
        .filter((part): part is TextMessagePart => part.type === 'text' && typeof (part as TextMessagePart).text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
}

type ExtractedAttachmentMetadata = { __attachmentMetadata: AttachmentMetadata }

function isAttachmentMetadataJson(text: string): ExtractedAttachmentMetadata | null {
    try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object' && '__attachmentMetadata' in parsed) {
            return parsed as ExtractedAttachmentMetadata
        }
        return null
    } catch {
        return null
    }
}

function extractMessageContent(message: AppendMessage): { text: string; attachments: AttachmentMetadata[] } {
    if (message.role !== 'user') return { text: '', attachments: [] }

    // Extract attachments from attachment content
    const attachments: AttachmentMetadata[] = []
    const otherAttachmentTexts: string[] = []

    const attachmentParts = message.attachments?.flatMap((attachment) => attachment.content ?? []) ?? []
    for (const part of attachmentParts) {
        if (part.type === 'text' && typeof (part as TextMessagePart).text === 'string') {
            const textPart = part as TextMessagePart
            const extracted = isAttachmentMetadataJson(textPart.text)
            if (extracted) {
                attachments.push(extracted.__attachmentMetadata)
            } else {
                otherAttachmentTexts.push(textPart.text)
            }
        }
    }

    const contentText = getTextFromParts(message.content)
    const text = [otherAttachmentTexts.join('\n'), contentText]
        .filter((value) => value.length > 0)
        .join('\n\n')
        .trim()

    return { text, attachments }
}

export function useHappyRuntime(props: {
    session: Session
    blocks: readonly VisibleChatBlock[]
    blocksWithThreadIds?: readonly BlockWithThreadMessageId[]
    messagesVersion: number
    historyVersion: number
    viewMode?: 'tail' | 'history'
    isSyncingTail?: boolean
    isLoadingMore?: boolean
    isSending: boolean
    isRunning?: boolean
    onSendMessage: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        intent?: ComposerSendIntent,
    ) => void
    attachmentOrderRef?: React.MutableRefObject<string[]>
    onAbort: () => Promise<void>
    attachmentAdapter?: AttachmentAdapter
    allowSendWhenInactive?: boolean
    pendingScheduleRef?: React.RefObject<PendingSchedule | null>
    /**
     * Shared one-shot ref with HappyComposer. The composer marks the next
     * `api.composer().send()`; this adapter consumes and resets the mark as
     * soon as assistant-ui emits the corresponding AppendMessage.
     */
    pendingSendIntentRef?: React.MutableRefObject<ComposerSendIntent>
}) {
    const isRunning = props.isRunning ?? props.session.thinking
    const flavor = props.session.metadata?.flavor

    // Compute response-group aggregates once per block list so we can
    // inject the summed metadata onto each group's first visible block.
    // The library's `joinExternalMessages` only preserves
    // `metadata.custom` from the first block of a joined chunk, so this
    // is the surface that survives the join.
    const threadIdWrapperCacheRef = useRef(
        new WeakMap<VisibleChatBlock, BlockWithThreadMessageId>()
    )
    const blocksWithThreadIds = useMemo(
        () => props.blocksWithThreadIds ?? assignThreadMessageIdsWithStableWrappers(
            hoistMidTurnTitleEvents(filterVisibleBlocksForFlavor(props.blocks, flavor)),
            threadIdWrapperCacheRef.current
        ),
        [props.blocksWithThreadIds, props.blocks, flavor]
    )

    const tailAssistantBlock = useMemo(
        () => findTailAssistantBlock(blocksWithThreadIds),
        [blocksWithThreadIds]
    )
    const tailAssistantMarker = useMemo(
        () => getTailAssistantMarker(tailAssistantBlock),
        [tailAssistantBlock]
    )
    const settledTailRef = useRef<{
        sessionId: string
        wasRunning: boolean
        settledMarker: string | null
    }>({
        sessionId: props.session.id,
        wasRunning: isRunning,
        settledMarker: isRunning ? null : tailAssistantMarker
    })
    if (settledTailRef.current.sessionId !== props.session.id) {
        settledTailRef.current = {
            sessionId: props.session.id,
            wasRunning: isRunning,
            settledMarker: isRunning ? tailAssistantMarker : tailAssistantMarker
        }
    } else if (!isRunning) {
        settledTailRef.current.wasRunning = false
        settledTailRef.current.settledMarker = tailAssistantMarker
    } else if (!settledTailRef.current.wasRunning) {
        settledTailRef.current.wasRunning = true
    } else if (
        settledTailRef.current.settledMarker !== null
        && tailAssistantMarker !== settledTailRef.current.settledMarker
    ) {
        settledTailRef.current.settledMarker = null
    }

    const isRunningForMessages = isRunning && isTailAssistantBlockActivelyRunning(
        tailAssistantBlock,
        props.session,
        settledTailRef.current.settledMarker
    )

    const convertBlock = useCallback(
        ({ block, threadMessageId, timestamp, aggregate }: BlockWithThreadMessageId): ThreadMessageLike => {
            const message = toThreadMessageLike(
                block,
                threadMessageId,
                timestamp ?? getBlockPresentationTimestamp(block)
            )
            if (!aggregate) return message
            const existing = message.metadata?.custom as HappyChatMessageMetadata | undefined
            return {
                ...message,
                metadata: {
                    ...message.metadata,
                    custom: {
                        ...(existing ?? { kind: 'assistant' }),
                        usage: aggregate.usage,
                        model: aggregate.model,
                        invokedAt: aggregate.invokedAt,
                        durationMs: aggregate.durationMs,
                        turnCount: aggregate.turnCount,
                        roundSummary: aggregate.roundSummary
                    } satisfies HappyChatMessageMetadata
                }
            }
        },
        []
    )

    // Use cached message converter for performance optimization
    // This prevents re-converting all messages on every render
    const convertedMessages = useExternalMessageConverter<BlockWithThreadMessageId>({
        callback: convertBlock,
        messages: blocksWithThreadIds as BlockWithThreadMessageId[],
        isRunning: isRunningForMessages,
    })

    const onNew = useCallback(async (message: AppendMessage) => {
        const intent = consumeComposerSendIntent(props.pendingSendIntentRef)
        // Reset before any early return so an empty submission, extraction
        // failure, or downstream exception cannot leak an explicit queue
        // gesture into the next ordinary send.
        const { text, attachments } = extractMessageContent(message)
        const orderedAttachments = orderItemsById(
            attachments,
            props.attachmentOrderRef?.current ?? [],
        )
        if (!text && orderedAttachments.length === 0) return
        // Resolve pendingSchedule at send time (Date.now()) so preset-type schedules
        // ("5 minutes from now") are relative to the actual send action, not the
        // moment the user clicked the preset button.
        const sendNow = Date.now()
        const scheduledAt = resolvePendingSchedule(props.pendingScheduleRef?.current ?? null, sendNow)
        props.onSendMessage(
            text,
            orderedAttachments.length > 0 ? orderedAttachments : undefined,
            scheduledAt,
            intent,
        )
    }, [props.attachmentOrderRef, props.onSendMessage, props.pendingScheduleRef, props.pendingSendIntentRef])

    const onCancel = useCallback(async () => {
        await props.onAbort()
    }, [props.onAbort])

    const extras = useMemo<HappyRuntimeExtras>(() => ({
        messagesVersion: props.messagesVersion,
        historyVersion: props.historyVersion
    }), [props.messagesVersion, props.historyVersion])

    // Memoize the adapter to avoid recreating on every render
    // useExternalStoreRuntime may use adapter identity for subscriptions
    const adapter = useMemo(() => ({
        isDisabled: props.isSending || (!props.session.active && !props.allowSendWhenInactive),
        isRunning,
        messages: convertedMessages,
        extras,
        onNew,
        onCancel,
        adapters: props.attachmentAdapter ? { attachments: props.attachmentAdapter } : undefined,
        unstable_capabilities: { copy: true }
    }), [
        props.session.active,
        props.isSending,
        props.allowSendWhenInactive,
        isRunning,
        convertedMessages,
        extras,
        onNew,
        onCancel,
        props.attachmentAdapter
    ])

    // Note: pendingScheduleRef is intentionally not in the deps above.
    // The ref is read at send time inside onNew (not at render time), so changes
    // to pendingSchedule do not need to invalidate the adapter or re-run onNew.

    return useExternalStoreRuntime(adapter)
}
