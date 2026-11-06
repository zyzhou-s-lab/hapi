import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { TodoItem } from '@hapi/protocol/types'
import { TodoPanel } from './TodoPanel'

function renderPanel(todos: TodoItem[]) {
    return render(
        <I18nProvider>
            <TodoPanel sessionId="session-117" todos={todos} />
        </I18nProvider>
    )
}

beforeEach(() => localStorage.clear())

describe('TodoPanel', () => {
    it('does not render without tasks', () => {
        renderPanel([])
        expect(screen.queryByTestId('todo-panel')).toBeNull()
    })

    it('renders supplied task contents and completed progress', () => {
        renderPanel([
            { id: '1', content: '分析来源', status: 'completed', priority: 'medium' },
            { id: '2', content: '重新实现', status: 'in_progress', priority: 'medium' }
        ])
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('分析来源')
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('重新实现')
        expect(screen.getByText('1/2')).toBeInTheDocument()
    })

    it('persists collapse state, unmounts the checklist body while collapsed, and exposes the active task in the header', () => {
        const todos: TodoItem[] = [
            { id: '1', content: '已完成任务', status: 'completed', priority: 'medium' },
            { id: '2', content: '运行 smoke', status: 'in_progress', priority: 'medium' }
        ]
        const first = renderPanel(todos)
        expect(document.getElementById('todo-panel-body-session-117')).not.toBeNull()
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('已完成任务')
        const toggle = screen.getByRole('button', { name: /Tasks/ })
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(toggle).toHaveTextContent('运行 smoke')
        expect(document.getElementById('todo-panel-body-session-117')).toBeNull()
        expect(screen.getByTestId('todo-panel')).not.toHaveTextContent('已完成任务')
        first.unmount()

        renderPanel(todos)
        expect(screen.getByRole('button', { name: /Tasks/ })).toHaveAttribute('aria-expanded', 'false')
        expect(document.getElementById('todo-panel-body-session-117')).toBeNull()
    })

    it('clears and restores task content when the supplied projection changes', () => {
        const firstSession: TodoItem[] = [
            { id: '1', content: '仅属于 session A', status: 'in_progress', priority: 'medium' }
        ]
        const view = renderPanel(firstSession)
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('仅属于 session A')

        view.rerender(
            <I18nProvider>
                <TodoPanel sessionId="session-B" todos={[]} />
            </I18nProvider>
        )
        expect(screen.queryByTestId('todo-panel')).toBeNull()

        view.rerender(
            <I18nProvider>
                <TodoPanel sessionId="session-A" todos={firstSession} />
            </I18nProvider>
        )
        expect(screen.getAllByTestId('todo-panel')).toHaveLength(1)
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('仅属于 session A')
    })

    it('auto-collapses and shows previous tasks completed when sessionThinking starts after all tasks finish', () => {
        const completedTodos: TodoItem[] = [
            { id: '1', content: '定位问题', status: 'completed', priority: 'medium' },
            { id: '2', content: '提交修复', status: 'completed', priority: 'medium' }
        ]
        const view = render(
            <I18nProvider>
                <TodoPanel sessionId="session-117" todos={completedTodos} sessionThinking={false} />
            </I18nProvider>
        )
        const toggle = screen.getByRole('button', { name: /Tasks/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByTestId('todo-panel-stale-done')).toBeNull()

        view.rerender(
            <I18nProvider>
                <TodoPanel sessionId="session-117" todos={completedTodos} sessionThinking={true} />
            </I18nProvider>
        )
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByTestId('todo-panel-stale-done')).toHaveTextContent('Previous tasks completed')
    })

    it('anchors the expandable card above a fixed-height collapsed slot so toggling does not shift the background session', () => {
        renderPanel([
            { id: '1', content: '固定底部高度', status: 'in_progress', priority: 'medium' }
        ])
        const card = screen.getByTestId('todo-panel')
        expect(card.className).toContain('absolute')
        expect(card.className).toContain('bottom-0')
        expect(card.parentElement?.className).toContain('relative')
        expect(card.parentElement?.className).toContain('h-[calc(1.75rem+2px)]')
    })

    it('hides when all unfinished tasks are blocked and reappears when a task becomes active', () => {
        const blockedTodos: TodoItem[] = [
            { id: '1', content: 'Add multi-port dev isolation section to V3.1 spec', status: 'pending', priority: 'medium', blocked: true },
            { id: '2', content: 'Execute V3.1 rearchitecture PRs after user approval', status: 'pending', priority: 'medium', blocked: true }
        ]
        const view = renderPanel(blockedTodos)
        expect(screen.queryByTestId('todo-panel')).toBeNull()

        view.rerender(
            <I18nProvider>
                <TodoPanel
                    sessionId="session-117"
                    todos={[
                        { id: '1', content: 'Add multi-port dev isolation section to V3.1 spec', status: 'in_progress', priority: 'medium' },
                        { id: '2', content: 'Execute V3.1 rearchitecture PRs after user approval', status: 'pending', priority: 'medium', blocked: true }
                    ]}
                />
            </I18nProvider>
        )
        expect(screen.getByTestId('todo-panel')).toHaveTextContent('Add multi-port dev isolation section to V3.1 spec')
    })
})
