import { useEffect, useMemo, useState } from 'react'
import { TextMessagePartProvider, useAuiState } from '@assistant-ui/react'
import { projectSessionTodoSnapshot } from '@/chat/projections/todoProjection'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import type { TodoItem } from '@/types/api'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { partitionTurn, turnDurationMs, type TurnContentPart, type TurnPartition } from '@/components/AssistantChat/messages/turnBlockModel'
import { TimelineTurnBlockView, type TranscriptViewMode } from '@/components/AssistantChat/messages/TimelineTurnBlock'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'

function contentParts(content: readonly { type: string }[]): TurnContentPart[] {
    return content.flatMap((part): TurnContentPart[] => {
        if (part.type === 'text' || part.type === 'reasoning') {
            const text = 'text' in part && typeof part.text === 'string' ? part.text : ''
            const status = 'status' in part && part.status && typeof part.status === 'object'
                ? part.status as { type?: string }
                : undefined
            return [{ type: part.type, text, status }]
        }
        if (part.type !== 'tool-call') return []
        const tool = part as {
            toolCallId?: string
            toolName?: string
            result?: unknown
            isError?: boolean
            artifact?: unknown
            status?: { type?: string }
        }
        return [{
            type: 'tool-call',
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            result: tool.result,
            isError: tool.isError,
            artifact: tool.artifact,
            status: tool.status,
        }]
    })
}

function TurnText(props: { text: string; streaming: boolean }) {
    return (
        <TextMessagePartProvider text={props.text} isRunning={props.streaming}>
            <NotifySummaryText type="text" text={props.text} status={{ type: props.streaming ? 'running' : 'complete' }} />
        </TextMessagePartProvider>
    )
}

export function TurnBlockView(props: {
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    initiallyOpen: boolean
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode?: TranscriptViewMode
    lang?: 'en' | 'zh-CN'
}) {
    return (
        <TimelineTurnBlockView
            partition={props.partition}
            streaming={props.streaming}
            durationMs={props.durationMs}
            initiallyOpen={props.initiallyOpen}
            activeTodoText={props.activeTodoText}
            fallbackTodos={props.fallbackTodos}
            viewMode={props.viewMode}
            lang={props.lang}
            renderTrailingText={(text, isStreaming) => <TurnText text={text} streaming={isStreaming} />}
        />
    )
}

export function TurnBlock() {
    const ctx = useOptionalHappyChatContext()
    const { locale } = useTranslation()
    const { reasoningCollapsed } = useReasoningCollapse()
    const content = useAuiState((state) => state.message.role === 'assistant' ? state.message.content : [])
    const auiRunning = useAuiState((state) => state.message.status?.type === 'running')
    const isLastMessage = useAuiState((state) => state.message.isLast)
    const createdAt = useAuiState((state) => state.message.createdAt.getTime())
    const custom = useAuiState((state) => state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)
    const partition = useMemo(
        () => partitionTurn(contentParts(content), ctx?.metadata ?? null),
        [content, ctx?.metadata]
    )
    const hasRunningTool = useMemo(
        () => partition.rows.some(
            (row) => row.kind === 'tool'
                && (row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && Boolean(row.permission)))
        ),
        [partition.rows]
    )
    const isActiveSessionTailTurn = Boolean(
        isLastMessage
        && ctx?.sessionThinking
        && (
            ctx.activeTurnStartedAt == null
            || Math.max(createdAt, custom?.invokedAt ?? 0) >= ctx.activeTurnStartedAt
        )
    )
    const streaming = auiRunning || hasRunningTool || isActiveSessionTailTurn
    const [now, setNow] = useState(() => Date.now())

    const activeTodoText = streaming
        ? projectSessionTodoSnapshot(ctx?.todos).activeLabel
        : null
    const fallbackTodos = (streaming || isLastMessage) ? (ctx?.todos ?? null) : null

    useEffect(() => {
        if (!streaming) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [streaming])

    return (
        <TurnBlockView
            activeTodoText={activeTodoText}
            fallbackTodos={fallbackTodos}
            lang={locale === 'zh-CN' ? 'zh-CN' : 'en'}
            partition={partition}
            streaming={streaming}
            initiallyOpen={streaming && !reasoningCollapsed}
            durationMs={turnDurationMs({
                roundSummary: custom?.roundSummary,
                invokedAt: custom?.invokedAt ?? (streaming ? (ctx?.activeTurnStartedAt ?? createdAt) : undefined),
                createdAt,
                now,
                streaming,
            })}
        />
    )
}

export function messageHasTurnActivity(content: readonly { type: string }[]): boolean {
    return partitionTurn(contentParts(content), null).hasActivity
}
