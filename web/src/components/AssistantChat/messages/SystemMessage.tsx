import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { isLegacyCompactionStartEvent } from '@/chat/reducerEvents'
import { getEventPresentation, renderEventLabel } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { useOptionalHappyChatSessionStateContext } from '@/components/AssistantChat/context'
import { useOptionalSessionEntityStore, useOptionalSessionVisibleEntity } from '@/hooks/useSessionEntityStore'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { cn } from '@/lib/utils'

function isActiveSystemEvent(event: AgentEvent | undefined): boolean {
    if (!event) return false
    if (event.type === 'omp-compaction' && 'phase' in event && event.phase === 'started') return true
    if (event.type === 'omp-retry' && 'phase' in event && event.phase === 'started') return true
    return isLegacyCompactionStartEvent(event)
}
function formatTokenDelta(event: AgentEvent | undefined): string | null {
    if (!event || event.type !== 'compact-summary') return null
    const parts: string[] = []
    if (typeof event.tokensBefore === 'number') parts.push(event.tokensBefore.toLocaleString())
    if (typeof event.estimatedTokensAfter === 'number') parts.push(event.estimatedTokensAfter.toLocaleString())
    if (parts.length === 0) return null
    return parts.length === 2 ? `${parts[0]} → ${parts[1]} tokens` : `${parts[0]} tokens`
}

function SystemMessageView(props: {
    messageId: string
    storeBacked: boolean
    event?: AgentEvent
    compactSummary?: AgentEvent
    text: string
    createdAt?: number
}) {
    const { messageId, storeBacked, event, compactSummary, text, createdAt } = props
    const ctx = useOptionalHappyChatSessionStateContext()
    const icon = event ? getEventPresentation(event).icon : null
    const isSessionRunning = ctx?.sessionThinking !== undefined ? Boolean(ctx.sessionThinking) : true
    const showActiveSpinner = isActiveSystemEvent(event) && isSessionRunning
    const RootComponent = storeBacked ? 'div' : MessagePrimitive.Root
    const rootDataProps = storeBacked
        ? { 'data-message-id': messageId, 'data-thread-entry-id': messageId }
        : {}
    const elementId = getConversationMessageAnchorId(messageId)

    if (compactSummary && compactSummary.type === 'compact-summary') {
        const delta = formatTokenDelta(compactSummary)
        return (
            <RootComponent id={elementId} data-hapi-message-role="system" {...rootDataProps} className="aui-message-root scroll-mt-4 py-1">
                <div className="mx-auto max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                        <span aria-hidden="true">📦</span>
                        <span className="font-medium">Context compacted</span>
                        {delta ? <span className="font-normal">{delta}</span> : null}
                        <MessageTimestamp createdAt={createdAt} className="text-[10px]" />
                    </div>
                    {text ? (
                        <div className="max-h-96 overflow-y-auto pr-1">
                            <MarkdownRenderer standalone content={text} />
                        </div>
                    ) : null}
                </div>
            </RootComponent>
        )
    }

    return (
        <RootComponent id={elementId} data-hapi-message-role="system" {...rootDataProps} className="aui-message-root scroll-mt-4 py-1">
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1.5">
                    {showActiveSpinner ? (
                        <svg
                            viewBox="0 0 16 16"
                            className="turn-step-spinner-svg h-3.5 w-3.5 shrink-0 text-[#da7756]"
                            data-testid="system-event-spinner"
                            aria-hidden="true"
                        >
                            <circle
                                cx="8"
                                cy="8"
                                r="5.75"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeDasharray="16 38"
                                strokeLinecap="round"
                            />
                        </svg>
                    ) : icon ? (
                        <span aria-hidden="true">{icon}</span>
                    ) : null}
                    <span className={cn(showActiveSpinner && 'turn-text-shimmer font-medium')}>{text}</span>
                    <MessageTimestamp createdAt={createdAt} className="text-[10px]" />
                </span>
            </div>
        </RootComponent>
    )
}

function StoreSystemMessage({ messageId }: { messageId: string }) {
    const visibleEntity = useOptionalSessionVisibleEntity(messageId)
    if (!visibleEntity || visibleEntity.kind !== 'agent-event') {
        return null
    }
    const storeEvent = visibleEntity.event
    const event = storeEvent.type === 'compact-summary' ? undefined : storeEvent
    const compactSummary = storeEvent.type === 'compact-summary' ? storeEvent : undefined
    const text = storeEvent.type === 'compact-summary' && typeof storeEvent.summary === 'string'
        ? storeEvent.summary
        : renderEventLabel(storeEvent)
    return (
        <SystemMessageView
            messageId={messageId}
            storeBacked
            event={event}
            compactSummary={compactSummary}
            text={text}
            createdAt={visibleEntity.createdAt}
        />
    )
}

function RuntimeSystemMessage() {
    const role = useAuiState((s) => s.message.role)
    const messageId = useAuiState((s) => s.message.id)
    const visibleEntity = useOptionalSessionVisibleEntity(messageId)
    const hasStoreSystemEntity = Boolean(visibleEntity && visibleEntity.kind === 'agent-event')
    const auiText = useAuiState((s) => {
        if (hasStoreSystemEntity || s.message.role !== 'system') return ''
        return s.message.content[0]?.type === 'text' ? s.message.content[0].text : ''
    })
    const auiEvent = useAuiState((s) => {
        if (hasStoreSystemEntity || s.message.role !== 'system') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'event' ? custom.event : undefined
    })
    const auiCompactSummary = useAuiState((s) => {
        if (hasStoreSystemEntity || s.message.role !== 'system') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'compact-summary' ? custom.event : undefined
    })
    if (role !== 'system') return null
    const storeEvent = hasStoreSystemEntity && visibleEntity?.kind === 'agent-event'
        ? visibleEntity.event
        : undefined
    return (
        <SystemMessageView
            messageId={messageId}
            storeBacked={false}
            event={hasStoreSystemEntity ? (storeEvent?.type === 'compact-summary' ? undefined : storeEvent) : auiEvent}
            compactSummary={hasStoreSystemEntity ? (storeEvent?.type === 'compact-summary' ? storeEvent : undefined) : auiCompactSummary}
            text={hasStoreSystemEntity && storeEvent
                ? (storeEvent.type === 'compact-summary' && typeof storeEvent.summary === 'string' ? storeEvent.summary : renderEventLabel(storeEvent))
                : auiText}
            createdAt={hasStoreSystemEntity && visibleEntity ? visibleEntity.createdAt : undefined}
        />
    )
}

export function HappySystemMessage(props: { messageId?: string } = {}) {
    const store = useOptionalSessionEntityStore()
    if (store && props.messageId) {
        return <StoreSystemMessage messageId={props.messageId} />
    }
    return <RuntimeSystemMessage />
}
