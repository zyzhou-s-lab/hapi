import { describe, expect, it } from 'vitest'
import type { NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { reduceChatBlocks } from '@/chat/reducer'
import { partitionTurn, type TurnToolRow } from './turnBlockModel'
import { projectSubagentActivities } from './subagentActivity'

function row(id: string, name: string, input: unknown = {}, extra: Partial<ToolCallBlock['tool']> = {}): TurnToolRow {
    return {
        kind: 'tool', key: id, verb: name, intent: '', pinned: false, error: false, permission: false,
        block: {
            kind: 'tool-call', id, localId: null, createdAt: 1000, children: [],
            tool: {
                id, name, input, state: 'completed', createdAt: 1000,
                startedAt: 1000, completedAt: 1200, execStartedAt: null, execCompletedAt: null,
                description: null, ...extra,
            },
        },
    }
}

function native(id: string, taskId: string, agentStatus: string, parentToolCallId?: string, result?: unknown) {
    return row(id, 'CodexAgent', { agentId: taskId, agentStatus, parentToolCallId, summary: 'Inspect repository' }, { result })
}

describe('projectSubagentActivities', () => {
    it('keeps same-name parallel tasks distinct at one dispatch and folds later ID updates', () => {
        const dispatch = row('dispatch', 'fork_task')
        const first = native('start-a', 'a', 'running', 'dispatch')
        const second = native('start-b', 'b', 'running', 'dispatch')
        const done = native('done-a', 'a', 'completed', 'dispatch', 'README checked')
        const projection = projectSubagentActivities([dispatch, first, second, done])
        expect(projection.activityByAnchorKey.get('dispatch')).toMatchObject([
            { key: 'subagent:a', taskId: 'a', status: 'completed', resultExcerpt: 'README checked' },
            { key: 'subagent:b', taskId: 'b', status: 'running', completedAt: null },
        ])
        expect(projection.activityByAnchorKey.get('dispatch')?.[0]?.tools).toEqual([dispatch, first, done])
        expect([...projection.consumedToolKeys]).toEqual(['dispatch', 'start-a', 'start-b', 'done-a'])
    })

    it('does not promote a dispatch receipt or invocation cutoff to task completion', () => {
        const spawn = row('spawn', 'spawn_agent', {}, { result: { agent_id: 'a', nickname: 'Reader' } })
        const running = native('agent-a', 'a', 'running')
        running.block.tool.completionSource = 'invocation-cutoff'
        const projection = projectSubagentActivities([spawn, running])
        expect(projection.activityByAnchorKey.get('spawn')?.[0]).toMatchObject({
            status: 'running', completedAt: null, resultExcerpt: null,
        })
        expect(projectSubagentActivities([spawn]).activityByAnchorKey.get('spawn')?.[0]).toMatchObject({
            status: 'unknown', startedAt: null, completedAt: null, resultExcerpt: null,
        })
    })

    it('leaves tools without task identities and unrelated tool IDs unconsumed', () => {
        const rows = [
            row('task', 'Task', { description: 'Looks like a task' }, { result: 'Completed' }),
            row('orphan', 'CodexAgent', { summary: 'No agent ID', agentStatus: 'completed' }),
            row('read', 'Read', { id: 'not-a-task', path: 'README.md' }),
            row('wait', 'wait_agent', {}, { result: { status: { mystery: 'arbitrary output, not a lifecycle status' } } }),
        ]
        expect(projectSubagentActivities(rows).activityByAnchorKey.size).toBe(0)
        expect(projectSubagentActivities(rows).consumedToolKeys.size).toBe(0)
    })

    it.each(['failed', 'canceled'] as const)('preserves explicit %s outcome and its real result', (agentStatus) => {
        const agent = native('agent-a', 'a', agentStatus, undefined, { content: [{ type: 'text', text: 'Provider stopped the task' }] })
        expect(projectSubagentActivities([agent]).activityByAnchorKey.get('agent-a')?.[0]).toMatchObject({
            status: agentStatus, startedAt: 1000, completedAt: 1200, resultExcerpt: 'Provider stopped the task',
        })
    })

    it('folds waits and notifications without deriving task timing from the wait tool', () => {
        const spawn = row('spawn', 'spawn_agent', {}, { result: { agent_id: 'a' } })
        const wait = row('wait', 'wait_agent', { targets: ['a'] }, { result: { status: { a: { completed: 'Finished reading' } } } })
        const notify = row('notify', 'send_input', { id: 'a', message: 'Thanks' })
        const projection = projectSubagentActivities([spawn, wait, notify])
        expect(projection.activityByAnchorKey.get('spawn')?.[0]).toMatchObject({
            status: 'completed', startedAt: null, completedAt: null, resultExcerpt: 'Finished reading', tools: [spawn, wait, notify],
        })
        expect(projection.activityByAnchorKey.size).toBe(1)
    })

    it('does not let an old wait receipt overwrite the folded native terminal event', () => {
        const done = native('agent-a', 'a', 'failed', undefined, 'Final provider failure')
        const wait = row('wait', 'wait_agent', { targets: ['a'] }, { result: { status: { a: { completed: 'Old result' } } } })
        expect(projectSubagentActivities([done, wait]).activityByAnchorKey.get('agent-a')?.[0]).toMatchObject({
            status: 'failed', resultExcerpt: 'Final provider failure', completedAt: 1200,
        })
    })

    it('keeps actionable errors and permissions outside task details', () => {
        const dispatch = { ...row('dispatch', 'Task'), error: true }
        const agent = native('agent-a', 'a', 'running', 'dispatch')
        const notify = { ...row('notify', 'send_input', { id: 'a' }), permission: true }
        const failedWait = { ...row('wait', 'wait_agent', { targets: ['a'] }, { result: { status: { a: 'completed' } } }), error: true }
        const projection = projectSubagentActivities([dispatch, agent, notify, failedWait])
        expect([...projection.consumedToolKeys]).toEqual(['agent-a'])
        expect(projection.activityByAnchorKey.get('agent-a')?.[0]?.status).toBe('running')
    })

    it('projects real agent-run events through the existing reducer and turn partition', () => {
        const events: NormalizedMessage[] = [
            {
                id: 'start', localId: null, createdAt: 1000, role: 'event', isSidechain: false,
                content: {
                    type: 'agent-run-start', agentId: 'alpha', cardId: 'omp-subagent:alpha',
                    startedAt: 1000, status: 'running', summary: 'Read README',
                    input: { agent: 'reader', parentToolCallId: 'dispatch' }, parentToolCallId: 'dispatch',
                },
            },
            {
                id: 'done', localId: null, createdAt: 2500, role: 'event', isSidechain: false,
                content: {
                    type: 'agent-run-update', agentId: 'alpha', cardId: 'omp-subagent:alpha',
                    startedAt: 1000, completedAt: 2500, status: 'completed', result: 'README verified',
                },
            },
        ]
        const reduced = reduceChatBlocks(events, null)
        const partition = partitionTurn(reduced.blocks.filter((block): block is ToolCallBlock => block.kind === 'tool-call').map((block) => ({
            type: 'tool-call', toolName: block.tool.name, toolCallId: block.id, artifact: block,
        })), null)
        const activities = [...projectSubagentActivities(partition.rows).activityByAnchorKey.values()].flat()
        expect(activities).toMatchObject([{
            taskId: 'alpha', name: 'reader', status: 'completed', startedAt: 1000,
            completedAt: 2500, resultExcerpt: 'README verified',
        }])
    })
})
