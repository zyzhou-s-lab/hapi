import { useMemo, useState } from 'react'
import type { TodoItem } from '@hapi/protocol/types'
import { ChecklistList, extractTodoChecklist } from '@/components/ToolCard/checklist'
import { useTranslation } from '@/lib/use-translation'

const COLLAPSED_STORAGE_KEY = 'hapi.todo-panel.collapsed'

function ChevronIcon(props: { open: boolean }) {
    return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform duration-200 ${props.open ? 'rotate-90' : ''}`}>
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

export function TodoPanel(props: { sessionId: string; todos: TodoItem[] | undefined }) {
    const { t } = useTranslation()
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1')
    const items = useMemo(() => extractTodoChecklist({ todos: props.todos }, null), [props.todos])
    const completed = items.filter((item) => item.status === 'completed').length
    const inProgress = items.find((item) => item.status === 'in_progress') ?? null
    const allDone = items.length > 0 && completed === items.length
    if (items.length === 0) return null

    const toggleCollapsed = () => {
        const next = !collapsed
        localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0')
        setCollapsed(next)
    }

    return (
        <div className="mx-auto mb-1 w-full max-w-content">
            <div className="composer-dock-card rounded-lg" data-testid="todo-panel">
                <button type="button" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls={`todo-panel-body-${props.sessionId}`} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-[var(--app-fg)] hover:opacity-90">
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">{completed}/{items.length}</span>
                    <span className="sr-only">{t('todoPanel.title')}</span>
                    {allDone ? (
                        <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <span aria-hidden="true">✓</span>
                            <span>Done</span>
                        </span>
                    ) : inProgress ? (
                        <span className="min-w-0 flex-1 truncate font-normal text-[var(--app-fg)]">{inProgress.text}</span>
                    ) : (
                        <span className="min-w-0 flex-1 truncate text-[var(--app-hint)]">{t('todoPanel.title')}</span>
                    )}
                    <ChevronIcon open={!collapsed} />
                </button>
                <div id={`todo-panel-body-${props.sessionId}`} className="collapsible-panel" aria-hidden={collapsed} {...(!collapsed ? { 'data-open': '' } : {})}>
                    <div className="collapsible-inner" inert={collapsed}>
                        <div className="max-h-44 overflow-y-auto px-3 pb-2"><ChecklistList items={items} /></div>
                    </div>
                </div>
            </div>
        </div>
    )
}
