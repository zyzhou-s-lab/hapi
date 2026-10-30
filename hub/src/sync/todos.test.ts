import { describe, expect, test } from 'bun:test'
import { applyTodoMessageContent } from '../fork-features/task-panel/taskProjection'
import { extractTodoWriteTodosFromMessageContent, type TodoItem } from './todos'

function outputMessage(data: Record<string, unknown>) {
    return { role: 'agent', content: { type: 'output', data } }
}

function codexMessage(data: Record<string, unknown>) {
    return { role: 'agent', content: { type: 'codex', data } }
}

function ompToolResult(
    details: Record<string, unknown>,
    opts?: { toolUseResult?: boolean; blockContent?: boolean; name?: string; isError?: boolean }
) {
    const toolOutput = {
        content: [{ type: 'text', text: 'summary' }],
        details
    }
    const includeEnvelope = opts?.toolUseResult !== false
    const includeBlock = opts?.blockContent !== false
    return outputMessage({
        type: 'user',
        message: {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'call-1',
                name: opts?.name ?? 'todo',
                content: includeBlock ? toolOutput : [{ type: 'text', text: 'summary' }],
                is_error: opts?.isError === true
            }]
        },
        ...(includeEnvelope ? { toolUseResult: toolOutput } : {})
    })
}

const initDetails = {
    op: 'init',
    storage: 'session',
    phases: [
        {
            name: 'Research',
            tasks: [
                { content: '查找已有实现', status: 'in_progress', id: 'task-1' },
                { content: '对照协议', status: 'pending' }
            ]
        },
        {
            name: 'Ship',
            tasks: [
                { content: '被阻塞的步骤', status: 'blocked' },
                { content: '放弃的步骤', status: 'abandoned' },
                { content: '已完成的步骤', status: 'completed' }
            ]
        }
    ]
}

const doneDetails = {
    op: 'done',
    storage: 'session',
    completedTasks: [{ phase: 'Research', content: '查找已有实现' }],
    phases: [
        {
            name: 'Research',
            tasks: [
                { content: '查找已有实现', status: 'completed', id: 'task-1' },
                { content: '对照协议', status: 'in_progress' }
            ]
        },
        {
            name: 'Ship',
            tasks: [
                { content: '被阻塞的步骤', status: 'blocked' },
                { content: '放弃的步骤', status: 'abandoned' },
                { content: '已完成的步骤', status: 'completed' }
            ]
        }
    ]
}

const initTodos: TodoItem[] = [
    { content: '查找已有实现', status: 'in_progress', priority: 'medium', id: 'task-1' },
    { content: '对照协议', status: 'pending', priority: 'medium', id: 'Research:1' },
    { content: '被阻塞的步骤', status: 'blocked', priority: 'medium', id: 'Ship:0' },
    { content: '已完成的步骤', status: 'completed', priority: 'medium', id: 'Ship:2' }
]

const doneTodos: TodoItem[] = [
    { content: '查找已有实现', status: 'completed', priority: 'medium', id: 'task-1' },
    { content: '对照协议', status: 'in_progress', priority: 'medium', id: 'Research:1' },
    { content: '被阻塞的步骤', status: 'blocked', priority: 'medium', id: 'Ship:0' },
    { content: '已完成的步骤', status: 'completed', priority: 'medium', id: 'Ship:2' }
]

describe('omp todo extraction', () => {
    test('reads details.phases, keeps blocked, hides abandoned, and fills blank ids', () => {
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails))).toEqual(initTodos)
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails, { toolUseResult: false }))).toEqual(initTodos)
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails, { blockContent: false }))).toEqual(initTodos)
    })

    test('replaces the list from later results and ignores incremental input', () => {
        const init = ompToolResult(initDetails)
        const call = codexMessage({
            type: 'tool-call',
            name: 'todo',
            callId: 'call-2',
            input: { op: 'done', task: '查找已有实现', phases: initDetails.phases },
            status: 'completed'
        })
        const assistantCall = outputMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', name: 'todo', input: { op: 'init', phases: initDetails.phases } }]
            }
        })
        const done = ompToolResult(doneDetails)
        expect(extractTodoWriteTodosFromMessageContent(call)).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(assistantCall)).toBeNull()

        const replay = [init, call, assistantCall, done].reduce<TodoItem[] | null>(
            (todos, message) => applyTodoMessageContent(todos, message) ?? todos,
            null
        )
        expect(replay).toEqual(doneTodos)

        let latest: TodoItem[] | null = null
        const transcript = [init, done, call]
        for (let i = transcript.length - 1; i >= 0; i -= 1) {
            latest = extractTodoWriteTodosFromMessageContent(transcript[i])
            if (latest) break
        }
        expect(latest).toEqual(doneTodos)
    })

    test('clears only a real empty list and skips errors and other tools', () => {
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'view',
            phases: [],
            storage: 'session'
        }))).toEqual([])
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'init',
            phases: [],
            storage: 'session'
        }))).toEqual([])
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'rm',
            phases: [{ name: 'Tasks', tasks: [] }],
            storage: 'session'
        }))).toEqual([])
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'done',
            phases: [],
            storage: 'session'
        }))).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'rm',
            phases: [],
            storage: 'session'
        }, { isError: true }))).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'view',
            phases: [],
            storage: 'session'
        }, { name: 'bash' }))).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(outputMessage({
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'read-1', name: 'read', content: 'file text' }]
            }
        }))).toBeNull()
    })

    test('reads a named omp tool-call-result and still accepts TodoWrite', () => {
        expect(extractTodoWriteTodosFromMessageContent(codexMessage({
            type: 'tool-call-result',
            name: 'todo',
            callId: 'call-1',
            output: { details: doneDetails }
        }))?.[0]).toEqual(doneTodos[0])
        expect(extractTodoWriteTodosFromMessageContent(codexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: { details: doneDetails }
        }))).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(codexMessage({
            type: 'tool-call-result',
            name: 'todo',
            callId: 'call-1',
            is_error: true,
            output: { details: { op: 'rm', phases: [], storage: 'session' } }
        }))).toBeNull()

        expect(extractTodoWriteTodosFromMessageContent(outputMessage({
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use',
                    name: 'TodoWrite',
                    input: { todos: [{ content: 'claude task', status: 'pending' }] }
                }]
            }
        }))).toEqual([{ content: 'claude task', status: 'pending', priority: 'medium', id: '' }])

        expect(extractTodoWriteTodosFromMessageContent(codexMessage({
            type: 'tool-call',
            name: 'TodoWrite',
            callId: 'claude-1',
            input: { todos: [{ content: 'codex task', status: 'completed', priority: 'high', id: 'c1' }] }
        }))).toEqual([{ content: 'codex task', status: 'completed', priority: 'high', id: 'c1' }])
    })
})
