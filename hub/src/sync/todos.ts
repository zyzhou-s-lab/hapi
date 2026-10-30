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

function isOmpTodoToolName(name: string | null): boolean {
    if (!name) return false
    const normalized = name.toLowerCase()
    return normalized === 'todo' || normalized === 'todowrite'
}

// checklist.tsx normalizeChecklistStatus: only completed / in_progress are
// distinct. omp also emits blocked and abandoned; those stay pending.
function normalizeOmpTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
    if (value === 'completed') return 'completed'
    if (value === 'in_progress') return 'in_progress'
    return 'pending'
}

function todosFromClaudeArray(todos: unknown): TodoItem[] | null {
    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

function todosFromOmpPhases(phases: unknown[]): TodoItem[] | null {
    const todos: Array<Pick<TodoItem, 'content' | 'status' | 'priority' | 'id'>> = []
    for (const phase of phases) {
        if (!isObject(phase) || !Array.isArray(phase.tasks)) continue
        for (const task of phase.tasks) {
            if (!isObject(task) || typeof task.content !== 'string') continue
            todos.push({
                content: task.content,
                status: normalizeOmpTodoStatus(task.status),
                priority: 'medium',
                id: typeof task.id === 'string' ? task.id : ''
            })
        }
    }
    return todosFromClaudeArray(todos)
}

function ompTodoDetails(value: Record<string, unknown>): { phases: unknown[] } | null {
    if (typeof value.op !== 'string' || OMP_TODO_OPS[value.op] !== true || !Array.isArray(value.phases)) return null
    return { phases: value.phases }
}

// omp `todo` results are `{ op, phases, storage }`, sometimes wrapped as
// `{ content, details }` — the same two shapes extractTodoChecklist reads.
function extractOmpTodoSnapshot(value: unknown): TodoItem[] | null {
    if (!isObject(value)) return null
    const details = ompTodoDetails(value)
        ?? (isObject(value.details) ? ompTodoDetails(value.details) : null)
    if (!details) return null
    return todosFromOmpPhases(details.phases)
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
        if (name !== 'TodoWrite') continue
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (!isObject(input)) continue

        const todosCandidate = input.todos
        const parsed = todosFromClaudeArray(todosCandidate)
        if (parsed) return parsed
    }

    return null
}
function extractTodosFromOmpOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null
    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    const fromToolUseResult = extractOmpTodoSnapshot(data.toolUseResult)
    if (fromToolUseResult) return fromToolUseResult

    const message = isObject(data.message) ? data.message : null
    if (!message || !Array.isArray(message.content)) return null

    for (const block of message.content) {
        if (!isObject(block)) continue
        if (block.type === 'tool_result') {
            const snapshot = extractOmpTodoSnapshot('content' in block ? (block as Record<string, unknown>).content : null)
            if (snapshot) return snapshot
            continue
        }
        if (block.type !== 'tool_use' || !isOmpTodoToolName(typeof block.name === 'string' ? block.name : null)) continue
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (!isObject(input)) continue
        if (Array.isArray(input.todos)) {
            const parsed = todosFromClaudeArray(input.todos)
            if (parsed) return parsed
        }
        const snapshot = extractOmpTodoSnapshot(input)
        if (snapshot) return snapshot
    }

    return null
}


function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    const name = typeof data.name === 'string' ? data.name : null
    const input = 'input' in data ? (data as Record<string, unknown>).input : null
    if (data.type === 'tool-call-result') {
        return extractOmpTodoSnapshot('output' in data ? data.output : null)
    }
    if (data.type !== 'tool-call') return null
    if (name !== 'TodoWrite' && !isOmpTodoToolName(name)) return null
    if (!isObject(input)) return null
    if (Array.isArray(input.todos)) return todosFromClaudeArray(input.todos)
    return extractOmpTodoSnapshot(input)
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
