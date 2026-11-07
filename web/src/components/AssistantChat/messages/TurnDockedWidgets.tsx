import { useState } from 'react'
import { projectSessionTodoSnapshot } from '@/chat/projections/todoProjection'
import { ChecklistItemRow } from '@/components/ToolCard/checklist'
import { Card, SmallChevron } from '@/components/ui/card'
import { cn } from '@/lib/utils'
export type DockedTodoItem = {
    id: string
    content: string
    activeForm?: string
    status: 'pending' | 'in_progress' | 'completed'
}

export type DockedQuestionItem = {
    id: string
    question: string
    options: Array<{ label: string; description?: string }>
}

export function DockedTodoProgressBar(props: {
    todos: DockedTodoItem[]
    defaultExpanded?: boolean
    lang?: 'en' | 'zh-CN'
}) {
    const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
    const lang = props.lang ?? 'en'
    const snapshot = projectSessionTodoSnapshot(props.todos)
    if (snapshot.totalCount === 0) return null

    const total = snapshot.totalCount
    const completedCount = snapshot.completedCount
    const activeIndex = snapshot.items.findIndex((item) => item.status === 'in_progress')
    const allDone = completedCount === total

    const progressCounter = allDone
        ? (lang === 'zh-CN' ? `${total} / ${total}` : `${total} of ${total}`)
        : activeIndex >= 0
            ? (lang === 'zh-CN' ? `${activeIndex + 1} / ${total}` : `${activeIndex + 1} of ${total}`)
            : (lang === 'zh-CN' ? `${completedCount} / ${total}` : `${completedCount} of ${total}`)

    const summaryLabel = allDone
        ? (lang === 'zh-CN' ? '已完成' : 'Done')
        : (snapshot.activeLabel || snapshot.items[0]?.text || '')

    return (
        <Card
            variant="dock"
            className="overflow-hidden rounded-t-xl rounded-b-none border border-b-0 border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70"
            data-testid="docked-todo-bar"
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--app-subtle-bg)]"
            >
                <span className="shrink-0 tabular-nums text-[12px] font-medium text-[var(--app-hint)]">
                    {progressCounter}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium text-[var(--app-fg)]">
                    {allDone ? (
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                            ✓
                        </span>
                    ) : null}
                    <span className="truncate">{summaryLabel}</span>
                </span>
                <SmallChevron open={expanded} direction="up" className="text-[var(--app-hint)]" />
            </button>

            <div
                className="turn-collapsible-shell"
                data-open={expanded ? 'true' : 'false'}
                aria-hidden={!expanded}
            >
                <div className="turn-collapsible-body">
                    <div className="border-t border-[var(--app-border)]/70 px-3.5 py-2.5 space-y-1.5">
                        {snapshot.items.map((item, idx) => (
                            <ChecklistItemRow
                                key={item.id ?? `${idx}:${item.text}`}
                                item={item}
                                indexLabel={`${idx + 1}.`}
                                useActiveForm={true}
                                className="text-[13px]"
                            />
                        ))}
                    </div>
                </div>
            </div>
        </Card>
    )
}

export function DockedQuestionWizard(props: {
    questions: DockedQuestionItem[]
    onSubmit: (answers: Record<string, string>) => void
    onSkip?: () => void
}) {
    const [stepIndex, setStepIndex] = useState(0)
    const [answers, setAnswers] = useState<Record<string, string>>({})
    const [customText, setCustomText] = useState('')
    const [editingCustom, setEditingCustom] = useState(false)

    const total = props.questions.length
    const current = props.questions[stepIndex]
    if (!current) return null

    const selectOption = (value: string) => {
        const nextAnswers = { ...answers, [current.id]: value }
        setAnswers(nextAnswers)
        setEditingCustom(false)
        setCustomText('')
        if (stepIndex < total - 1) {
            setStepIndex(stepIndex + 1)
        } else {
            props.onSubmit(nextAnswers)
        }
    }

    return (
        <div
            className="composer-dock-card overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5 shadow-sm"
            data-testid="docked-question-wizard"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="text-[14px] font-medium leading-5 text-[var(--app-fg)]">
                    {current.question}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-[var(--app-hint)]">
                    <button
                        type="button"
                        disabled={stepIndex === 0}
                        onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                        className="rounded p-1 hover:bg-[var(--app-subtle-bg)] disabled:opacity-30"
                        aria-label="Previous question"
                    >
                        ‹
                    </button>
                    <span>
                        {stepIndex + 1} of {total}
                    </span>
                    <button
                        type="button"
                        disabled={stepIndex >= total - 1}
                        onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}
                        className="rounded p-1 hover:bg-[var(--app-subtle-bg)] disabled:opacity-30"
                        aria-label="Next question"
                    >
                        ›
                    </button>
                </div>
            </div>

            <div className="mt-2.5 space-y-1.5">
                {current.options.map((opt, idx) => {
                    const selected = answers[current.id] === opt.label
                    return (
                        <button
                            key={opt.label}
                            type="button"
                            data-testid={`question-option-${idx + 1}`}
                            onClick={() => selectOption(opt.label)}
                            className={cn(
                                'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors',
                                selected
                                    ? 'border-[#da7756] bg-[#da7756]/10 text-[var(--app-fg)]'
                                    : 'border-[var(--app-border)]/70 bg-[var(--app-subtle-bg)]/40 text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                            )}
                        >
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">{opt.label}</div>
                                {opt.description ? (
                                    <div className="text-[11.5px] text-[var(--app-hint)]">{opt.description}</div>
                                ) : null}
                            </div>
                        </button>
                    )
                })}

                <div className="flex items-center gap-2">
                    {editingCustom ? (
                        <form
                            className="flex flex-1 items-center gap-2"
                            onSubmit={(e) => {
                                e.preventDefault()
                                if (customText.trim()) selectOption(customText.trim())
                            }}
                        >
                            <input
                                type="text"
                                value={customText}
                                onChange={(e) => setCustomText(e.target.value)}
                                placeholder="Type something else..."
                                className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 px-3 py-1.5 text-[13px] text-[var(--app-fg)] outline-none focus:border-[#da7756]"
                                autoFocus
                            />
                            <button
                                type="submit"
                                className="rounded-lg bg-[#da7756] px-3 py-1.5 text-[12px] font-medium text-white"
                            >
                                Submit
                            </button>
                        </form>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setEditingCustom(true)}
                            className="flex flex-1 items-center gap-2.5 rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2 text-left text-[13px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
                        >
                            <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center text-xs">
                                ✎
                            </span>
                            <span>Something else</span>
                        </button>
                    )}

                    {props.onSkip ? (
                        <button
                            type="button"
                            onClick={props.onSkip}
                            className="shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-2 text-[12.5px] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            Skip
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

export function SubmittedQuestionSummaryBubble(props: {
    questions: DockedQuestionItem[]
    answers: Record<string, string>
}) {
    return (
        <div className="my-3 flex justify-end" data-testid="submitted-qa-bubble">
            <div className="max-w-lg space-y-2.5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-[13.5px]">
                {props.questions.map((q) => (
                    <div key={q.id} className="space-y-0.5">
                        <div className="text-[12px] text-[var(--app-hint)]">{q.question}</div>
                        <div className="font-medium text-[var(--app-fg)]">
                            {props.answers[q.id] ?? 'Skipped'}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
