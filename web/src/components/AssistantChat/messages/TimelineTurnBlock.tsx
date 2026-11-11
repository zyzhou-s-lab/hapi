import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { projectTurn, type ProjectedSubturn, type ProjectedTurn, type TurnPartition } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnExecutionRail } from '@/components/AssistantChat/messages/TurnExecutionRail'
import { TimelineTodoChecklistCard, TurnTodoSection } from '@/components/AssistantChat/messages/TurnTodoSection'
import { TurnAnswerSection } from '@/components/AssistantChat/messages/TurnAnswerSection'
import {
    resolveTurnStepBlockId, TurnActivityIndicator, TurnActivitySparkleIcon,
    TurnStepExpansionContext, TurnStepExpansionStore, type TurnActivityIndicatorVariant,
} from '@/components/AssistantChat/messages/TimelineStepRows'
import {
    DockedQuestionWizard, DockedTodoProgressBar, SubmittedQuestionSummaryBubble,
    type DockedQuestionItem, type DockedTodoItem,
} from '@/components/AssistantChat/messages/TurnDockedWidgets'
import { ChatSlotHost, defineChatSlots, type TurnSlotContext } from '@/components/AssistantChat/slotRegistry'
import type { TodoItem } from '@/types/api'

export type TranscriptViewMode = 'normal' | 'thinking' | 'verbose'

export {
    DockedQuestionWizard, DockedTodoProgressBar, SubmittedQuestionSummaryBubble,
    TimelineTodoChecklistCard, TurnActivityIndicator, TurnActivitySparkleIcon,
    type DockedQuestionItem, type DockedTodoItem, type TurnActivityIndicatorVariant,
}
const TurnRailShareCaptureContext = createContext<boolean>(false)

function TurnRailSlotComponent(props: { ctx: TurnSlotContext }) {
    const shareCapture = useContext(TurnRailShareCaptureContext)
    return <TurnExecutionRail {...props.ctx} onOpenChange={props.ctx.setOpen} shareCapture={shareCapture} />
}

export const TURN_SLOTS = defineChatSlots<TurnSlotContext>([
    { id: 'turn-rail', order: 10, Component: TurnRailSlotComponent },
    { id: 'turn-todo', order: 20, Component: ({ ctx }) => <TurnTodoSection checklists={ctx.subturn.todoChecklists} rows={ctx.subturn.nonTrailingRows} fallbackTodos={ctx.fallbackTodos} accentColor={ctx.accentColor} open={ctx.open} streaming={ctx.streaming} /> },
    { id: 'turn-answer', order: 30, Component: ({ ctx }) => <TurnAnswerSection subturn={ctx.subturn} streaming={ctx.streaming} renderTrailingText={ctx.renderTrailingText} /> },
])

function resolveFirstStableRowBlockId(subturn: ProjectedSubturn, turnId?: string): string | undefined {
    for (const row of subturn.rows) {
        const id = resolveTurnStepBlockId(row)
        if (id) return id
    }
    return turnId
}

function resolveStableSubturnId(subturn: ProjectedSubturn, turnId?: string): string {
    if (turnId) return `subturn:${turnId}`
    const firstStableId = resolveFirstStableRowBlockId(subturn)
    return firstStableId ? `subturn:${firstStableId}` : subturn.key
}

