import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { createSessionEntityStore } from '@/chat/store/sessionEntityStore'
import { SessionEntityStoreProvider } from '@/hooks/useSessionEntityStore'
import type { DecryptedMessage } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ActivitySegmentRow } from './ActivitySegmentRow'
import { TimelineTurnBlockView } from './TimelineTurnBlock'
import { TurnStepExpansionContext, TurnStepExpansionStore } from './TimelineStepRows'
import { partitionTurn, type TurnContentPart } from './turnBlockModel'
import { projectTurn } from './turnProjection'

function tool(id: string, name: string, extra: Partial<ToolCallBlock['tool']> = {}): TurnContentPart {
    const block: ToolCallBlock = {
        kind: 'tool-call', id, localId: null, children: [], createdAt: 1000,
        tool: { id, name, state: 'completed', input: { path: `${id}.ts` }, createdAt: 1000, startedAt: 1000, completedAt: 2000, execStartedAt: null, execCompletedAt: null, description: null, ...extra },
    }
    return { type: 'tool-call', artifact: block, toolCallId: id, toolName: name }
}
function project(parts: TurnContentPart[]) { return projectTurn(partitionTurn(parts, null)).subturns[0]! }

describe('normal activity hierarchy', () => {
    it('never groups across commentary, reasoning, todo, compaction, or media', () => {
        const parts: TurnContentPart[] = [tool('read', 'Read'), tool('cmd', 'Bash', { input: { command: 'bun test' } }), { type: 'text', phase: 'execution', text: 'Review findings' }, tool('grep', 'Grep'), { type: 'reasoning', text: 'Check alternatives' }, tool('edit', 'Edit'), tool('todo', 'TodoWrite'), tool('next', 'Read'), tool('compact', 'ContextCompaction'), tool('last', 'Read')]
        const subturn = project(parts)
        expect(subturn.stepRows.map((row) => row.kind === 'activity' ? row.toolRows.map((tool) => tool.key) : row.kind)).toEqual([['read', 'cmd'], 'text', ['grep'], 'reasoning', ['edit'], 'tool', ['next'], 'tool', ['last']])
        const mediaPartition = partitionTurn([tool('a', 'Read'), tool('b', 'Read')], null)
        mediaPartition.rows.splice(1, 0, { kind: 'image', key: 'img', block: { id: 'img' } as never })
        expect(projectTurn(mediaPartition).subturns[0]!.stepRows.map((row) => row.kind === 'activity' ? row.toolRows.map((tool) => tool.key) : row.kind)).toEqual([['a'], ['b']])
    })

    it('keeps an open tool and its DOM/focus as the tail grows, completes, and fails', () => {
        const store = new TurnStepExpansionStore()
        const first = tool('read', 'Read', { result: 'Original file content' })
        const show = (parts: TurnContentPart[]) => {
            const row = project(parts).stepRows[0]!
            if (row.kind !== 'activity') throw new Error('Expected activity')
            return <I18nProvider><TurnStepExpansionContext.Provider value={store}><ActivitySegmentRow row={row} lang="en" /></TurnStepExpansionContext.Provider></I18nProvider>
        }
        const { rerender } = render(show([first]))
        const readButton = screen.getByRole('button', { name: /read.ts/ })
        fireEvent.click(readButton)
        act(() => readButton.focus())
        rerender(show([first, tool('search', 'Grep'), tool('command', 'Bash', { state: 'running', input: { command: 'bun test' } })]))
        expect(screen.getByText('Original file content')).toBeVisible()
        expect(document.activeElement).toBe(readButton)
        rerender(show([first, tool('search', 'Grep'), tool('command', 'Bash', { input: { command: 'bun test' } })]))
        expect(screen.getByRole('button', { name: /read.ts/ })).toBe(readButton)
        expect(readButton).toHaveAttribute('aria-expanded', 'true')
        expect(document.activeElement).toBe(readButton)
        rerender(show([first, tool('search', 'Grep'), tool('command', 'Bash', { state: 'error', input: { command: 'bun test' }, result: 'Tests failed' })]))
        expect(screen.getByRole('button', { name: /bun test/ })).toBeVisible()
        expect(readButton).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByTestId('activity-segment-summary')).toBeNull()
    })

    it('summarizes mixed successes without hiding running, unknown names, or details behind old groups', () => {
        const row = project([tool('read', 'Read'), tool('custom', 'custom_inspector'), tool('bash', 'Bash', { state: 'running', input: { command: 'bun test' } })]).stepRows[0]!
        if (row.kind !== 'activity') throw new Error('Expected activity')
        render(<I18nProvider><ActivitySegmentRow row={row} lang="en" /></I18nProvider>)
        const summary = screen.getByTestId('activity-segment-summary')
        expect(summary).toHaveTextContent('custom_inspector × 1')
        expect(screen.getByRole('button', { name: /bun test/ })).toBeVisible()
        fireEvent.click(summary)
        expect(screen.getByRole('button', { name: /read.ts/ })).toBeVisible()
        expect(screen.getByRole('button', { name: 'custom_inspector' })).toBeVisible()
        expect(document.querySelector('[data-testid^="coalesced-step-"]')).toBeNull()
    })

    it('retains explicit tool expansion across normal/verbose and whole-rail remounts', () => {
        const partition = partitionTurn([tool('cmd', 'Bash'), tool('read', 'Read', { result: 'Original file content' }), tool('grep', 'Grep')], null)
        const show = (mode: 'normal' | 'verbose') => <StrictMode><I18nProvider><TimelineTurnBlockView partition={partition} streaming={false} durationMs={1000} initiallyOpen={true} viewMode={mode} /></I18nProvider></StrictMode>
        const { rerender } = render(show('normal'))
        fireEvent.click(screen.getByTestId('activity-segment-summary'))
        fireEvent.click(screen.getByRole('button', { name: /read.ts/ }))
        rerender(show('verbose'))
        rerender(show('normal'))
        expect(screen.getByRole('button', { name: /read.ts/ })).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(screen.getByTestId('turn-level0-header'))
        fireEvent.click(screen.getByTestId('turn-level0-header'))
        expect(screen.getByRole('button', { name: /read.ts/ })).toHaveAttribute('aria-expanded', 'true')
    })

    it.each([2, 3])('reveals an entity-only error without expanding safe siblings (%i initial successes)', (count) => {
        const store = createSessionEntityStore()
        const message = (id: string, seq: number, content: DecryptedMessage['content']): DecryptedMessage => ({ id, seq, localId: null, createdAt: 1000 + seq, content })
        const messages = (failed: boolean): DecryptedMessage[] => [
            message('user', 1, { role: 'user', content: { type: 'text', text: 'Inspect files' } }),
            message('calls', 2, { role: 'agent', content: { type: 'output', data: {
                type: 'assistant', uuid: 'calls', message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'read.ts' } },
                    { type: 'tool_use', id: 'grep', name: 'Grep', input: { pattern: 'target', path: '.' } },
                    ...(count === 3 ? [{ type: 'tool_use', id: 'other', name: 'Read', input: { file_path: 'other.ts' } }] : []),
                ] },
            } } }),
            message('results', 3, { role: 'agent', content: { type: 'output', data: {
                type: 'user', uuid: 'results', message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'read', content: 'File content', is_error: false },
                    { type: 'tool_result', tool_use_id: 'grep', content: failed ? 'Search failed' : 'Found target', is_error: failed },
                    ...(count === 3 ? [{ type: 'tool_result', tool_use_id: 'other', content: 'Other file content', is_error: false }] : []),
                ] },
            } } }),
        ]
        const reconcile = (failed: boolean) => store.reconcileInput({ sessionId: 'activity-live', messages: messages(failed), agentState: null, hasMoreMessages: false })
        const snapshot = reconcile(false)
        const turnId = snapshot.timelineIndex.find((entry) => entry.role === 'assistant')!.id
        const partition = partitionTurn(store.getLiveTurnParts(turnId)!, null)
        render(<I18nProvider><SessionEntityStoreProvider store={store}><TimelineTurnBlockView partition={partition} streaming={true} durationMs={1000} initiallyOpen={true} /></SessionEntityStoreProvider></I18nProvider>)
        expect(screen.getByTestId('activity-segment-summary')).toHaveAttribute('aria-expanded', 'false')
        expect(within(screen.getByTestId('activity-segment')).queryByRole('button', { name: /target/ })).toBeNull()
        act(() => { reconcile(true); store.flushNotifications() })
        if (count === 3) {
            expect(screen.getByTestId('activity-segment-summary')).toHaveAttribute('aria-expanded', 'false')
            expect(within(screen.getByTestId('activity-segment')).queryByRole('button', { name: /read.ts|other.ts/ })).toBeNull()
        } else {
            expect(screen.queryByTestId('activity-segment-summary')).toBeNull()
            expect(within(screen.getByTestId('activity-segment')).getByRole('button', { name: /read.ts/ })).toBeVisible()
        }
        const failedTool = within(screen.getByTestId('activity-segment')).getByRole('button', { name: /target/ })
        expect(failedTool).toBeVisible()
        fireEvent.click(failedTool)
        expect(screen.getByText('Search failed', { selector: 'div' })).toBeVisible()
    })
})
