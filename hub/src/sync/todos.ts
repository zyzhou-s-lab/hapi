import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { TodoItemSchema, TodosSchema } from '@hapi/protocol/schemas'
import type { TodoItem } from '@hapi/protocol/types'

export { TodoItemSchema, TodosSchema }
export type { TodoItem }

const OMP_TODO_OPS: Record<string, true> = {
    init: true,
    start: true,
    done: true,
    rm: true,
    drop: true,
    block: true,
    unblock: true,
    append: true,
    view: true
}

// Empty phases clear the panel only for these ops. A result with no op is
// not a clear, even when the tool is named todo.
const OMP_TODO_CLEAR_OPS: Record<string, true> = {
    init: true,
    view: true,
    rm: true
}

function isOmpTodoToolName(name: string | null): boolean {
    if (!name) return false
    const normalized = name.toLowerCase()
    return normalized === 'todo' || normalized === 'todowrite'
}

// Abandoned omp tasks are omitted. Blocked stays a flag beside `pending`:
// shipped iOS builds reject a `blocked` status enum value. Unknown statuses
// fall back to pending, matching checklist.tsx.
function visibleOmpTask(value: unknown): { status: 'pending' | 'in_progress' | 'completed'; blocked?: true } | null {
    if (value === 'abandoned') return null
    if (value === 'blocked') return { status: 'pending', blocked: true }
    if (value === 'completed' || value === 'in_progress') return { status: value }
    return { status: 'pending' }
}

function todosFromClaudeArray(todos: unknown): TodoItem[] | null {
    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

function ompTodoId(phaseName: string, index: number, id: unknown): string {
    if (typeof id === 'string' && id !== '') return id
    return `${phaseName}:${index}`
}

function ompTodoDetails(value: Record<string, unknown>): { op: string | null; phases: unknown[] } | null {
    if (!Array.isArray(value.phases)) return null
    const op = typeof value.op === 'string' ? value.op : null
    return { op, phases: value.phases }
}

// Result details only: `{ op, phases }` or `{ content, details: { op, phases } }`.
// A phase list without a known op is a snapshot only for a tool named todo.
// Input objects that merely contain `phases` are not passed here.
function extractOmpTodoSnapshot(value: unknown, namedTodo: boolean): TodoItem[] | null {
    if (!isObject(value)) return null
    const details = ompTodoDetails(value)
        ?? (isObject(value.details) ? ompTodoDetails(value.details) : null)
    if (!details) return null
    const known = details.op !== null && OMP_TODO_OPS[details.op] === true
    if (!known && !namedTodo) return null

    const todos: Array<Pick<TodoItem, 'content' | 'status' | 'priority' | 'id' | 'blocked'>> = []
    let opaque = false
    for (const phase of details.phases) {
        if (!isObject(phase) || !Array.isArray(phase.tasks)) {
            opaque = true
            continue
        }
        const phaseName = typeof phase.name === 'string' && phase.name !== '' ? phase.name : 'phase'
        phase.tasks.forEach((task, index) => {
            if (!isObject(task) || typeof task.content !== 'string') {
                opaque = true
                return
            }
            const mapped = visibleOmpTask(task.status)
            if (!mapped) return
            todos.push({
                content: task.content,
                status: mapped.status,
                priority: 'medium',
                id: ompTodoId(phaseName, index, task.id),
                ...(mapped.blocked ? { blocked: true } : {})
            })
        })
    }

    if (todos.length > 0) return todosFromClaudeArray(todos)
    if (opaque) return null
    if (known && details.op !== null && OMP_TODO_CLEAR_OPS[details.op] === true) {
        return []
    }
    return null
}

function extractTodosFromClaudeOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'assistant') return null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    if (!Array.isArray(modelContent)) return null

    for (const block of modelContent) {
        if (!isObject(block) || block.type !== 'tool_use') continue
        const name = typeof block.name === 'string' ? block.name : null
        if (!isOmpTodoToolName(name)) continue
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (!isObject(input)) continue
        // Incremental omp calls carry phases as the pre-call list. Only a
        // full todos array on the call is a snapshot; the result replaces it.
        if (Array.isArray(input.todos)) {
            const parsed = todosFromClaudeArray(input.todos)
            if (parsed) return parsed
        }
    }

    return null
}

function extractTodosFromOmpOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null
    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    const message = isObject(data.message) ? data.message : null
    if (!message || !Array.isArray(message.content)) return null

    const blocks = message.content.filter((block) => isObject(block) && block.type === 'tool_result')
    for (const block of blocks) {
        const resultName = typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : null
        if (resultName !== null && !isOmpTodoToolName(resultName)) continue
        if (block.is_error === true || block.isError === true) continue
        const namedTodo = isOmpTodoToolName(resultName)
        const fromContent = extractOmpTodoSnapshot('content' in block ? (block as Record<string, unknown>).content : null, namedTodo)
        if (fromContent) return fromContent
        // toolUseResult is one envelope for the whole message. Only a single
        // tool_result can own it; with several blocks it would stick to the wrong one.
        if (blocks.length !== 1) continue
        const fromEnvelope = extractOmpTodoSnapshot(data.toolUseResult, namedTodo)
        if (fromEnvelope) return fromEnvelope
    }

    return null
}

function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    if (data.type === 'tool-call-result') {
        if (data.is_error === true || data.isError === true) return null
        const name = typeof data.name === 'string' ? data.name : null
        if (name !== null && !isOmpTodoToolName(name)) return null
        return extractOmpTodoSnapshot('output' in data ? data.output : null, isOmpTodoToolName(name))
    }

    if (data.type !== 'tool-call') return null
    const name = typeof data.name === 'string' ? data.name : null
    if (!isOmpTodoToolName(name)) return null
    const input = 'input' in data ? (data as Record<string, unknown>).input : null
    if (!isObject(input) || !Array.isArray(input.todos)) return null
    return todosFromClaudeArray(input.todos)
}

function extractTodosFromAcpMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'plan') return null

    const entries = data.entries
    if (!Array.isArray(entries)) return null

    const todos: TodoItem[] = []
    entries.forEach((entry, index) => {
        if (!isObject(entry)) return
        const contentValue = typeof entry.content === 'string' ? entry.content : null
        const priorityValue = typeof entry.priority === 'string' ? entry.priority : null
        const statusValue = typeof entry.status === 'string' ? entry.status : null
        if (!contentValue || !priorityValue || !statusValue) return
        if (priorityValue !== 'high' && priorityValue !== 'medium' && priorityValue !== 'low') return
        if (statusValue !== 'pending' && statusValue !== 'in_progress' && statusValue !== 'completed') return

        const idValue = typeof entry.id === 'string' ? entry.id : `plan-${index + 1}`

        todos.push({
            content: contentValue,
            priority: priorityValue,
            status: statusValue,
            id: idValue
        })
    })

    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

export function extractTodoWriteTodosFromMessageContent(messageContent: unknown): TodoItem[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    if (record.role !== 'agent' && record.role !== 'assistant') return null

    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    return extractTodosFromClaudeOutput(record.content)
        ?? extractTodosFromOmpOutput(record.content)
        ?? extractTodosFromCodexMessage(record.content)
        ?? extractTodosFromAcpMessage(record.content)
}
