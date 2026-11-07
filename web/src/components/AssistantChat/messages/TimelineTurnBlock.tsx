import { useEffect, useMemo, useRef, useState } from 'react'
import { projectTurn, type ProjectedSubturn, type ProjectedTurn, type TurnPartition } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnExecutionRail } from '@/components/AssistantChat/messages/TurnExecutionRail'
import { TimelineTodoChecklistCard, TurnTodoSection } from '@/components/AssistantChat/messages/TurnTodoSection'
import { TurnAnswerSection } from '@/components/AssistantChat/messages/TurnAnswerSection'
import {
    TurnActivityIndicator,
    TurnActivitySparkleIcon,
    renderSimpleMarkdownText,
    type TurnActivityIndicatorVariant,
} from '@/components/AssistantChat/messages/TimelineStepRows'
import {
    DockedQuestionWizard,
    DockedTodoProgressBar,
    SubmittedQuestionSummaryBubble,
    type DockedQuestionItem,
    type DockedTodoItem,
} from '@/components/AssistantChat/messages/TurnDockedWidgets'
import { ChatSlotHost, defineChatSlots, type TurnSlotContext } from '@/components/AssistantChat/slotRegistry'
import type { TodoItem } from '@/types/api'

export type TranscriptViewMode = 'normal' | 'thinking' | 'verbose'

export {
    DockedQuestionWizard,
    DockedTodoProgressBar,
    SubmittedQuestionSummaryBubble,
    TimelineTodoChecklistCard,
    TurnActivityIndicator,
    TurnActivitySparkleIcon,
    type DockedQuestionItem,
    type DockedTodoItem,
    type TurnActivityIndicatorVariant,
}
export const TURN_SLOTS = defineChatSlots<TurnSlotContext>([
    { id: 'turn-rail', order: 10, Component: ({ ctx }) => <TurnExecutionRail {...ctx} onOpenChange={ctx.setOpen} /> },
    { id: 'turn-todo', order: 20, Component: ({ ctx }) => <TurnTodoSection checklists={ctx.subturn.todoChecklists} accentColor={ctx.accentColor} open={ctx.open} streaming={ctx.streaming} /> },
    { id: 'turn-answer', order: 30, Component: ({ ctx }) => <TurnAnswerSection subturn={ctx.subturn} streaming={ctx.streaming} renderTrailingText={ctx.renderTrailingText} /> },
])
function SubturnView(props: {
    subturn: ProjectedSubturn
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    initiallyOpen?: boolean
    activeTodoText?: string | null
    viewMode: TranscriptViewMode
    lang: 'en' | 'zh-CN'
    accentColor: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const { subturn, partition, streaming, durationMs, initiallyOpen, activeTodoText, viewMode, lang, accentColor, renderTrailingText } = props
    const [open, setOpen] = useState(initiallyOpen ?? (viewMode === 'verbose'))
    const sawStream = useRef(streaming)
    const hasPendingInteractive = useMemo(
        () => subturn.rows.some((row) => row.kind === 'tool' && (row.permission || row.block.tool.state === 'pending')),
        [subturn.rows]
    )

    useEffect(() => {
        if (sawStream.current && !streaming && viewMode !== 'verbose' && !hasPendingInteractive) setOpen(false)
        sawStream.current = streaming
    }, [streaming, viewMode, hasPendingInteractive])

    useEffect(() => {
        if (viewMode === 'verbose') setOpen(true)
    }, [viewMode])
    return (
        <div data-testid="turn-subturn" className="w-full">
            <ChatSlotHost
                slots={TURN_SLOTS}
                ctx={{ ...props, open, setOpen }}
                resetKey={subturn.key}
            />
        </div>
    )
}

export function TimelineTurnBlockView(props: {
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    initiallyOpen?: boolean
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode?: TranscriptViewMode
    lang?: 'en' | 'zh-CN'
    indicatorVariant?: TurnActivityIndicatorVariant
    indicatorColor?: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const lang = props.lang ?? 'en'
    const viewMode = props.viewMode ?? 'normal'
    const accentColor = props.indicatorColor ?? '#da7756'

    const prevProjectedRef = useRef<ProjectedTurn | null>(null)
    const projected = useMemo(() => {
        const next = projectTurn(props.partition, {
            viewMode,
            streaming: props.streaming,
            fallbackTodos: props.fallbackTodos,
        }, prevProjectedRef.current)
        prevProjectedRef.current = next
        return next
    }, [props.partition, viewMode, props.streaming, props.fallbackTodos])

    const subturn = projected.subturns[0]!
    const isInitialStreamingWait =
        props.streaming
        && subturn.stepRows.length === 0
        && subturn.mediaRows.length === 0
        && subturn.answerRows.length === 0

    if (!props.partition.hasActivity && !isInitialStreamingWait) {
        if (subturn.answerRows.length === 0) return null
        return (
            <div className="my-2 space-y-3">
                {subturn.answerRows.map((row) => {
                    const isRowStreaming = props.streaming && row === subturn.lastRow
                    return (
                        <div key={row.key} className="text-[15px] leading-relaxed text-[var(--app-fg)]">
                            {props.renderTrailingText
                                ? props.renderTrailingText(row.text, isRowStreaming)
                                : renderSimpleMarkdownText(row.text)}
                        </div>
                    )
                })}
            </div>
        )
    }

    return (
        <div className="my-2.5" data-testid="turn-timeline-block">
            {projected.subturns.map((st) => (
                <SubturnView
                    key={st.key}
                    subturn={st}
                    partition={props.partition}
                    streaming={props.streaming}
                    durationMs={props.durationMs}
                    initiallyOpen={props.initiallyOpen}
                    activeTodoText={props.activeTodoText}
                    viewMode={viewMode}
                    lang={lang}
                    accentColor={accentColor}
                    renderTrailingText={props.renderTrailingText}
                />
            ))}
        </div>
    )
}
