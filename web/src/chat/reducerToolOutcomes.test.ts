import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import { reduceTimeline } from './reducerTimeline'
import { ensureToolBlock } from './reducerTools'
import type { TracedMessage } from './tracer'
import type { ChatBlock, NormalizedAgentContent, NormalizedMessage, ToolCallBlock, ToolResult, ToolUse } from './types'

function agent(id: string, content: NormalizedAgentContent[], overrides: Partial<TracedMessage> = {}): TracedMessage {
    return {
        id,
        localId: null,
        createdAt: 1_000,
        isSidechain: false,
        ...overrides,
        role: 'agent',
        content
    }
}

function call(id: string, overrides: Partial<ToolUse> = {}): ToolUse {
    return {
        type: 'tool-call',
        id,
        name: 'bash',
        input: { command: 'long-running-job' },
        description: null,
        status: 'in_progress',
        uuid: id,
        parentUUID: null,
        ...overrides
    }
}

function result(toolId: string, isError = false): ToolResult {
    return {
        type: 'tool-result',
        tool_use_id: toolId,
        content: { exit: isError ? 1 : 0 },
        is_error: isError,
        uuid: `${toolId}-result`,
        parentUUID: null
    }
}

function context(overrides: Partial<Parameters<typeof reduceTimeline>[1]> = {}): Parameters<typeof reduceTimeline>[1] {
    return {
        permissionsById: new Map(),
        groups: new Map(),
        consumedGroupIds: new Set<string>(),
        titleChangesByToolUseId: new Map(),
        emittedTitleChangeToolUseIds: new Set<string>(),
        ...overrides
    }
}

const ready: TracedMessage = {
    id: 'ready', localId: null, createdAt: 2_000, isSidechain: false,
    role: 'event', content: { type: 'ready' }
}

const nextUser: TracedMessage = {
    id: 'next-user', localId: null, createdAt: 3_000, isSidechain: false,
    role: 'user', content: { type: 'text', text: 'Next instruction' }
}

const neighborCases: { label: string; messages: TracedMessage[] }[] = [
    { label: 'ready', messages: [ready] },
    { label: 'non-steered user message', messages: [nextUser] },
    { label: 'later text', messages: [agent('text', [{ type: 'text', text: 'Continuing', uuid: 'text', parentUUID: null }])] },
    { label: 'later reasoning', messages: [agent('reasoning', [{ type: 'reasoning', text: 'Continuing', uuid: 'reasoning', parentUUID: null }])] },
    { label: 'peer terminal status', messages: [agent('peer', [call('peer', { name: 'read', status: 'completed' })])] },
    { label: 'peer result', messages: [agent('peer-result', [result('peer')])] },
    { label: 'wait terminal status', messages: [agent('wait', [call('wait', { name: 'wait', status: 'completed' })])] },
    { label: 'wait result', messages: [agent('wait', [call('wait', { name: 'wait' })]), agent('wait-result', [result('wait')])] },
    {
        label: 'new tool after a completed peer',
        messages: [
            agent('peer-result', [result('peer')]),
            agent('new-tool', [call('new-tool', { name: 'read' })])
        ]
    }
]

