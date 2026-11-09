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
    useOptionalSessionTurnLayout,
    useOptionalSessionVisibleEntity,
} from '@/hooks/useSessionEntityStore'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { useSessionSummaryInChat } from '@/hooks/useSessionSummaryInChat'
import { SpeakSummaryButton } from '@/components/AssistantChat/messages/SpeakSummaryButton'

const MESSAGE_PART_COMPONENTS = {
    Text: NotifySummaryText,
    Reasoning,
    ReasoningGroup,
    tools: { Fallback: HappyToolMessage },
} as const

function StoreCliOutput({ blockId }: { blockId: string }) {
    const entity = useOptionalSessionVisibleEntity(blockId)
    return entity?.kind === 'cli-output' ? <CliOutputBlock text={entity.text} /> : null
}

function StoreReview({ blockId }: { blockId: string }) {
    const entity = useOptionalSessionVisibleEntity(blockId)
    return entity?.kind === 'codex-review' ? <CodexReviewCard review={entity.review} /> : null
}

/** Copy/share/speech read the current turn at click time; metadata is a leaf. */
function StoreAssistantActions({ messageId, elementId }: { messageId: string; elementId: string }) {
    const store = useOptionalSessionEntityStore()
    const turn = useOptionalSessionTurnEntity(messageId)
    const showSummary = useSessionSummaryInChat()
    const getCopyText = () => getAssistantCopyText(store?.getLiveTurnParts(messageId) ?? [], { stripNotifySummary: !showSummary })
    const text = getCopyText()
    const first = turn?.blocks[0]
    return <AssistantActions
        messageId={messageId}
        elementId={elementId}
        copyText={text}
        getCopyText={getCopyText}
        metadata={{ durationMs: turn?.durationMs, usage: turn?.usage, model: turn?.model ?? null, turnCount: turn?.turnCount, roundSummary: turn?.roundSummary }}
        canSpeak={first?.kind !== 'cli-output' && first?.kind !== 'codex-review'}
    />
}

function AssistantActions(props: {
    messageId: string
    elementId: string
    copyText: string
    getCopyText?: () => string
    metadata: { durationMs?: number; usage?: HappyChatMessageMetadata['usage']; model: string | null; turnCount?: number; roundSummary?: HappyChatMessageMetadata['roundSummary'] }
    canSpeak: boolean
}) {
    const ctx = useHappyChatStaticContext()
    const history = useHappyChatHistoryContext()
    const showFork = Boolean(ctx.metadata?.capabilities?.conversationHistory?.forkCurrent
        && ctx.isLatestCompletedBoundary?.(props.messageId) && !ctx.disabled && ctx.onForkConversation)
    return <div className="flex items-center gap-1">
        <MessageActions align="start" copyText={props.copyText || undefined} getCopyText={props.getCopyText}
            metadata={props.metadata} messageElementId={props.elementId} showFork={showFork}
            historyActionPending={history.historyActionPending} onFork={showFork ? () => ctx.onForkConversation!() : undefined} />
        {props.canSpeak && props.copyText ? <SpeakSummaryButton messageId={props.messageId} text={props.copyText} getText={props.getCopyText} /> : null}
    </div>
}

function StoreAssistantMessage({ messageId }: { messageId: string }) {
    const layout = useOptionalSessionTurnLayout(messageId)
    const elementId = getConversationMessageAnchorId(messageId)
    const first = layout?.blocks[0]
    const standalone = layout?.blocks.length === 1
    return <MessagePrimitive.Root id={elementId} data-hapi-message-role="assistant" className="happy-message px-1 min-w-0 max-w-full overflow-x-clip scroll-mt-4">
        {standalone && first?.kind === 'cli-output'
            ? <StoreCliOutput blockId={first.id} />
            : standalone && first?.kind === 'codex-review'
                ? <StoreReview blockId={first.id} />
                : <TurnBlock />}
        <StoreAssistantActions messageId={messageId} elementId={elementId} />
    </MessagePrimitive.Root>
}

/** Standalone consumers keep assistant-ui's full content renderer. */
function RuntimeAssistantMessage({ messageId }: { messageId: string }) {
    const showSummary = useSessionSummaryInChat()
    const custom = useAuiState((s) => s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)
    const content = useAuiState((s) => s.message.content)
    const running = useAuiState((s) => s.message.status?.type === 'running')
    const elementId = getConversationMessageAnchorId(messageId)
    const cliText = custom?.kind === 'cli-output' ? content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? '' : ''
    const review = custom?.kind === 'codex-review' ? custom.review : undefined
    const activity = messageHasTurnActivity(content) || (running && !content.some((part) => part.type === 'text' && part.text.trim()))
    const copyText = getAssistantCopyText(content, { stripNotifySummary: !showSummary })
    return <MessagePrimitive.Root id={elementId} data-hapi-message-role="assistant" className="happy-message px-1 min-w-0 max-w-full overflow-x-clip scroll-mt-4">
        {custom?.kind === 'cli-output' ? <CliOutputBlock text={cliText} /> : review ? <CodexReviewCard review={review} /> : activity ? <TurnBlock /> : <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />}
        <AssistantActions messageId={messageId} elementId={elementId} copyText={copyText}
            metadata={{ durationMs: custom?.durationMs, usage: custom?.usage, model: custom?.model ?? null, turnCount: custom?.turnCount, roundSummary: custom?.roundSummary }}
            canSpeak={custom?.kind !== 'cli-output' && !review} />
    </MessagePrimitive.Root>
}

export function HappyAssistantMessage() {
    const store = useOptionalSessionEntityStore()
    const messageId = useAuiState((s) => s.message.id)
    return store ? <StoreAssistantMessage messageId={messageId} /> : <RuntimeAssistantMessage messageId={messageId} />
}
