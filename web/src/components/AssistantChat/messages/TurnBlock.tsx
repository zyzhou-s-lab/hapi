import { memo, useMemo, useRef } from 'react'
import { TextMessagePartProvider, useAuiState } from '@assistant-ui/react'
import { projectSessionTodoSnapshot } from '@/chat/projections/todoProjection'
import { useOptionalHappyChatSessionStateContext, useOptionalHappyChatStaticContext, useOptionalHappyChatTodosContext } from '@/components/AssistantChat/context'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { useOptionalSessionEntityStore, useOptionalSessionTurnHeader, useOptionalSessionTurnLayout } from '@/hooks/useSessionEntityStore'
import type { TodoItem } from '@/types/api'
import {
    hasTurnContentActivity,
    partitionTurn,
    turnDurationMs,
    type ProjectedTurn,
    type TurnContentPart,
    type TurnPartition,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TimelineTurnBlockView, type TranscriptViewMode } from '@/components/AssistantChat/messages/TimelineTurnBlock'
import { TurnStepExpansionStore } from '@/components/AssistantChat/messages/TimelineStepRows'
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
    projectedTurn?: ProjectedTurn | null
    streaming: boolean
    durationMs: number | null
    streamingStartedAt?: number | null
    initiallyOpen: boolean
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode?: TranscriptViewMode
    lang?: 'en' | 'zh-CN'
    turnId?: string
    stepExpansionStore?: TurnStepExpansionStore
    shareCapture?: boolean
}) {
    return (
        <TimelineTurnBlockView {...props} renderTrailingText={renderTurnText} />
    )
}

const MemoizedTurnBlockView = memo(TurnBlockView)

