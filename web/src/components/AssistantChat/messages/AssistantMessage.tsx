import { useCallback, useMemo } from 'react'
import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { messageHasTurnActivity, TurnBlock } from '@/components/AssistantChat/messages/TurnBlock'
import { getStandaloneBlockRegistration } from '@/components/AssistantChat/messages/standaloneBlockRendererRegistry'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'
import {
    useHappyChatHistoryContext,
    useHappyChatStaticContext,
    useOptionalHappyChatSessionStateContext,
} from '@/components/AssistantChat/context'
import {
    useOptionalSessionEntityStore,
    useOptionalSessionTurnHeader,
    useOptionalSessionTurnLayout,
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

/** Copy/share/speech read the current turn at click time; metadata subscribes only to header:<id>. */
function StoreAssistantActions({ messageId, elementId }: { messageId: string; elementId: string }) {
    const store = useOptionalSessionEntityStore()
    const header = useOptionalSessionTurnHeader(messageId)
    const sessionState = useOptionalHappyChatSessionStateContext()
    const showSummary = useSessionSummaryInChat()
    const hasCopyableText = showSummary
        ? Boolean(header?.hasCopyableText)
        : Boolean(header?.hasStrippedCopyableText ?? header?.hasCopyableText)
    const metadata = useMemo(
        () => ({
            durationMs: header?.durationMs,
            usage: header?.usage,
            model: header?.model ?? null,
            turnCount: header?.turnCount,
            roundSummary: header?.roundSummary,
        }),
        [header?.durationMs, header?.usage, header?.model, header?.turnCount, header?.roundSummary]
    )
    const getCopyText = useCallback(
        () => getAssistantCopyText(store?.getLiveTurnParts(messageId) ?? [], { stripNotifySummary: !showSummary }),
        [store, messageId, showSummary]
    )
    return <AssistantActions
        messageId={messageId}
        elementId={elementId}
        createdAt={header?.timestamp}
        threadIsRunning={Boolean(sessionState?.sessionThinking)}
        hasCopyableText={hasCopyableText}
        getCopyText={getCopyText}
        metadata={metadata}
        canSpeak={header?.canSpeak ?? true}
    />
}

function AssistantActions(props: {
    messageId: string
    elementId: string
    createdAt?: Date | number
    threadIsRunning?: boolean
    copyText?: string
    hasCopyableText?: boolean
    getCopyText?: () => string
    metadata: { durationMs?: number; usage?: HappyChatMessageMetadata['usage']; model: string | null; turnCount?: number; roundSummary?: HappyChatMessageMetadata['roundSummary'] }
    canSpeak: boolean
}) {
    const ctx = useHappyChatStaticContext()
    const history = useHappyChatHistoryContext()
    const showFork = Boolean(ctx.metadata?.capabilities?.conversationHistory?.forkCurrent
        && ctx.isLatestCompletedBoundary?.(props.messageId) && !ctx.disabled && ctx.onForkConversation)
    const hasCopy = Boolean(props.copyText || props.hasCopyableText)
    return <div className="flex items-center gap-1">
        <MessageActions
            align="start"
            messageId={props.messageId}
            createdAt={props.createdAt}
            threadIsRunning={props.threadIsRunning}
            copyText={props.copyText || undefined}
            getCopyText={hasCopy ? props.getCopyText : undefined}
            metadata={props.metadata}
            messageElementId={props.elementId}
            showFork={showFork}
            historyActionPending={history.historyActionPending}
            onFork={showFork ? () => ctx.onForkConversation!() : undefined}
        />
        {props.canSpeak && hasCopy ? <SpeakSummaryButton messageId={props.messageId} text={props.copyText} getText={props.getCopyText} /> : null}
    </div>
}

function StoreAssistantMessage({ messageId }: { messageId: string }) {
    const layout = useOptionalSessionTurnLayout(messageId)
    const elementId = getConversationMessageAnchorId(messageId)
    const first = layout?.blocks[0]
    const standalone = layout?.blocks.length === 1
    const standaloneEntry = standalone ? getStandaloneBlockRegistration(first?.kind) : undefined
    const StandaloneStoreRenderer = standaloneEntry?.StoreRenderer
    return <div
        id={elementId}
        data-message-id={messageId}
        data-thread-entry-id={messageId}
        data-hapi-message-role="assistant"
        className="aui-message-root happy-message px-1 min-w-0 max-w-full overflow-x-clip scroll-mt-4"
    >
        {StandaloneStoreRenderer && first
            ? <StandaloneStoreRenderer blockId={first.id} />
            : <TurnBlock messageId={messageId} />}
        <StoreAssistantActions messageId={messageId} elementId={elementId} />
    </div>
}

/** Standalone consumers keep assistant-ui's full content renderer. */
function RuntimeAssistantMessage({ messageId }: { messageId: string }) {
    const showSummary = useSessionSummaryInChat()
    const custom = useAuiState((s) => s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)
    const content = useAuiState((s) => s.message.content)
    const running = useAuiState((s) => s.message.status?.type === 'running')
    const elementId = getConversationMessageAnchorId(messageId)
    const standaloneEntry = getStandaloneBlockRegistration(custom?.kind)
    const StandaloneRuntimeRenderer = standaloneEntry?.RuntimeRenderer
    const activity = messageHasTurnActivity(content) || (running && !content.some((part) => part.type === 'text' && part.text.trim()))
    const copyText = getAssistantCopyText(content, { stripNotifySummary: !showSummary })
    return <MessagePrimitive.Root id={elementId} data-hapi-message-role="assistant" className="happy-message px-1 min-w-0 max-w-full overflow-x-clip scroll-mt-4">
        {StandaloneRuntimeRenderer
            ? <StandaloneRuntimeRenderer custom={custom} content={content} />
            : activity
                ? <TurnBlock />
                : <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />}
        <AssistantActions messageId={messageId} elementId={elementId} copyText={copyText}
            metadata={{ durationMs: custom?.durationMs, usage: custom?.usage, model: custom?.model ?? null, turnCount: custom?.turnCount, roundSummary: custom?.roundSummary }}
            canSpeak={standaloneEntry ? standaloneEntry.canSpeak : true} />
    </MessagePrimitive.Root>
}

function StoreAssistantMessageFromAui() {
    const messageId = useAuiState((s) => s.message.id)
    return <StoreAssistantMessage messageId={messageId} />
}

function RuntimeAssistantMessageFromAui() {
    const messageId = useAuiState((s) => s.message.id)
    return <RuntimeAssistantMessage messageId={messageId} />
}

export function HappyAssistantMessage(props: { messageId?: string } = {}) {
    const store = useOptionalSessionEntityStore()
    if (store) {
        return props.messageId
            ? <StoreAssistantMessage messageId={props.messageId} />
            : <StoreAssistantMessageFromAui />
    }
    return props.messageId
        ? <RuntimeAssistantMessage messageId={props.messageId} />
        : <RuntimeAssistantMessageFromAui />
}
