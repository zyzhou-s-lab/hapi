import type { ProjectedTodoChecklist } from '@/components/AssistantChat/messages/turnBlockModel'
import { ChecklistList, type ChecklistItem } from '@/components/ToolCard/checklist'
import { Card } from '@/components/ui/card'

export function TimelineTodoChecklistCard(props: {
    items: readonly ChecklistItem[]
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
}

export function TurnTodoSection(props: {
    checklists: readonly ProjectedTodoChecklist[]
    accentColor?: string
    suppressRunningShimmer?: boolean
    open?: boolean
    streaming?: boolean
}) {
    const visibleChecklists = (props.open || props.streaming)
        ? props.checklists
        : props.checklists.filter(
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
}
