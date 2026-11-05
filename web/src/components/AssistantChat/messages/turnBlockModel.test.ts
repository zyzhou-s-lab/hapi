import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import {
    coalesceTurnStepRows,
    countTurnActions,
    describeCoalescedTurnStep,
    describeTurnToolStep,
    extractThoughtSummary,
    partitionTurn,
    turnDurationMs,
    type TurnCoalescedRow,
    type TurnContentPart,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'

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
            'turn.verb.addedTask 截图',
            'turn.verb.addedTask 打包',
        ])

        const full = partitionTurn([
            call(tool('todo', 'TodoWrite', { input: { todos: [{ content: '旧项', status: 'pending' }] } })),
        ], null)
        expect(full.rows).toHaveLength(1)
        expect(full.rows[0]?.kind === 'tool' && full.rows[0].verb).toBe('turn.verb.todo')
    })

    it('pins errors and pending permissions, and keeps a subagent as a row', () => {
        const partition = partitionTurn([
            call(tool('bash', 'Bash', { state: 'error', description: 'Locate Chrome', input: { command: 'which chrome' } })),
            call(tool('edit', 'Edit', { state: 'pending', permission: { id: 'p1', status: 'pending' }, input: { file_path: 'home.tsx' } })),
            call(tool('agent', 'Task', { description: 'Report this machine identity' })),
        ], null)
        expect(partition.rows.map((row) => row.kind === 'tool' ? [row.verb, row.pinned, row.error, row.permission] : null)).toEqual([
            ['turn.verb.ran', true, true, false],
            ['turn.verb.edit', true, false, true],
            ['turn.verb.ranAgent', true, false, false],
        ])
    })

    it('titles a subagent from its description, not the prompt heading', () => {
        const named = partitionTurn([
            call(tool('agent', 'Task', {
                nativeTitle: '# Target\n\nRead the files',
                input: {
                    description: 'Inspect auth',
                    prompt: '# Target\n\nRead the files',
                },
            })),
        ], null)
        expect(named.rows[0]?.kind === 'tool' && named.rows[0].intent).toBe('Inspect auth')

        const promptOnly = partitionTurn([
            call(tool('prompt-only', 'Agent', {
                input: { prompt: '# Target\n\nRead the session cursor and report where paging starts' },
            })),
        ], null)
        expect(promptOnly.rows[0]?.kind === 'tool' && promptOnly.rows[0].intent).toBe(
            'Read the session cursor and report where paging starts'
        )

        const ruled = partitionTurn([
            call(tool('ruled', 'Agent', {
                input: { prompt: '# Target\n\n---\n\nRead the session cursor' },
            })),
        ], null)
        expect(ruled.rows[0]?.kind === 'tool' && ruled.rows[0].intent).toBe('Read the session cursor')

        const long = partitionTurn([
            call(tool('long', 'Task', {
                input: { description: 'D'.repeat(90) },
            })),
        ], null)
        expect(long.rows[0]?.kind === 'tool' && long.rows[0].intent).toBe(`${'D'.repeat(77)}...`)
    })

    it('normalizes lowercase OMP tool names and folds recovered mid-turn tool errors', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: 'Inspecting Tern sessions' },
            call(tool('read-err', 'read', {
                state: 'error',
                input: {
                    path: 'session://01a1a178-20a6-7795-a647-aaa2418531e5/timeline:-40',
                    i: 'Reading timeline of PAGING session 01a1a178',
                },
            })),
            call(tool('read-fallback', 'read', {
                state: 'error',
                input: {
                    path: 'session://01a19c9a-a35e-769c-9dad-36421e1aa5e9/timeline:-40',
                },
            })),
            call(tool('bash-ok', 'bash', {
                state: 'completed',
                input: {
                    command: 'tern capture 95988224098306 --surfaces',
                    i: 'Capturing surface text of HAPI blocks in Tern',
                },
            })),
            { type: 'text', text: '查询完成。' },
        ], null)

        expect(partition.hasPinned).toBe(false)
        expect(partition.rows.filter((row) => row.kind === 'tool').map((row) => [
            row.verb,
            row.intent,
            row.pinned,
            row.error,
        ])).toEqual([
            ['turn.verb.read', 'Reading timeline of PAGING session 01a1a178', false, true],
            ['turn.verb.read', 'timeline:-40', false, true],
            ['turn.verb.ran', 'Capturing surface text of HAPI blocks in Tern', false, false],
        ])
    })

    it('keeps the last tool error pinned when followed only by trailing text', () => {
        const partition = partitionTurn([
            call(tool('read-ok', 'Read', {
                state: 'completed',
                input: { file_path: 'db/schema.sql' },
            })),
            call(tool('bash-err', 'Bash', {
                state: 'error',
                description: 'Run database migration',
                input: { command: 'bun run migrate' },
            })),
            { type: 'text', text: '没能跑迁移，因为数据库连接被拒绝。' },
        ], null)

        expect(partition.hasPinned).toBe(true)
        expect(partition.rows.filter((row) => row.kind === 'tool').map((row) => [
            row.key,
            row.pinned,
            row.error,
        ])).toEqual([
            ['read-ok', false, false],
            ['bash-err', true, true],
        ])
    })

    it('keeps earlier tool errors pinned while any tool in the turn is pending', () => {
        const partition = partitionTurn([
            call(tool('read-err', 'Read', {
                state: 'error',
                input: { file_path: 'missing.ts' },
            })),
            call(tool('read-ok', 'Read', {
                state: 'completed',
                input: { file_path: 'present.ts' },
            })),
            call(tool('bash-pending', 'Bash', {
                state: 'pending',
                permission: { id: 'perm-1', status: 'pending' },
                input: { command: 'bun test' },
            })),
        ], null)

        expect(partition.hasPinned).toBe(true)
        expect(partition.rows.filter((row) => row.kind === 'tool').map((row) => [
            row.key,
            row.pinned,
            row.error,
            row.permission,
        ])).toEqual([
            ['read-err', true, true, false],
            ['read-ok', false, false, false],
            ['bash-pending', true, false, true],
        ])
    })

    it('unpins recovered TodoWrite errors and supersedes earlier TodoWrite snapshots in a turn', () => {
        const partition = partitionTurn([
            call(tool('todo-err', 'todo', {
                state: 'error',
                input: { input: '*** Begin Todo\n*** End Todo' },
                result: 'Validation failed',
            })),
            call(tool('todo-1', 'todo', {
                state: 'completed',
                input: { todos: [{ id: '1', content: 'Task 1', status: 'in_progress' }] },
            })),
            call(tool('todo-2', 'todo', {
                state: 'completed',
                input: { todos: [{ id: '1', content: 'Task 1', status: 'completed' }] },
            })),
        ], null)

        expect(partition.rows.filter((row) => row.kind === 'tool').map((row) => [
            row.key,
            row.pinned,
            row.error,
        ])).toEqual([
            ['todo-err', false, true],
            ['todo-1', false, false],
            ['todo-2', true, false],
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

    it('does not treat an empty intent as the block title', () => {
        const partition = partitionTurn([
            call(tool('custom', 'MysteryTool', { state: 'running' })),
        ], null)
        expect(partition.title).toBe('MysteryTool')
    })

    it('prefers tool intent over a generic opening thought', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: "I'm thinking through how to approach this." },
            call(tool('agent', 'Task', { input: { description: 'Explore recent work across repos' } })),
        ], null)
        expect(partition.title).toBe('Explore recent work across repos')
    })

    it('caps a reasoning-only title to one short line', () => {
        const long = '**Plan** ' + 'word '.repeat(60)
        const partition = partitionTurn([
            { type: 'reasoning', text: long },
            call(tool('custom', 'MysteryTool')),
        ], null)
        expect(partition.title.startsWith('Plan word')).toBe(true)
        expect(partition.title.length).toBeLessThanOrEqual(80)
    })

    it('keeps generated images and files, and leaves text beside them', () => {
        const image = {
            kind: 'generated-image' as const,
            id: 'img',
            localId: null,
            createdAt: 1,
            imageId: 'image-1',
            fileName: 'shot.png',
            mimeType: 'image/png',
        }
        const file = {
            kind: 'generated-file' as const,
            id: 'file',
            localId: null,
            createdAt: 1,
            fileId: 'file-1',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            size: 12,
        }
        const onlyImage = partitionTurn([{ type: 'tool-call', toolName: 'GeneratedImage', artifact: image }], null)
        expect(onlyImage.hasActivity).toBe(true)
        expect(onlyImage.rows.map((row) => row.kind)).toEqual(['image'])

        const textAndImage = partitionTurn([
            { type: 'text', text: '图在这里。' },
            { type: 'tool-call', toolName: 'GeneratedImage', artifact: image },
        ], null)
        expect(textAndImage.rows.map((row) => row.kind === 'text' ? row.text : row.kind)).toEqual(['图在这里。', 'image'])

        const toolAndFile = partitionTurn([
            call(tool('read', 'Read', { input: { file_path: 'home.tsx' } })),
            { type: 'tool-call', toolName: 'GeneratedFile', artifact: file },
        ], null)
        expect(toolAndFile.rows.map((row) => row.kind)).toEqual(['tool', 'file'])
    })

    it('reports no activity for blank reasoning or a Codex reasoning tool alone', () => {
        const blank = partitionTurn([
            { type: 'reasoning', text: '   ' },
            { type: 'text', text: '空白思考后的回答' },
        ], null)
        expect(blank.hasActivity).toBe(false)
        expect(blank.rows.map((row) => row.kind === 'text' ? row.text : row.kind)).toEqual(['空白思考后的回答'])

        const codex = partitionTurn([
            call(tool('reason', 'CodexReasoning', { input: { title: 'Thinking' } })),
            { type: 'text', text: '只有推理标题后的回答' },
        ], null)
        expect(codex.hasActivity).toBe(false)
        expect(codex.rows.map((row) => row.kind === 'text' ? row.text : row.kind)).toEqual(['只有推理标题后的回答'])
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

describe('OMP native tool aliases, Thought summary, and homogeneous step coalescing', () => {
    it('maps OMP native tools and Write agent:// URIs to semantic verbs and action counts', () => {
        const partition = partitionTurn([
            call(tool('ex1', 'exec_command', { input: { cmd: 'bun test', title: 'Run tests' } })),
            call(tool('ag1', 'ast_grep', { input: { pat: 'foo($A)', path: 'src' } })),
            call(tool('ae1', 'ast_edit', { input: { paths: ['src/app.ts'] } })),
            call(tool('ft1', 'fork_task', {
                input: {
                    tasks: [
                        { name: 'MentorPlan', task: 'Review plan' },
                        { name: 'DiscussSteady', task: 'Check risks' },
                    ],
                },
            })),
            call(tool('w1', 'Write', { input: { path: 'agent://MentorPlan', content: 'Debrief findings' } })),
            call(tool('wt1', 'wait', { input: { i: 'Waiting for MentorPlan debrief' } })),
            call(tool('del1', 'delete', { input: { paths: ['tmp/old.ts'] } })),
            call(tool('in1', 'write_stdin', { input: { session_id: 3, chars: 'q\n' } })),
            call(tool('ks1', 'kill_session', { input: { session_id: 3 } })),
        ], null)

        expect(countTurnActions(partition.rows)).toEqual({
            commands: 3,
            reads: 0,
            searches: 1,
            edits: 2,
            webFetches: 0,
            webSearches: 0,
            thoughts: 0,
            agents: 2,
            compactions: 0,
        })

        const toolRows = partition.rows.filter((r): r is TurnToolRow => r.kind === 'tool')
        expect(toolRows.map((r) => r.verb)).toEqual([
            'turn.verb.ran',
            'turn.verb.grep',
            'turn.verb.edit',
            'turn.verb.ranAgent',
            'turn.verb.messagedAgent',
            'turn.verb.wait',
            'turn.verb.delete',
            'turn.verb.stdin',
            'turn.verb.killSession',
        ])

        expect(describeTurnToolStep(toolRows[4]!, 'en')).toMatchObject({
            verbLabel: 'Messaged',
            intentLabel: 'MentorPlan',
            secondaryBadge: null,
        })
        expect(describeTurnToolStep(toolRows[5]!, 'en')).toMatchObject({
            verbLabel: 'Waited for agents',
            secondaryBadge: null,
        })
    })

    it('strips line-range selectors from Read step intentLabel while keeping range in preview', () => {
        const partition = partitionTurn([
            call(tool('r1', 'Read', {
                input: { path: '/repo/cli/src/omp/OmpRpcEventAdapter.ts:120-180' },
                result: 'line1\nline2',
            })),
        ], null)
        const readRow = partition.rows[0] as TurnToolRow
        expect(readRow.intent).toBe('OmpRpcEventAdapter.ts:120-180')
        const desc = describeTurnToolStep(readRow, 'en')
        expect(desc.intentLabel).toBe('OmpRpcEventAdapter.ts')
        expect(desc.preview).toEqual({
            kind: 'file-read',
            filePath: '/repo/cli/src/omp/OmpRpcEventAdapter.ts:120-180',
            content: 'line1\nline2',
            lineCount: 2,
        })
    })

    it('extracts a clean single-line Thought summary without markdown prefixes', () => {
        expect(extractThoughtSummary('### Root Cause Analysis\nSecond line')).toBe('Root Cause Analysis')
        expect(extractThoughtSummary('- **Check `TimelineTurnBlock.tsx`** for transition flash')).toBe(
            'Check TimelineTurnBlock.tsx for transition flash'
        )
    })

    it('coalesces consecutive completed Read, Search, Subagent, and ContextCompaction steps', () => {
        const sameFilePartition = partitionTurn([
            call(tool('r1', 'Read', { input: { path: '/repo/src/OmpRpcEventAdapter.ts:1-50' }, result: 'a\nb' })),
            call(tool('r2', 'Read', { input: { path: '/repo/src/OmpRpcEventAdapter.ts:51-100' }, result: 'c\nd\ne' })),
        ], null)
        const coalescedSameFile = coalesceTurnStepRows(sameFilePartition.rows)
        expect(coalescedSameFile).toHaveLength(1)
        expect(coalescedSameFile[0]?.kind).toBe('coalesced')
        expect(describeCoalescedTurnStep(coalescedSameFile[0] as TurnCoalescedRow, 'en')).toEqual({
            verbLabel: 'Viewed',
            intentLabel: 'OmpRpcEventAdapter.ts',
            secondaryBadge: '2 ranges · 5 lines',
        })

        const subagentLifecycle = partitionTurn([
            call(tool('t1', 'Task', { input: { name: 'MentorPlan', task: 'Check plan' } })),
            { type: 'reasoning', text: 'Let us wait for MentorPlan to respond.' },
            call(tool('wt1', 'wait', { input: { i: 'Waiting for MentorPlan' } })),
            call(tool('w1', 'Write', { input: { path: 'agent://MentorPlan', content: 'Follow up' } })),
        ], null)
        const coalescedSubagents = coalesceTurnStepRows(subagentLifecycle.rows, { absorbTransitionalThoughts: true })
        expect(coalescedSubagents).toHaveLength(1)
        expect(coalescedSubagents[0]?.kind).toBe('coalesced')
        expect(describeCoalescedTurnStep(coalescedSubagents[0] as TurnCoalescedRow, 'en')).toEqual({
            verbLabel: 'Ran agent',
            intentLabel: 'MentorPlan',
            secondaryBadge: 'Done',
        })
    })
})
