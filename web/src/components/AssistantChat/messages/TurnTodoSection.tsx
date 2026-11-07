import type { ProjectedTodoChecklist } from '@/components/AssistantChat/messages/turnBlockModel'
import type { ChecklistItem } from '@/components/ToolCard/checklist'
import { cn } from '@/lib/utils'

export function TimelineTodoChecklistCard(props: {
    items: readonly ChecklistItem[]
    className?: string
    accentColor?: string
    suppressRunningShimmer?: boolean
}) {
    if (props.items.length === 0) return null

    return (
        <div
            data-hapi-share-exclude="true"
            data-testid="turn-todo-checklist-card"
            className={cn(
                'rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3.5 py-2.5 shadow-2xs',
                props.className
            )}
        >
            <div className="space-y-1">
                {props.items.map((item, index) => {
                    const isRunning = item.status === 'in_progress'
                    const isCompleted = item.status === 'completed'
                    const isBlocked = item.status === 'blocked'
                    return (
                        <div
                            key={item.id ?? `${index}:${item.text}`}
                            className="flex items-center gap-2.5 py-0.5 text-[13.5px] leading-5"
                            data-testid="turn-todo-card-item"
                            data-todo-status={item.status}
                        >
                            {isRunning ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-fg)]"
                                    data-testid="turn-todo-item-spinner"
                                >
                                    <svg
                                        className="h-3.5 w-3.5 turn-step-spinner-svg"
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
                                            d="M13.5 8a5.5 5.5 0 0 0-5.5-5.5"
                                            stroke="currentColor"
                                            strokeWidth="1.6"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                </span>
                            ) : isCompleted ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)]"
                                    data-testid="turn-todo-item-check"
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
                            ) : isBlocked ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]"
                                    data-testid="turn-todo-item-blocked"
                                >
                                    <span
                                        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current/55"
                                        aria-hidden="true"
                                    >
                                        <span className="flex items-center gap-[1.5px]">
                                            <span className="h-1.5 w-[1.5px] rounded-full bg-current" />
                                            <span className="h-1.5 w-[1.5px] rounded-full bg-current" />
                                        </span>
                                    </span>
                                </span>
                            ) : (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]"
                                    data-testid="turn-todo-item-pending"
                                >
                                    <span
                                        className="h-3.5 w-3.5 rounded-full border border-current/55"
                                        aria-hidden="true"
                                    />
                                </span>
                            )}
                            <span
                                className={cn(
                                    'min-w-0 flex-1 break-words',
                                    isRunning && !props.suppressRunningShimmer
                                        ? 'turn-text-shimmer font-medium text-[var(--app-fg)]'
                                        : isRunning
                                            ? 'font-medium text-[var(--app-fg)]'
                                            : isCompleted || isBlocked
                                                ? 'text-[var(--app-hint)]'
                                                : 'text-[var(--app-fg)]'
                                )}
                            >
                                {item.text}
                            </span>
                        </div>
                    )
                })}
            </div>
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
