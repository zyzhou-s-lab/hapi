import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { partitionTurn, turnDurationMs, type TurnContentPart } from '@/components/AssistantChat/messages/turnBlockModel'

function tool(id: string, name: string, extra: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1_700_000_000_000,
        children: [],
        tool: {
            id,
            name,
            state: 'completed',
            input: {},
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_001_000,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            ...extra,
        },
    }
}

function call(block: ToolCallBlock): TurnContentPart {
    return { type: 'tool-call', toolName: block.tool.name, toolCallId: block.id, artifact: block }
}

describe('partitionTurn', () => {
    it('keeps sandwiched text inside and the answer after the last tool outside', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: '先看页面' },
            call(tool('read', 'Read', { input: { file_path: 'src/pages/home.tsx' } })),
            { type: 'text', text: 'Chromium 可用。' },
            call(tool('bash', 'Bash', { description: 'Locate a Chromium binary', input: { command: 'which chrome' } })),
            { type: 'text', text: '首屏已经截下来了。' },
        ], null)

        expect(partition.rows.map((row) => row.kind === 'text' ? `${row.trailing ? 'out' : 'in'}:${row.text}` : row.kind)).toEqual([
            'reasoning',
            'tool',
            'in:Chromium 可用。',
            'tool',
            'out:首屏已经截下来了。',
        ])
        const inside = partition.rows.find((row) => row.kind === 'text' && !row.trailing)
        expect(inside?.kind === 'text' && inside.text).toBe('Chromium 可用。')
    })

    it('expands a tool group in order and uses its activity title', () => {
        const group: ToolGroupBlock = {
            kind: 'tool-group',
            id: 'group',
            createdAt: 1,
            firstToolId: 'a',
            lastToolId: 'b',
            tools: [
                tool('a', 'Read', { input: { file_path: 'a.ts' } }),
                tool('b', 'Grep', { input: { pattern: 'turn' }, description: 'Find the turn header' }),
            ],
            defaultOpen: false,
            historyState: 'complete',
            needsOlderHistory: false,
            activityTitle: 'Reading the header',
            summary: {
                totalTools: 2,
                countsByKind: { read: 1, search: 1, command: 0, mutation: 0, web: 0, other: 0 },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }
        const partition = partitionTurn([{ type: 'tool-call', toolName: 'ToolGroup', artifact: group }], null)
        expect(partition.title).toBe('Reading the header')
        expect(partition.rows.map((row) => row.kind === 'tool' ? row.key : row.kind)).toEqual(['a', 'b'])
    })

    it('splits only incremental newTodos into Added task rows', () => {
        const added = partitionTurn([
            call(tool('todo', 'TodoWrite', { result: { newTodos: [{ content: '截图' }, { content: '打包' }] } })),
        ], null)
        expect(added.rows.map((row) => row.kind === 'tool' ? `${row.verb} ${row.intent}` : '')).toEqual([
            'Added task 截图',
            'Added task 打包',
        ])

        const full = partitionTurn([
            call(tool('todo', 'TodoWrite', { input: { todos: [{ content: '旧项', status: 'pending' }] } })),
        ], null)
        expect(full.rows).toHaveLength(1)
        expect(full.rows[0]?.kind === 'tool' && full.rows[0].verb).toBe('Todo')
    })

    it('pins errors and pending permissions, and keeps a subagent as a row', () => {
        const partition = partitionTurn([
            call(tool('bash', 'Bash', { state: 'error', description: 'Locate Chrome', input: { command: 'which chrome' } })),
            call(tool('edit', 'Edit', { state: 'pending', permission: { id: 'p1', status: 'pending' }, input: { file_path: 'home.tsx' } })),
            call(tool('agent', 'Task', { description: 'Report this machine identity' })),
        ], null)
        expect(partition.rows.map((row) => row.kind === 'tool' ? [row.verb, row.pinned, row.error, row.permission] : null)).toEqual([
            ['Ran', true, true, false],
            ['Edit', true, false, true],
            ['Ran agent', true, false, false],
        ])
    })

    it('uses a Codex reasoning title and does not render that tool as a row', () => {
        const partition = partitionTurn([
            call(tool('reason', 'CodexReasoning', { input: { title: 'Building a screenshot script' } })),
            call(tool('read', 'Read', { input: { file_path: 'home.tsx' } })),
        ], null)
        expect(partition.title).toBe('Building a screenshot script')
        expect(partition.rows.map((row) => row.kind)).toEqual(['tool'])
    })
})

describe('turnDurationMs', () => {
    it('prefers the reported round duration', () => {
        expect(turnDurationMs({
            roundSummary: { modelUsage: {}, durationMs: 151_000 },
            invokedAt: 0,
            createdAt: 10,
            now: 20,
            streaming: false,
        })).toBe(151_000)
    })

    it('does not invent a duration when the start is missing or the clocks disagree', () => {
        expect(turnDurationMs({ invokedAt: null, createdAt: 10, now: 20, streaming: false })).toBeNull()
        expect(turnDurationMs({ invokedAt: 50, createdAt: 10, now: 20, streaming: false })).toBeNull()
    })

    it('uses the live clock only while the turn is streaming', () => {
        expect(turnDurationMs({ invokedAt: 1_000, createdAt: 1_500, now: 4_000, streaming: true })).toBe(3_000)
        expect(turnDurationMs({ invokedAt: 1_000, createdAt: 2_500, now: 9_000, streaming: false })).toBe(1_500)
    })
})
