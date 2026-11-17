import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { TurnToolRow } from './turnBlockModel'
import { TurnStepExpansionContext, TurnStepExpansionStore } from './TimelineStepRows'
import { projectSubagentActivities, type SubagentActivity } from './subagentActivity'
import { SubagentActivityRow } from './SubagentActivityRow'

function activity(): SubagentActivity {
    const row: TurnToolRow = {
        kind: 'tool', key: 'omp-subagent:alpha', verb: 'Agent', intent: '', pinned: false, error: false, permission: false,
        block: {
            kind: 'tool-call', id: 'omp-subagent:alpha', localId: null, createdAt: 1000, children: [],
            tool: {
                id: 'omp-subagent:alpha', name: 'CodexAgent', state: 'completed',
                input: { agentId: 'alpha', agent: 'Repository reader', agentStatus: 'completed', summary: 'Read README', message: 'Original task assignment' },
                result: 'README verified', description: null, createdAt: 1000,
                startedAt: 1000, completedAt: 2500, execStartedAt: null, execCompletedAt: null,
            },
        },
    }
    return projectSubagentActivities([row]).activityByAnchorKey.get(row.key)![0]!
}

describe('SubagentActivityRow', () => {
    it('shows identity, lifecycle and result before expanding the original task preview', () => {
        render(<I18nProvider><SubagentActivityRow activity={activity()} lang="en" /></I18nProvider>)
        expect(screen.getByText('Repository reader')).toBeVisible()
        expect(screen.queryByText('Read README')).toBeNull()
        expect(screen.getByText('alpha')).toBeTruthy()
        expect(screen.getByText('Completed')).toBeTruthy()
        expect(screen.getByText('README verified')).toBeTruthy()
        expect(screen.getByText('1.5s')).toBeTruthy()
        expect(screen.queryByText('Original task assignment')).toBeNull()
        const disclosure = screen.getByRole('button', { expanded: false })
        fireEvent.click(disclosure)
        expect(screen.getByText('Original task assignment')).toBeTruthy()
        expect(disclosure.getAttribute('aria-expanded')).toBe('true')
        fireEvent.click(disclosure)
        expect(screen.queryByText('Original task assignment')).toBeNull()
    })

    it('retains the task disclosure through live status changes and rail remounts', () => {
        const store = new TurnStepExpansionStore()
        const pending = { ...activity(), status: 'running' as const, completedAt: null, resultExcerpt: null }
        const view = (task: SubagentActivity) => (
            <I18nProvider>
                <TurnStepExpansionContext.Provider value={store}>
                    <SubagentActivityRow activity={task} lang="en" />
                </TurnStepExpansionContext.Provider>
            </I18nProvider>
        )
        const first = render(view(pending))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        first.rerender(view(activity()))
        expect(screen.getByText('Original task assignment')).toBeTruthy()
        expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
        first.unmount()
        render(view(activity()))
        expect(screen.getByText('Original task assignment')).toBeTruthy()
        expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    })

    it('does not claim success or show dispatch duration when task status is unknown', () => {
        render(<I18nProvider><SubagentActivityRow activity={{
            ...activity(), status: 'unknown', startedAt: null, completedAt: null, resultExcerpt: null,
        }} lang="zh-CN" /></I18nProvider>)
        expect(screen.getByText('状态未知')).toBeTruthy()
        expect(screen.queryByText('已完成')).toBeNull()
        expect(screen.queryByText('1.5s')).toBeNull()
    })
})