function HistoricalTurnBlockBody(props: {
    partition: TurnPartition
    projectedTurn?: ProjectedTurn | null
    createdAt: number
    custom: Partial<HappyChatMessageMetadata> | undefined
    lang: 'en' | 'zh-CN'
    turnId?: string
    stepExpansionStore?: TurnStepExpansionStore
    shareCapture?: boolean
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
    return <MemoizedTurnBlockView activeTodoText={null} fallbackTodos={null} lang={props.lang} partition={props.partition} projectedTurn={props.projectedTurn} streaming={false} initiallyOpen={false} durationMs={durationMs} turnId={props.turnId} stepExpansionStore={props.stepExpansionStore} shareCapture={props.shareCapture} />
}

function LiveTailTurnBlockBody(props: {
    partition: TurnPartition
    auiRunning: boolean
    hasRunningTool: boolean
    isLastMessage: boolean
    createdAt: number
    custom: Partial<HappyChatMessageMetadata> | undefined
    lang: 'en' | 'zh-CN'
    turnId?: string
    stepExpansionStore?: TurnStepExpansionStore
    shareCapture?: boolean
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
    const activeTodoText = streaming ? projectSessionTodoSnapshot(todosCtx?.todos).activeLabel : null
    const fallbackTodos = (streaming || props.isLastMessage) ? (todosCtx?.todos ?? null) : null
    const invokedAt = props.custom?.invokedAt ?? (streaming ? (sessionStateCtx?.activeTurnStartedAt ?? props.createdAt) : undefined)
    const settledDurationMs = turnDurationMs({
        roundSummary: props.custom?.roundSummary,
        invokedAt,
        createdAt: props.createdAt,
        now: props.createdAt,
        streaming: false,
    })
    const streamingStartedAt = streaming && props.custom?.roundSummary?.durationMs === undefined
        ? (invokedAt ?? null)
        : null

    return <MemoizedTurnBlockView activeTodoText={activeTodoText} fallbackTodos={fallbackTodos} lang={props.lang} partition={props.partition} streaming={streaming} initiallyOpen={false} durationMs={settledDurationMs} streamingStartedAt={streamingStartedAt} turnId={props.turnId} stepExpansionStore={props.stepExpansionStore} shareCapture={props.shareCapture} />
}

const EMPTY_TURN_PARTITION: TurnPartition = partitionTurn([], null)

function StoreTurnBlock({ messageId, shareCapture }: { messageId: string; shareCapture?: boolean }) {
    const { locale } = useTranslation()
    const turnLayout = useOptionalSessionTurnLayout(messageId)
    const turnHeader = useOptionalSessionTurnHeader(messageId)
    const stepExpansionStoreRef = useRef<TurnStepExpansionStore | null>(null)
    stepExpansionStoreRef.current ??= new TurnStepExpansionStore()
    const partition = turnLayout?.partition ?? EMPTY_TURN_PARTITION
    const projectedTurn = turnLayout?.projectedSettled ?? null
    const isLastMessage = Boolean(turnHeader?.isLast)
    const auiRunning = Boolean(turnHeader?.isRunning)
    const hasRunningTool = Boolean(turnHeader?.hasRunningTool)
    const createdAt = turnHeader?.timestamp ?? 0
    const custom = useMemo(
        () => ({ invokedAt: turnHeader?.invokedAt ?? undefined, roundSummary: turnHeader?.roundSummary }),
        [turnHeader?.invokedAt, turnHeader?.roundSummary]
    )
    const lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
    return !isLastMessage && !auiRunning && !hasRunningTool
        ? <HistoricalTurnBlockBody partition={partition} projectedTurn={projectedTurn} createdAt={createdAt} custom={custom} lang={lang} turnId={messageId} stepExpansionStore={stepExpansionStoreRef.current} shareCapture={shareCapture} />
        : <LiveTailTurnBlockBody partition={partition} auiRunning={auiRunning} hasRunningTool={hasRunningTool} isLastMessage={isLastMessage} createdAt={createdAt} custom={custom} lang={lang} turnId={messageId} stepExpansionStore={stepExpansionStoreRef.current} shareCapture={shareCapture} />
}

function RuntimeTurnBlock({ shareCapture }: { shareCapture?: boolean }) {
    const staticCtx = useOptionalHappyChatStaticContext()
    const { locale } = useTranslation()
    const messageId = useAuiState((state) => state.message.id)
    const turnLayout = useOptionalSessionTurnLayout(messageId)
    const hasStoreTurn = Boolean(turnLayout)
    const fallbackContent = useAuiState((state) => (
        !hasStoreTurn && state.message.role === 'assistant' ? state.message.content : null
    ))
    const auiRunning = useAuiState((state) => state.message.status?.type === 'running')
    const isLastMessage = useAuiState((state) => state.message.isLast)
    const createdAt = useAuiState((state) => state.message.createdAt.getTime())
    const auiInvokedAt = useAuiState((state) => (state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.invokedAt)
    const auiRoundSummary = useAuiState((state) => (state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.roundSummary)
    const custom = useMemo(() => ({ invokedAt: auiInvokedAt, roundSummary: auiRoundSummary }), [auiInvokedAt, auiRoundSummary])
    const stepExpansionStoreRef = useRef<TurnStepExpansionStore | null>(null)
    stepExpansionStoreRef.current ??= new TurnStepExpansionStore()
    const prevPartitionRef = useRef<TurnPartition | null>(null)
    const partition = useMemo(() => {
        if (turnLayout) {
            prevPartitionRef.current = turnLayout.partition
            return turnLayout.partition
        }
        const parts = contentParts(fallbackContent ?? [])
        const next = partitionTurn(parts, staticCtx?.metadata ?? null, prevPartitionRef.current)
        prevPartitionRef.current = next
        return next
    }, [fallbackContent, staticCtx?.metadata, turnLayout])
    const hasRunningTool = useMemo(
        () => partition.rows.some(
            (row) => row.kind === 'tool'
                && (row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && Boolean(row.permission)))
        ),
        [partition.rows]
    )
    const lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
    return !isLastMessage && !auiRunning && !hasRunningTool
        ? <HistoricalTurnBlockBody partition={partition} projectedTurn={turnLayout?.projectedSettled ?? null} createdAt={createdAt} custom={custom} lang={lang} turnId={messageId} stepExpansionStore={stepExpansionStoreRef.current} shareCapture={shareCapture} />
        : <LiveTailTurnBlockBody partition={partition} auiRunning={auiRunning} hasRunningTool={hasRunningTool} isLastMessage={isLastMessage} createdAt={createdAt} custom={custom} lang={lang} turnId={messageId} stepExpansionStore={stepExpansionStoreRef.current} shareCapture={shareCapture} />
}

export function TurnBlock(props: { messageId?: string; shareCapture?: boolean } = {}) {
    const store = useOptionalSessionEntityStore()
    return store && props.messageId
        ? <StoreTurnBlock messageId={props.messageId} shareCapture={props.shareCapture} />
        : <RuntimeTurnBlock shareCapture={props.shareCapture} />
}

export function messageHasTurnActivity(content: readonly { type: string }[]): boolean {
    return hasTurnContentActivity(contentParts(content))
}