describe('tool outcome authority', () => {
    it.each(neighborCases)('preserves pending/running tools after $label', ({ messages }) => {
        for (const status of ['pending', 'in_progress'] as const) {
            const reduced = reduceTimeline([
                agent('tool-call', [call('tool', { status })], { turnId: 'owner' }),
                ...messages
            ], context())
            expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
                state: status === 'pending' ? 'pending' : 'running',
                completionSource: 'unresolved',
                completedAt: null
            })
            expect(reduced.hasReadyEvent).toBe(messages.includes(ready))
        }
    })

    it.each(['completed', 'failed', 'aborted', 'cutoff'] as const)('maps only exact owned pending/running tools to error for canonical %s', (turnState) => {
        for (const status of ['pending', 'in_progress'] as const) {
            const reduced = reduceTimeline([
                agent('owned', [call('owned', { status })], { turnId: 'closed-owner' }),
                agent('other', [call('other')], { turnId: 'other-owner' }),
                agent('unattributed', [call('unattributed')])
            ], context({
                turnStates: new Map([['closed-owner', turnState], ['other-owner', 'running']])
            }))
            expect(reduced.toolBlocksById.get('owned')?.tool).toMatchObject({
                state: 'error', completionSource: 'invocation-cutoff', completedAt: null
            })
            for (const id of ['other', 'unattributed']) {
                expect(reduced.toolBlocksById.get(id)?.tool).toMatchObject({
                    state: 'running', completionSource: 'unresolved', completedAt: null
                })
            }
        }
    })

    it.each(['running', 'history', undefined] as const)('keeps %s or absent canonical lifecycle unresolved despite idle/ready/user boundaries', (turnState) => {
        const reduced = reduceTimeline([
            agent('tool-call', [call('tool')], { turnId: 'owner' }), ready, nextUser
        ], context({
            turnStates: turnState === undefined ? undefined : new Map([['owner', turnState]])
        }))
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved', completedAt: null
        })
    })

    it('does not treat a closed unrelated turn as tool ownership', () => {
        const reduced = reduceTimeline([
            agent('tool-call', [call('tool')]), ready
        ], context({
            turnStates: new Map([['closed-owner', 'cutoff']])
        }))
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved'
        })
    })

    it.each([
        { label: 'sidechain', attribution: { isSidechain: true } },
        { label: 'traced child', attribution: { sidechainId: 'parent-message' } },
        { label: 'explicit child', attribution: { parentToolUseId: 'parent-tool' } }
    ])('does not infer cutoff for $label tools from parent turn identity', ({ attribution }) => {
        const reduced = reduceTimeline([
            agent('child-tool', [call('tool')], { turnId: 'parent-turn', ...attribution })
        ], context({ turnStates: new Map([['parent-turn', 'cutoff']]) }))
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved'
        })
    })

    it.each(['Task', 'Agent', 'Task:worker', 'Agent:worker', 'CodexAgent'])('preserves %s with uncertain child invocation ownership', (name) => {
        const reduced = reduceTimeline([
            agent('task-call', [call('tool', { name, input: { prompt: 'Inspect', run_in_background: true } })], { turnId: 'parent-turn' })
        ], context({ turnStates: new Map([['parent-turn', 'aborted']]) }))
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved'
        })
    })

    it('preserves conflicting owner IDs instead of accepting first-known turn attribution', () => {
        const reduced = reduceTimeline([
            agent('first', [call('tool')], { turnId: 'first-owner' }),
            agent('second', [call('tool')], { turnId: 'second-owner' })
        ], context({ turnStates: new Map([['first-owner', 'cutoff'], ['second-owner', 'cutoff']]) }))
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved'
        })
    })

    it('distinguishes progress payloads from authoritative results', () => {
        const messages = [agent('tool-call', [call('tool', { progress: { lines: ['Working'] } })], { turnId: 'owner' })]
        const open = reduceTimeline(messages, context())
        expect(open.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'running', completionSource: 'unresolved', result: { lines: ['Working'] }
        })
        const closed = reduceTimeline(messages, context({ turnStates: new Map([['owner', 'cutoff']]) }))
        expect(closed.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: 'error', completionSource: 'invocation-cutoff', result: { lines: ['Working'] }
        })
    })

    it.each(['completed', 'failed', 'cancelled', 'canceled', 'error'] as const)('preserves explicit terminal status %s through cutoff and neighboring activity', (status) => {
        const reduced = reduceTimeline([
            agent('terminal', [call('tool', { status })], { turnId: 'owner' }),
            ready, nextUser, agent('other', [call('other')])
        ], context({ turnStates: new Map([['owner', 'cutoff']]) }))
        expect(reduced.toolBlocksById.get('tool')?.tool.state).toBe(status === 'completed' ? 'completed' : 'error')
        expect(reduced.toolBlocksById.get('tool')?.tool.completionSource).toBeUndefined()
        expect(reduced.toolBlocksById.get('tool')?.tool.completedAt).toBe(1_000)
    })

    it.each([false, true])('preserves authoritative tool result with is_error=%s and accepts it after an inferred cutoff', (isError) => {
        const messages = [agent('tool-call', [call('tool')], { turnId: 'owner' })]
        const reducerContext = context({ turnStates: new Map([['owner', 'cutoff']]) })
        expect(reduceTimeline(messages, reducerContext).toolBlocksById.get('tool')?.tool.completionSource).toBe('invocation-cutoff')
        const reduced = reduceTimeline([
            ...messages,
            agent('tool-result', [result('tool', isError)], { createdAt: 2_000, turnId: 'owner' }),
            agent('late-running-replay', [call('tool')], { createdAt: 3_000, turnId: 'owner' }),
            ready, nextUser
        ], reducerContext)
        expect(reduced.toolBlocksById.get('tool')?.tool).toMatchObject({
            state: isError ? 'error' : 'completed',
            result: { exit: isError ? 1 : 0 },
            completedAt: 2_000
        })
        expect(reduced.toolBlocksById.get('tool')?.tool.completionSource).toBeUndefined()
    })

    it('lets an explicit terminal status supersede an earlier inferred cutoff error', () => {
        const reduced = reduceTimeline([
            agent('tool-call', [call('tool')], { turnId: 'owner' })
        ], context({ turnStates: new Map([['owner', 'cutoff']]) }))
        const block = ensureToolBlock(reduced.blocks, reduced.toolBlocksById, 'tool', {
            createdAt: 2_000, localId: null, name: 'bash', input: {}, description: null, status: 'completed'
        })
        expect(block.tool).toMatchObject({ state: 'completed', completedAt: 2_000 })
        expect(block.tool.completionSource).toBeUndefined()
    })

    it('keeps native failures authoritative on a later completed status update', () => {
        const blocks: ChatBlock[] = []
        const tools = new Map<string, ToolCallBlock>()
        ensureToolBlock(blocks, tools, 'tool', {
            createdAt: 1_000, localId: null, name: 'bash', input: {}, description: null, status: 'failed'
        })
        const block = ensureToolBlock(blocks, tools, 'tool', {
            createdAt: 2_000, localId: null, name: 'bash', input: {}, description: null, status: 'completed'
        })
        expect(block.tool).toMatchObject({ state: 'error', completedAt: 1_000 })
        expect(block.tool.completionSource).toBeUndefined()
    })
})

