import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { TextMessagePartProvider, useAuiState } from '@assistant-ui/react'
import { projectSessionTodoSnapshot } from '@/chat/projections/todoProjection'
import { useOptionalHappyChatSessionStateContext, useOptionalHappyChatStaticContext, useOptionalHappyChatTodosContext } from '@/components/AssistantChat/context'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { useOptionalSessionEntityStore, useOptionalSessionTurnLayout } from '@/hooks/useSessionEntityStore'
import type { TodoItem } from '@/types/api'
import {
    hasTurnContentActivity,
    partitionTurn,
    turnDurationMs,
    type TurnContentPart,
    type TurnPartition,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TimelineTurnBlockView, type TranscriptViewMode } from '@/components/AssistantChat/messages/TimelineTurnBlock'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'

function contentParts(content: readonly { type: string }[]): TurnContentPart[] {
    return content.flatMap((part): TurnContentPart[] => {
        if (part.type === 'text' || part.type === 'reasoning') {
            const text = 'text' in part && typeof part.text === 'string' ? part.text : ''
            const status = 'status' in part && part.status && typeof part.status === 'object' ? part.status as { type?: string } : undefined
            const phase = 'phase' in part && (part.phase === 'execution' || part.phase === 'final_answer') ? part.phase : undefined
            const blockId = 'blockId' in part && typeof part.blockId === 'string' ? part.blockId : undefined
            return [{
                type: part.type, text, status,
                ...(phase !== undefined ? { phase } : {}),
                ...(blockId !== undefined ? { blockId } : {}),
            }]
        }
        const tool = part as { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean; artifact?: unknown; status?: { type?: string } }
        return [{
            type: 'tool-call', toolCallId: tool.toolCallId, toolName: tool.toolName,
            result: tool.result, isError: tool.isError, artifact: tool.artifact, status: tool.status,
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

function renderTurnText(text: string, isStreaming: boolean) {
    return <TurnText text={text} streaming={isStreaming} />
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
        <TimelineTurnBlockView {...props} renderTrailingText={renderTurnText} />
    )
}

const MemoizedTurnBlockView = memo(TurnBlockView)

function HistoricalTurnBlockBody(props: {
    partition: TurnPartition
    createdAt: number
    custom: Partial<HappyChatMessageMetadata> | undefined
    lang: 'en' | 'zh-CN'
}) {
    const durationMs = useMemo(
        () => turnDurationMs({
            roundSummary: props.custom?.roundSummary,
            invokedAt: props.custom?.invokedAt,
            createdAt: props.createdAt,
            now: props.createdAt,
            streaming: false,
        }),
        [props.custom?.roundSummary, props.custom?.invokedAt, props.createdAt]
    )
    return (
        <MemoizedTurnBlockView
            activeTodoText={null}
            fallbackTodos={null}
            lang={props.lang}
            partition={props.partition}
            streaming={false}
            initiallyOpen={false}
            durationMs={durationMs}
        />
    )
}

function LiveTailTurnBlockBody(props: {
    partition: TurnPartition
    auiRunning: boolean
    hasRunningTool: boolean
    isLastMessage: boolean
    createdAt: number
    custom: Partial<HappyChatMessageMetadata> | undefined
    lang: 'en' | 'zh-CN'
}) {
    const sessionStateCtx = useOptionalHappyChatSessionStateContext()
    const todosCtx = useOptionalHappyChatTodosContext()
    const isActiveSessionTailTurn = Boolean(
        props.isLastMessage
        && sessionStateCtx?.sessionThinking
        && (
            sessionStateCtx.activeTurnStartedAt == null
            || Math.max(props.createdAt, props.custom?.invokedAt ?? 0) >= sessionStateCtx.activeTurnStartedAt
        )
    )
    const streaming = props.auiRunning || props.hasRunningTool || isActiveSessionTailTurn
    const [now, setNow] = useState(() => Date.now())
    const activeTodoText = streaming ? projectSessionTodoSnapshot(todosCtx?.todos).activeLabel : null
    const fallbackTodos = (streaming || props.isLastMessage) ? (todosCtx?.todos ?? null) : null

    useEffect(() => {
        if (!streaming) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [streaming])

    return (
        <MemoizedTurnBlockView
            activeTodoText={activeTodoText}
            fallbackTodos={fallbackTodos}
            lang={props.lang}
            partition={props.partition}
            streaming={streaming}
            initiallyOpen={false}
            durationMs={turnDurationMs({
                roundSummary: props.custom?.roundSummary,
                invokedAt: props.custom?.invokedAt ?? (streaming ? (sessionStateCtx?.activeTurnStartedAt ?? props.createdAt) : undefined),
                createdAt: props.createdAt,
                now,
                streaming,
            })}
        />
    )
}

export function TurnBlock() {
    const staticCtx = useOptionalHappyChatStaticContext()
    const { locale } = useTranslation()
    const store = useOptionalSessionEntityStore()
    const messageId = useAuiState((state) => state.message.id)
    const turnLayout = useOptionalSessionTurnLayout(messageId)
    const hasStoreTurn = Boolean(turnLayout)
    const fallbackContent = useAuiState((state) => (
        !hasStoreTurn && state.message.role === 'assistant' ? state.message.content : null
    ))
    const auiRunning = useAuiState((state) => state.message.status?.type === 'running')
    const isLastMessage = useAuiState((state) => state.message.isLast)
    const auiCreatedAt = useAuiState((state) => state.message.createdAt.getTime())
    const auiInvokedAt = useAuiState((state) => (state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.invokedAt)
    const auiRoundSummary = useAuiState((state) => (state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.roundSummary)
    const createdAt = auiCreatedAt
    const custom = useMemo(() => ({ invokedAt: auiInvokedAt, roundSummary: auiRoundSummary }), [auiInvokedAt, auiRoundSummary])

    const prevPartitionRef = useRef<TurnPartition | null>(null)
    const partition = useMemo(() => {
        const parts = hasStoreTurn ? (store?.getLiveTurnParts(messageId) ?? []) : contentParts(fallbackContent ?? [])
        const next = partitionTurn(parts, staticCtx?.metadata ?? null, prevPartitionRef.current)
        prevPartitionRef.current = next
        return next
    }, [fallbackContent, staticCtx?.metadata, turnLayout, store, messageId, hasStoreTurn])
    const hasRunningTool = useMemo(
        () => partition.rows.some(
            (row) => row.kind === 'tool'
                && (row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && Boolean(row.permission)))
        ),
        [partition.rows]
    )
    const lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
    if (!isLastMessage && !auiRunning && !hasRunningTool) {
        return <HistoricalTurnBlockBody partition={partition} createdAt={createdAt} custom={custom} lang={lang} />
    }
    return (
        <LiveTailTurnBlockBody
            partition={partition}
            auiRunning={auiRunning}
            hasRunningTool={hasRunningTool}
            isLastMessage={isLastMessage}
            createdAt={createdAt}
            custom={custom}
            lang={lang}
        />
    )
}

export function messageHasTurnActivity(content: readonly { type: string }[]): boolean {
    return hasTurnContentActivity(contentParts(content))
}
