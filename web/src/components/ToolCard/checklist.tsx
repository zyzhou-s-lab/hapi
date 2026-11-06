import type { ReactNode } from 'react'
import {
    collectOmpTodoTurnContext,
    extractTodoChecklist,
    extractUpdatePlanChecklist,
    projectSessionTodoSnapshot,
    projectToolTodoSnapshot,
    type CanonicalTodoItem,
    type CanonicalTodoSnapshot,
    type CanonicalTodoStatus,
    type OmpTodoTurnContext,
} from '@/chat/projections/todoProjection'

export type ChecklistStatus = CanonicalTodoStatus
export type ChecklistItem = CanonicalTodoItem
export type { OmpTodoTurnContext, CanonicalTodoSnapshot }
export {
    collectOmpTodoTurnContext,
    extractTodoChecklist,
    extractUpdatePlanChecklist,
    projectSessionTodoSnapshot,
    projectToolTodoSnapshot,
}

function checklistTone(item: ChecklistItem): string {
    if (item.status === 'completed') return 'text-emerald-600 line-through'
    if (item.status === 'in_progress') return 'text-[var(--app-link)]'
    if (item.status === 'blocked') return 'text-red-500'
    return 'text-[var(--app-hint)]'
}

function checklistIcon(item: ChecklistItem): ReactNode {
    if (item.status === 'completed') return '☑'
    if (item.status === 'in_progress') return '◉'
    if (item.status === 'blocked') return '⚠'
    return '☐'
}

export function ChecklistList(props: { items: readonly ChecklistItem[]; emptyLabel?: string | null }) {
    if (props.items.length === 0) {
        return props.emptyLabel ? (
            <div className="text-sm text-[var(--app-hint)]">{props.emptyLabel}</div>
        ) : null
    }

    return (
        <div className="flex flex-col gap-1">
            {props.items.map((item, idx) => {
                const text = item.text.trim().length > 0 ? item.text.trim() : '(empty)'
                return (
                    <div key={item.id ? item.id : String(idx)} className={`text-sm ${checklistTone(item)}`}>
                        {checklistIcon(item)} {text}
                    </div>
                )
            })}
        </div>
    )
}
