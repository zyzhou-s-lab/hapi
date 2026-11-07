import { useState } from 'react'
import type { ProjectedTodoChecklist } from '@/components/AssistantChat/messages/turnBlockModel'
import { TodoStatusBadge, type ChecklistItem } from '@/components/ToolCard/checklist'
import { cn } from '@/lib/utils'

export function TimelineTodoChecklistCard(props: {
    items: readonly ChecklistItem[]
    accentColor?: string
    suppressRunningShimmer?: boolean
    defaultOpen?: boolean
}) {
    const [open, setOpen] = useState(props.defaultOpen ?? true)
    if (props.items.length === 0) return null

    const completedCount = props.items.filter((item) => item.status === 'completed').length
    const totalCount = props.items.length

    return (
        <div
            data-hapi-share-exclude="true"
            data-testid="turn-todo-checklist-card"
            className="my-2 overflow-hidden rounded-xl border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/55 shadow-2xs"
        >
            <button
                type="button"
                aria-expanded={open}
                data-testid="turn-todo-progress-header"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 border-b border-[var(--app-border)]/45 px-3.5 py-2 text-left text-[12px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/80 hover:text-[var(--app-fg)]"
            >
                <span className="font-medium text-[var(--app-fg)]/85">Tasks</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] tabular-nums text-[var(--app-hint)]">
                    <span data-testid="turn-todo-progress-count">{completedCount}/{totalCount}</span>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={cn('shrink-0 transition-transform duration-150', open ? 'rotate-90' : 'rotate-0')}
                        aria-hidden="true"
                    >
                        <polyline points="9 18 15 12 9 6" />
                    </svg>
                </span>
            </button>
            {open ? (
                <ul className="divide-y divide-[var(--app-border)]/35 px-3.5 py-2">
                    {props.items.map((item, idx) => {
                        const isCompleted = item.status === 'completed'
                        const isInProgress = item.status === 'in_progress'
                        const isBlocked = item.status === 'blocked'
                        return (
                            <li
                                key={`${idx}-${item.text}`}
                                className="flex items-start gap-2.5 py-1.5 text-[13.5px] leading-5"
                            >
                                <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center">
                                    <TodoStatusBadge
                                        status={item.status}
                                        accentColor={props.accentColor}
                                        suppressRunningShimmer={props.suppressRunningShimmer}
                                        testIdPrefix="turn-todo-item"
                                    />
                                </span>
                                <span
                                    className={cn(
                                        'min-w-0 flex-1 break-words transition-colors duration-200',
                                        isCompleted && 'text-[var(--app-hint)] line-through decoration-[var(--app-hint)]/60',
                                        isInProgress && !props.suppressRunningShimmer && 'font-medium text-[var(--app-fg)]',
                                        isInProgress && props.suppressRunningShimmer && 'text-[var(--app-hint)] opacity-65',
                                        isBlocked && 'text-[var(--app-hint)]',
                                        !isCompleted && !isInProgress && !isBlocked && 'text-[var(--app-fg)]/90'
                                    )}
                                >
                                    {item.text}
                                </span>
                            </li>
                        )
                    })}
                </ul>
            ) : null}
        </div>
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
