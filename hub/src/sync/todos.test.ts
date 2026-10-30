import { describe, expect, test } from 'bun:test'
import { applyTodoMessageContent } from '../fork-features/task-panel/taskProjection'
import { extractTodoWriteTodosFromMessageContent, type TodoItem } from './todos'

function outputMessage(data: Record<string, unknown>) {
    return { role: 'agent', content: { type: 'output', data } }
}

function codexMessage(data: Record<string, unknown>) {
    return { role: 'agent', content: { type: 'codex', data } }
}

function ompToolResult(details: Record<string, unknown>, opts?: { toolUseResult?: boolean; blockContent?: boolean }) {
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
                content: includeBlock ? toolOutput : [{ type: 'text', text: 'summary' }],
                is_error: false
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

describe('omp todo extraction', () => {
    test('reads details.phases from the canonical tool result and maps statuses like the web checklist', () => {
        const expected = [
            { content: '查找已有实现', status: 'in_progress', priority: 'medium', id: 'task-1' },
            { content: '对照协议', status: 'pending', priority: 'medium', id: '' },
            { content: '被阻塞的步骤', status: 'pending', priority: 'medium', id: '' },
            { content: '放弃的步骤', status: 'pending', priority: 'medium', id: '' },
            { content: '已完成的步骤', status: 'completed', priority: 'medium', id: '' }
        ]
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails))).toEqual(expected)
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails, { toolUseResult: false }))).toEqual(expected)
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult(initDetails, { blockContent: false }))).toEqual(expected)
    })

    test('treats each later op result as the full list, and ignores incremental tool-call input', () => {
        const init = ompToolResult(initDetails)
        const call = codexMessage({
            type: 'tool-call',
            name: 'todo',
            callId: 'call-2',
            input: { op: 'done', task: '查找已有实现', i: 'Marking research done' },
            status: 'completed'
        })
        const assistantCall = outputMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', name: 'todo', input: { op: 'done', task: '查找已有实现' } }]
            }
        })
        const done = ompToolResult(doneDetails)
        expect(extractTodoWriteTodosFromMessageContent(call)).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(assistantCall)).toBeNull()
        const replay = [init, call, assistantCall, done].reduce<TodoItem[] | null>(
            (todos, message) => applyTodoMessageContent(todos, message) ?? todos,
            null
        )
        expect(replay).toEqual([
            { content: '查找已有实现', status: 'completed', priority: 'medium', id: 'task-1' },
            { content: '对照协议', status: 'in_progress', priority: 'medium', id: '' },
            { content: '被阻塞的步骤', status: 'pending', priority: 'medium', id: '' },
            { content: '放弃的步骤', status: 'pending', priority: 'medium', id: '' },
            { content: '已完成的步骤', status: 'completed', priority: 'medium', id: '' }
        ])
        let latest: TodoItem[] | null = null
        const transcript = [init, done, call]
        for (let i = transcript.length - 1; i >= 0; i -= 1) {
            latest = extractTodoWriteTodosFromMessageContent(transcript[i])
            if (latest) break
        }
        expect(latest).toEqual(replay)
    })

    test('clears the list when a view result has no phases, and ignores unrelated tool results', () => {
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            op: 'view',
            phases: [],
            storage: 'session'
        }))).toEqual([])
        expect(extractTodoWriteTodosFromMessageContent(ompToolResult({
            kind: 'url',
            phases: [{ name: 'Nope', tasks: [{ content: 'not a todo', status: 'completed' }] }]
        }))).toBeNull()
        expect(extractTodoWriteTodosFromMessageContent(outputMessage({
            type: 'user',
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'file text' }]
            }
        }))).toBeNull()
    })

    test('reads an omp snapshot from a codex tool-call-result and still accepts TodoWrite', () => {
        expect(extractTodoWriteTodosFromMessageContent(codexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: { details: doneDetails }
        }))?.[0]).toEqual({ content: '查找已有实现', status: 'completed', priority: 'medium', id: 'task-1' })

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
