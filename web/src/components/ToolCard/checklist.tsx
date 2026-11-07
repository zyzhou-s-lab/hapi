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

export type TodoCardItem = CanonicalTodoItem

export function TodoStatusBadge(props: {
    status: ChecklistStatus
    accentColor?: string
    suppressRunningShimmer?: boolean
    testIdPrefix?: string
}) {
    const prefix = props.testIdPrefix ?? 'checklist-item'
    if (props.status === 'in_progress') {
        const spinClass = props.suppressRunningShimmer ? 'h-4 w-4' : 'h-4 w-4 animate-spin'
        return (
            <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-fg)]"
                style={props.accentColor ? { color: props.accentColor } : undefined}
                data-testid={`${prefix}-spinner`}
            >
                <svg className={spinClass} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle
                        cx="8"
                        cy="8"
                        r="6.25"
                        stroke="currentColor"
                        strokeOpacity="0.2"
                        strokeWidth="1.6"
                    />
                    <path
                        d="M14.25 8a6.25 6.25 0 0 0-6.25-6.25"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                    />
                </svg>
            </span>
        )
    }
    if (props.status === 'completed') {
        return (
            <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)]"
                style={props.accentColor ? { backgroundColor: props.accentColor, color: '#ffffff' } : undefined}
                data-testid={`${prefix}-check`}
            >
                <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                        d="M2.4 6.2L4.9 8.6L9.6 3.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </span>
        )
    }
    if (props.status === 'blocked') {
        return (
            <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--app-hint)]/40 bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                data-testid={`${prefix}-blocked`}
            >
                <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                        d="M4.25 3.25V8.75M7.75 3.25V8.75"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                    />
                </svg>
            </span>
        )
    }
    return (
        <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
            data-testid={`${prefix}-pending`}
        >
            <span className="h-3.5 w-3.5 rounded-full border border-[var(--app-hint)]/45" />
        </span>
    )
}

function checklistTone(item: ChecklistItem): string {
    if (item.status === 'completed') return 'text-[var(--app-fg)]/85 line-through'
    if (item.status === 'in_progress') return 'text-[var(--app-link)] font-medium'
    if (item.status === 'blocked') return 'text-[var(--app-hint)]'
    return 'text-[var(--app-hint)]'
}

export function extractTodoChecklistFromSessionTodos(
    todos: readonly { id?: string; content: string; status: string; activeForm?: string }[] | null | undefined
): ChecklistItem[] {
    if (!todos || todos.length === 0) return []
    return [...projectSessionTodoSnapshot(todos as Parameters<typeof projectSessionTodoSnapshot>[0]).items]
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
                    <div
                        key={item.id ? item.id : String(idx)}
                        className={`flex items-center gap-2 text-sm ${checklistTone(item)}`}
                        data-todo-status={item.status}
                    >
                        <TodoStatusBadge status={item.status} testIdPrefix="checklist-item" />
                        {text}
                    </div>
                )
            })}
        </div>
    )
}