function SubturnView(props: {
    subturn: ProjectedSubturn
    stableSubturnId: string
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    streamingStartedAt?: number | null
    open: boolean
    onOpenChange: (stableId: string, next: boolean) => void
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode: TranscriptViewMode
    lang: 'en' | 'zh-CN'
    accentColor: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const { subturn, stableSubturnId, streaming, open, viewMode } = props
    const onOpenChange = useCallback((next: boolean) => props.onOpenChange(stableSubturnId, next), [props.onOpenChange, stableSubturnId])
    const sawStream = useRef(streaming)
    const hasPendingInteractive = useMemo(
        () => subturn.rows.some((row) => row.kind === 'tool' && (row.permission || row.block.tool.state === 'pending')),
        [subturn.rows]
    )

    useEffect(() => {
        if (sawStream.current && !streaming && viewMode !== 'verbose' && !hasPendingInteractive) onOpenChange(false)
        sawStream.current = streaming
    }, [streaming, viewMode, hasPendingInteractive, onOpenChange])

    useEffect(() => {
        if (viewMode === 'verbose') onOpenChange(true)
    }, [viewMode, onOpenChange])

    const subturnBlockId = resolveFirstStableRowBlockId(subturn)
    return (
        <div data-testid="turn-subturn" data-block-id={subturnBlockId} className="w-full">
            <ChatSlotHost slots={TURN_SLOTS} ctx={{ ...props, open, setOpen: onOpenChange }} resetKey={stableSubturnId} />
        </div>
    )
}

export function TimelineTurnBlockView(props: {
    partition: TurnPartition
    projectedTurn?: ProjectedTurn | null
    streaming: boolean
    durationMs: number | null
    streamingStartedAt?: number | null
    initiallyOpen?: boolean
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode?: TranscriptViewMode
    lang?: 'en' | 'zh-CN'
    indicatorVariant?: TurnActivityIndicatorVariant
    indicatorColor?: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
    turnId?: string
    stepExpansionStore?: TurnStepExpansionStore
    shareCapture?: boolean
}) {
    const lang = props.lang ?? 'en'
    const viewMode = props.viewMode ?? 'normal'
    const accentColor = props.indicatorColor ?? '#da7756'
    const shareCapture = props.shareCapture ?? false
    const internalExpansionStoreRef = useRef<TurnStepExpansionStore | null>(null)
    internalExpansionStoreRef.current ??= new TurnStepExpansionStore()
    const stepExpansionStore = props.stepExpansionStore ?? internalExpansionStoreRef.current
    const [, bumpOpenRevision] = useState(0)
    const getSubturnOpen = useCallback((stableId: string): boolean => (
        stepExpansionStore.subturns.get(stableId) ?? (props.initiallyOpen ?? (viewMode === 'verbose'))
    ), [stepExpansionStore, props.initiallyOpen, viewMode])
    const setSubturnOpen = useCallback((stableId: string, next: boolean): void => {
        if (stepExpansionStore.subturns.get(stableId) === next) return
        stepExpansionStore.subturns.set(stableId, next)
        bumpOpenRevision((rev) => rev + 1)
    }, [stepExpansionStore])
    const prevProjectedRef = useRef<ProjectedTurn | null>(null)
    const projected = useMemo(() => {
        const next = (props.projectedTurn && !props.streaming && viewMode === 'normal' && !props.fallbackTodos?.length)
            ? props.projectedTurn
            : projectTurn(props.partition, { viewMode, streaming: props.streaming, fallbackTodos: props.fallbackTodos }, prevProjectedRef.current)
        prevProjectedRef.current = next
        return next
    }, [props.projectedTurn, props.partition, viewMode, props.streaming, props.fallbackTodos])
    const subturn = projected.subturns[0]!
    const isInitialStreamingWait = props.streaming && subturn.stepRows.length === 0 && subturn.mediaRows.length === 0 && subturn.answerRows.length === 0

    if (!props.partition.hasActivity && !isInitialStreamingWait) {
        if (subturn.answerRows.length === 0) return null
        return <TurnAnswerSection subturn={subturn} streaming={props.streaming} renderTrailingText={props.renderTrailingText} />
    }

    const firstSubturnBlockId = resolveFirstStableRowBlockId(subturn, props.turnId)

    return (
        <TurnStepExpansionContext.Provider value={stepExpansionStore}>
            <TurnRailShareCaptureContext.Provider value={shareCapture}>
                <div className="my-2.5" data-testid="turn-timeline-block" data-block-id={firstSubturnBlockId}>
                    {projected.subturns.map((st) => {
                        const stableSubturnId = resolveStableSubturnId(st, props.turnId)
                        return (
                            <SubturnView
                                key={stableSubturnId}
                                subturn={st}
                                stableSubturnId={stableSubturnId}
                                partition={props.partition}
                                streaming={props.streaming}
                                durationMs={props.durationMs}
                                streamingStartedAt={props.streamingStartedAt}
                                open={getSubturnOpen(stableSubturnId)}
                                onOpenChange={setSubturnOpen}
                                activeTodoText={props.activeTodoText}
                                fallbackTodos={props.fallbackTodos}
                                viewMode={viewMode}
                                lang={lang}
                                accentColor={accentColor}
                                renderTrailingText={props.renderTrailingText}
                            />
                        )
                    })}
                </div>
            </TurnRailShareCaptureContext.Provider>
        </TurnStepExpansionContext.Provider>
    )
}