describe('reduceChatBlocks canonical tool ownership', () => {
    it.each(['completed', 'failed', 'aborted', 'cutoff'] as const)('closes a pure-tool invocation from canonical %s on an event message', (turnState) => {
        const messages: NormalizedMessage[] = [
            agent('tool-call', [call('tool')], { turnId: 'owner', turnState: 'running' }),
            {
                id: 'terminal', localId: null, createdAt: 2_000, isSidechain: false,
                role: 'event', content: { type: 'invocation-terminal' }, turnId: 'owner', turnState
            },
            agent('late-running', [call('tool')], { createdAt: 3_000, turnId: 'owner', turnState: 'running' })
        ]
        const reduced = reduceChatBlocks(messages, null)
        const tool = reduced.blocks.find((block) => block.kind === 'tool-call' && block.id === 'tool')
        expect(tool?.kind === 'tool-call' ? tool.tool : undefined).toMatchObject({
            state: 'error', completionSource: 'invocation-cutoff', completedAt: null
        })
    })

    it('does not lose canonical closure when a running assistant snapshot replaces the closed message', () => {
        const reduced = reduceChatBlocks([
            agent('closed-snapshot', [call('tool')], {
                turnId: 'owner', turnState: 'cutoff', streamSnapshot: { id: 'shared-snapshot', live: true }
            }),
            agent('running-snapshot', [call('tool')], {
                turnId: 'owner', turnState: 'running', streamSnapshot: { id: 'shared-snapshot', live: true }
            })
        ], null)
        expect(reduced.blocks.find((block) => block.kind === 'tool-call')).toMatchObject({
            tool: { state: 'error', completionSource: 'invocation-cutoff', completedAt: null }
        })
    })

    it('never treats canonical history as invocation closure', () => {
        const reduced = reduceChatBlocks([
            agent('tool-call', [call('tool')], { turnId: 'historical-owner', turnState: 'history' }), ready, nextUser
        ], null)
        const tool = reduced.blocks.find((block) => block.kind === 'tool-call' && block.id === 'tool')
        expect(tool?.kind === 'tool-call' ? tool.tool : undefined).toMatchObject({
            state: 'running', completionSource: 'unresolved', completedAt: null
        })
    })

    it.each([
        { label: 'sidechain', attribution: { isSidechain: true } },
        { label: 'traced child', attribution: { sidechainId: 'parent-message' } },
        { label: 'explicit child', attribution: { parentToolUseId: 'missing-parent' } }
    ])('does not borrow a $label lifecycle terminal to close a parent invocation', ({ attribution }) => {
        const reduced = reduceChatBlocks([
            agent('tool-call', [call('tool')], { turnId: 'owner', turnState: 'running' }),
            {
                id: 'child-terminal', localId: null, createdAt: 2_000, isSidechain: false,
                ...attribution, role: 'event', content: { type: 'invocation-terminal' },
                turnId: 'owner', turnState: 'cutoff'
            }
        ], null)
        const tool = reduced.blocks.find((block) => block.kind === 'tool-call' && block.id === 'tool')
        expect(tool?.kind === 'tool-call' ? tool.tool : undefined).toMatchObject({
            state: 'running', completionSource: 'unresolved'
        })
    })
})
