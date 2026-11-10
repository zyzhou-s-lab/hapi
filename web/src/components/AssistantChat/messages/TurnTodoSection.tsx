import { memo, useMemo, useRef } from 'react'
import { resolveTodoToolKind } from '@/chat/projections/todoProjection'
import {
    projectSubturnTodoChecklists,
    type ProjectedTodoChecklist,
    type TurnRow,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { useLiveTurnRows } from './useLiveTurnRows'
import { ChecklistList, type ChecklistItem } from '@/components/ToolCard/checklist'
import { Card } from '@/components/ui/card'
import type { TodoItem } from '@/types/api'
export const TimelineTodoChecklistCard = memo(function TimelineTodoChecklistCard(props: {
    items: ChecklistItem[]
    className?: string
    accentColor?: string
    suppressRunningShimmer?: boolean
}) {
    if (props.items.length === 0) return null

    return (
        <Card
            variant="surface"
            data-hapi-share-exclude="true"
            data-testid="turn-todo-checklist-card"
            className={props.className}
        >
            <ChecklistList
                items={props.items}
                testIdPrefix="turn-todo-item"
                rowTestId="turn-todo-card-item"
                suppressRunningShimmer={props.suppressRunningShimmer}
            />
        </Card>
    )
})

export const TurnTodoSection = memo(function TurnTodoSection(props: {
    checklists: ProjectedTodoChecklist[]
    rows?: readonly TurnRow[]
    fallbackTodos?: readonly TodoItem[] | null
    accentColor?: string
    suppressRunningShimmer?: boolean
    open?: boolean
    streaming?: boolean
}) {
    const todoToolRows = useMemo(
        () => (props.rows ?? []).filter(
            (row): row is TurnToolRow => row.kind === 'tool' && resolveTodoToolKind(row.block.tool.name) !== null
        ),
        [props.rows]
    )
    const liveTodoRows = useLiveTurnRows(todoToolRows)
    const prevChecklistsRef = useRef<readonly ProjectedTodoChecklist[] | null>(null)
    const checklists = useMemo(() => {
        if (todoToolRows.length === 0) {
            prevChecklistsRef.current = props.checklists
            return props.checklists
        }
        const next = projectSubturnTodoChecklists(
            liveTodoRows,
            { streaming: props.streaming, fallbackTodos: props.fallbackTodos },
            prevChecklistsRef.current ?? props.checklists
        ).todoChecklists
        prevChecklistsRef.current = next
        return next
    }, [todoToolRows.length, liveTodoRows, props.checklists, props.streaming, props.fallbackTodos])
    const visibleChecklists = (props.open || props.streaming)
        ? checklists
        : checklists.filter(
            (checklist) =>
                checklist.items.some((item) => item.status === 'in_progress' || item.status === 'pending')
                || !checklist.items.some((item) => item.status === 'blocked')
        )
    if (visibleChecklists.length === 0) return null

    return (
        <div
            data-hapi-share-exclude="true"
            data-testid="turn-todo-section"
            className="w-full"
        >
            <div className="mt-2 space-y-2" data-testid="turn-live-todo-cards">
                {visibleChecklists.map((checklist) => (
                    <TimelineTodoChecklistCard
                        key={checklist.key}
                        items={checklist.items}
                        accentColor={props.accentColor}
                        suppressRunningShimmer={props.suppressRunningShimmer}
                    />
                ))}
            </div>
        </div>
    )
})
