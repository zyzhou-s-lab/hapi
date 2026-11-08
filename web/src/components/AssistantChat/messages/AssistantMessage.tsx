import { MessagePrimitive, useAuiState, type TextMessagePart } from '@assistant-ui/react'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { messageHasTurnActivity, TurnBlock } from '@/components/AssistantChat/messages/TurnBlock'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'
import { useHappyChatHistoryContext, useHappyChatStaticContext } from '@/components/AssistantChat/context'
import {
    useOptionalSessionEntityStore,
    useOptionalSessionTurnEntity,
} from '@/hooks/useSessionEntityStore'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { useSessionSummaryInChat } from '@/hooks/useSessionSummaryInChat'
import { SpeakSummaryButton } from '@/components/AssistantChat/messages/SpeakSummaryButton'
const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: NotifySummaryText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const staticCtx = useHappyChatStaticContext()
    const historyCtx = useHappyChatHistoryContext()
    const store = useOptionalSessionEntityStore()
    const showSessionSummaryInChat = useSessionSummaryInChat()
    const messageId = useAuiState((s) => s.message.id)
    const isMessageRunning = useAuiState((s) => s.message.status?.type === 'running')
    const turnEntity = useOptionalSessionTurnEntity(messageId)
    const hasStoreTurn = Boolean(turnEntity)
    const firstBlock = turnEntity?.blocks[0]
    const elementId = getConversationMessageAnchorId(messageId)
    const auiIsCliOutput = useAuiState((s) => {
        if (hasStoreTurn) return false
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const auiCodexReview = useAuiState((s) => {
        if (hasStoreTurn) return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'codex-review' ? custom.review : undefined
    })
    const auiCliText = useAuiState((s) => {
        if (hasStoreTurn) return ''
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    const auiToolOnly = useAuiState((s) => {
        if (hasStoreTurn || s.message.role !== 'assistant') return false
        const parts = s.message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const auiTurnActivity = useAuiState((s) => {
        if (hasStoreTurn || s.message.role !== 'assistant') return false
        if (messageHasTurnActivity(s.message.content)) return true
        if (s.message.status?.type !== 'running') return false
        return !s.message.content.some(
            (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0
        )
    })
    const auiCopyText = useAuiState((s) => {
        if (hasStoreTurn || s.message.role !== 'assistant') return ''
        return getAssistantCopyText(s.message.content, {
            stripNotifySummary: !showSessionSummaryInChat
        })
    })

    const auiDurationMs = useAuiState(({ message }) => hasStoreTurn ? undefined : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.durationMs)
    const auiUsage = useAuiState(({ message }) => hasStoreTurn ? undefined : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.usage)
    const auiMessageModel = useAuiState(({ message }) => hasStoreTurn ? undefined : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.model)
    const auiTurnCount = useAuiState(({ message }) => hasStoreTurn ? undefined : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.turnCount)
    const auiRoundSummary = useAuiState(({ message }) => hasStoreTurn ? undefined : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.roundSummary)

    const isCliOutput = hasStoreTurn ? firstBlock?.kind === 'cli-output' : auiIsCliOutput
    const codexReview = hasStoreTurn
        ? (firstBlock?.kind === 'codex-review' ? firstBlock.review : undefined)
        : auiCodexReview
    const cliText = hasStoreTurn
        ? (firstBlock?.kind === 'cli-output' ? firstBlock.text : '')
        : auiCliText
    const toolOnly = hasStoreTurn && turnEntity
        ? (turnEntity.parts.length > 0 && turnEntity.parts.every((part) => part.type === 'tool-call'))
        : auiToolOnly
    const turnActivity = hasStoreTurn && turnEntity
        ? (
            messageHasTurnActivity(turnEntity.parts)
            || (
                isMessageRunning
                && !turnEntity.parts.some(
                    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0
                )
            )
        )
        : auiTurnActivity
    const copyText = hasStoreTurn && turnEntity
        ? getAssistantCopyText(turnEntity.parts, {
            stripNotifySummary: !showSessionSummaryInChat
        })
        : auiCopyText
    const getCopyText = hasStoreTurn && turnEntity
        ? () => getAssistantCopyText(
            store?.getLiveTurnParts(messageId) ?? turnEntity.parts,
            { stripNotifySummary: !showSessionSummaryInChat }
        )
        : undefined

    const durationMs = hasStoreTurn ? turnEntity?.durationMs : auiDurationMs
    const usage = hasStoreTurn ? turnEntity?.usage : auiUsage
    const messageModel = hasStoreTurn ? turnEntity?.model : auiMessageModel
    const turnCount = hasStoreTurn ? turnEntity?.turnCount : auiTurnCount
    const roundSummary = hasStoreTurn ? turnEntity?.roundSummary : auiRoundSummary

    const metadata = { durationMs, usage, model: messageModel ?? null, turnCount, roundSummary }
    const history = staticCtx.metadata?.capabilities?.conversationHistory
    const showForkCurrent = Boolean(
        history?.forkCurrent
        && staticCtx.isLatestCompletedBoundary?.(messageId)
        && !staticCtx.disabled
        && staticCtx.onForkConversation
    )

    const rootClass = toolOnly && !turnActivity
        ? 'py-1 min-w-0 max-w-full overflow-x-clip'
        : 'px-1 min-w-0 max-w-full overflow-x-clip'

    return (
        <MessagePrimitive.Root
            id={elementId}
            data-hapi-message-role="assistant"
            className={`happy-message ${rootClass} scroll-mt-4`}
        >
            {isCliOutput
                ? <CliOutputBlock text={cliText} />
                : codexReview
                    ? <CodexReviewCard review={codexReview} />
                    : turnActivity
                        ? <TurnBlock />
                        : <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />}
<div className="flex items-center gap-1">
                <MessageActions
                    align="start"
                    copyText={copyText || undefined}
                    getCopyText={getCopyText}
                    metadata={metadata}
                    messageElementId={elementId}
                    showFork={showForkCurrent}
                    historyActionPending={historyCtx.historyActionPending}
                    onFork={showForkCurrent ? () => staticCtx.onForkConversation!() : undefined}
                />
                {!isCliOutput && !codexReview && copyText ? (
                    <SpeakSummaryButton messageId={messageId} text={copyText} getText={getCopyText} />
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
