import { describe, expect, it } from 'vitest'
import { assignThreadMessageIdsWithStableWrappers, buildThreadTopology, buildTurnEntitiesById, buildTurnLayoutsById, type BlockWithThreadMessageId } from './assistant-runtime-blocks'
import type { AgentTextBlock, CliOutputBlock, ToolCallBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'

const text: AgentTextBlock = { kind: 'agent-text', id: 'answer', localId: null, createdAt: 1, text: 'First' }
function tool(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return { kind: 'tool-call', id: 'tool', localId: null, createdAt: 2, children: [], tool: {
        id: 'tool', name: 'Read', state: 'running', input: {}, createdAt: 2,
        startedAt: 2, completedAt: null, execStartedAt: null, execCompletedAt: null, description: null, ...overrides,
    } }
}

function model() {
    const wrappers = new WeakMap<VisibleChatBlock, BlockWithThreadMessageId>()
    let turns = buildTurnEntitiesById([], new Map(), new WeakMap())
    let layouts = buildTurnLayoutsById(turns, new Map())
    let topology = buildThreadTopology([], [])
    return (blocks: readonly VisibleChatBlock[]) => {
        const entries = assignThreadMessageIdsWithStableWrappers(blocks, wrappers)
        turns = buildTurnEntitiesById(entries, turns, new WeakMap())
        layouts = buildTurnLayoutsById(turns, layouts)
        topology = buildThreadTopology(entries, topology)
        return { turns, layouts, topology }
    }
}

describe('canonical thread topology and turn layout', () => {
    it('keeps mutable tool payloads live while preserving the layout subscription', () => {
        const update = model()
        const initial = update([text, tool()])
        const id = initial.topology[0]!.id
        const nextTool = { ...tool({ input: { file_path: 'a.ts', i: 'Inspecting file' }, result: 'progress' }), children: [{ ...text, id: 'child', text: 'Child progress' }] }
        const next = update([text, nextTool])
        expect(next.topology).toBe(initial.topology)
        expect(next.layouts.get(id)).toBe(initial.layouts.get(id))
        expect(next.turns.get(id)).not.toBe(initial.turns.get(id))
        expect(next.turns.get(id)?.parts[1]?.artifact).toBe(nextTool)
        const completed = update([text, tool({ state: 'completed', result: 'Final output' })])
        expect(completed.topology).toBe(initial.topology)
        expect(completed.layouts.get(id)).not.toBe(next.layouts.get(id))
        const permission = update([text, tool({ state: 'pending', permission: { id: 'permission', status: 'pending' } })])
        expect(permission.topology).toBe(initial.topology)
        expect(permission.layouts.get(id)).not.toBe(completed.layouts.get(id))
    })

    it('preserves turn layout on Todo/plan payload edits and updates layout only when todoCandidateEntityIds change', () => {
        const update = model()
        const initial = update([text, tool({ name: 'TodoWrite', input: { todos: [{ content: 'First', status: 'pending' }] } })])
        const next = update([text, tool({ name: 'TodoWrite', input: { todos: [{ content: 'First', status: 'completed' }] } })])
        expect(next.topology).toBe(initial.topology)
        expect(next.layouts).toBe(initial.layouts)
        expect(next.turns).not.toBe(initial.turns)
        const withSecondTodo = update([
            text,
            tool({ name: 'TodoWrite', input: { todos: [{ content: 'First', status: 'completed' }] } }),
            { ...tool({ id: 'tool-2', name: 'TodoWrite', input: { todos: [{ content: 'Second', status: 'pending' }] } }), id: 'tool-2' },
        ])
        expect(withSecondTodo.layouts).not.toBe(next.layouts)
    })

    it('invalidates empty-to-first-token layout but streams CLI payload independently', () => {
        const update = model()
        const cli: CliOutputBlock = { kind: 'cli-output', id: 'cli', localId: null, createdAt: 1, source: 'assistant', text: '' }
        const empty = update([cli])
        const first = update([{ ...cli, text: 'Line 1' }])
        const grown = update([{ ...cli, text: 'Line 1\nLine 2' }])
        expect(first.topology).toBe(empty.topology)
        expect(first.layouts).not.toBe(empty.layouts)
        expect(grown.layouts).toBe(first.layouts)
        expect(grown.turns.values().next().value?.parts[0]?.text).toBe('Line 1\nLine 2')
    })
})
