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
import { cn } from '@/lib/utils'

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
        return (
            <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-fg)]"
                style={props.accentColor ? { color: props.accentColor } : undefined}
                data-testid={`${prefix}-spinner`}
            >
                <svg
                    className={cn('h-3.5 w-3.5', !props.suppressRunningShimmer && 'turn-step-spinner-svg')}
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                >
                    <circle
                        cx="8"
                        cy="8"
                        r="5.5"
                        stroke="currentColor"
                        strokeOpacity="0.22"
                        strokeWidth="1.6"
                    />
                    <path
                        d="M13.5 8a6.5 6.5 0 0 0 0 0M13.5 8a5.5 5.5 0 0 0-5.5-5.5"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        className="turn-step-spinner-head"
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
                <svg
                    className="h-2.5 w-2.5"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="M2.5 6.2 5 8.7 9.5 3.7" />
                </svg>
            </span>
        )
    }
    if (props.status === 'blocked') {
        return (
            <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]"
                data-testid={`${prefix}-blocked`}
            >
                <span
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current/55"
                    data-testid={prefix !== 'checklist-item' ? 'checklist-item-blocked' : undefined}
                    aria-hidden="true"
                >
                    <span className="flex items-center gap-[1.5px]">
                        <span className="h-1.5 w-[1.5px] rounded-full bg-current" />
                        <span className="h-1.5 w-[1.5px] rounded-full bg-current" />
                    </span>
                </span>
            </span>
        )
    }
    return (
        <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]"
            data-testid={`${prefix}-pending`}
        >
            <span
                className="h-3.5 w-3.5 rounded-full border border-dashed border-[var(--app-hint)]/65"
                aria-hidden="true"
            />
        </span>
    )
}

export function checklistItemTextClass(
    status: ChecklistStatus,
    suppressRunningShimmer?: boolean
): string {
    if (status === 'in_progress') {
        return suppressRunningShimmer
            ? 'font-medium text-[var(--app-fg)]'
            : 'turn-text-shimmer font-medium text-[var(--app-fg)]'
    }
    if (status === 'completed') {
        return 'text-[var(--app-hint)] line-through'
    }
    if (status === 'blocked') {
        return 'text-[var(--app-hint)]'
    }
    return 'text-[var(--app-fg)]'
}

export function ChecklistItemRow(props: {
    item: ChecklistItem
    testIdPrefix?: string
    rowTestId?: string
    accentColor?: string
    suppressRunningShimmer?: boolean
    indexLabel?: string
    useActiveForm?: boolean
    className?: string
}) {
    const { item } = props
    const rawText = props.useActiveForm && item.status === 'in_progress' && item.activeForm
        ? item.activeForm
        : item.text
    const text = rawText.trim().length > 0 ? rawText.trim() : '(empty)'
    return (
        <div
            className={cn('flex items-center gap-2.5 py-0.5 text-[13.5px] leading-5', props.className)}
            data-testid={props.rowTestId}
            data-todo-status={item.status}
        >
            <TodoStatusBadge
                status={item.status}
                accentColor={props.accentColor}
                suppressRunningShimmer={props.suppressRunningShimmer}
                testIdPrefix={props.testIdPrefix}
            />
            {props.indexLabel ? (
                <span className="shrink-0 tabular-nums text-[12px] text-[var(--app-hint)]">
                    {props.indexLabel}
                </span>
            ) : null}
            <span className={cn('min-w-0 flex-1 break-words', checklistItemTextClass(item.status, props.suppressRunningShimmer))}>
                {text}
            </span>
        </div>
    )
}

export function extractTodoChecklistFromSessionTodos(
    todos: readonly { id?: string; content: string; status: string; activeForm?: string }[] | null | undefined
): ChecklistItem[] {
    if (!todos || todos.length === 0) return []
    return [...projectSessionTodoSnapshot(todos as Parameters<typeof projectSessionTodoSnapshot>[0]).items]
}

export function ChecklistList(props: {
    items: readonly ChecklistItem[]
    emptyLabel?: string | null
    testIdPrefix?: string
    rowTestId?: string
    accentColor?: string
    suppressRunningShimmer?: boolean
    className?: string
}) {
    if (props.items.length === 0) {
        return props.emptyLabel ? (
            <div className="text-sm text-[var(--app-hint)]">{props.emptyLabel}</div>
        ) : null
    }

    return (
        <div className={cn('space-y-1', props.className)}>
            {props.items.map((item, idx) => (
                <ChecklistItemRow
                    key={item.id ?? `${idx}:${item.text}`}
                    item={item}
                    testIdPrefix={props.testIdPrefix}
                    rowTestId={props.rowTestId}
                    accentColor={props.accentColor}
                    suppressRunningShimmer={props.suppressRunningShimmer}
                />
            ))}
        </div>
    )
}
