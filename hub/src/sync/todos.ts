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

// Abandoned omp tasks are omitted. Blocked stays blocked. Anything else
// unknown falls back to pending, matching checklist.tsx.
function visibleOmpStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | 'blocked' | null {
    if (value === 'abandoned') return null
    if (value === 'completed' || value === 'in_progress' || value === 'blocked') return value
    return 'pending'
}

function todosFromClaudeArray(todos: unknown): TodoItem[] | null {
    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

function ompTodoId(phaseName: string, index: number, id: unknown): string {
    if (typeof id === 'string' && id !== '') return id
    return `${phaseName}:${index}`
}

function ompTodoDetails(value: Record<string, unknown>): { op: string; phases: unknown[] } | null {
    if (typeof value.op !== 'string' || OMP_TODO_OPS[value.op] !== true || !Array.isArray(value.phases)) return null
    return { op: value.op, phases: value.phases }
}

// Result details only: `{ op, phases }` or `{ content, details: { op, phases } }`.
// Input objects that merely contain `phases` are not snapshots.
function extractOmpTodoSnapshot(value: unknown): TodoItem[] | null {
    if (!isObject(value)) return null
    const details = ompTodoDetails(value)
        ?? (isObject(value.details) ? ompTodoDetails(value.details) : null)
    if (!details) return null

    const todos: Array<Pick<TodoItem, 'content' | 'status' | 'priority' | 'id'>> = []
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
            const status = visibleOmpStatus(task.status)
            if (!status) return
            todos.push({
                content: task.content,
                status,
                priority: 'medium',
                id: ompTodoId(phaseName, index, task.id)
            })
        })
    }

    if (todos.length > 0) return todosFromClaudeArray(todos)
    if (opaque) return null
    // phases: [] is a whole-list publish only for init (replace), view (read of
    // an empty list), and rm. Other ops do not emit an empty phase array on
    // success; an errored rm keeps the previous phases and is skipped earlier.
    // A non-empty phase list with no remaining tasks is a real clear (rm emptied
    // every task, or every task was abandoned and is hidden).
    if (details.phases.length === 0 && details.op !== 'init' && details.op !== 'view' && details.op !== 'rm') {
        return null
    }
    return []
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

        const parsed = todosFromClaudeArray(input.todos)
        if (parsed) return parsed
    }

    return null
}

function extractTodosFromOmpOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null
    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    const message = isObject(data.message) ? data.message : null
    if (!message || !Array.isArray(message.content)) return null

    for (const block of message.content) {
        if (!isObject(block) || block.type !== 'tool_result') continue
        const resultName = typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : null
        if (!isOmpTodoToolName(resultName)) continue
        if (block.is_error === true || block.isError === true) continue
        const snapshot = extractOmpTodoSnapshot('content' in block ? (block as Record<string, unknown>).content : null)
            ?? extractOmpTodoSnapshot(data.toolUseResult)
        if (snapshot) return snapshot
    }

    return null
}

function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    if (data.type === 'tool-call-result') {
        const name = typeof data.name === 'string' ? data.name : null
        if (!isOmpTodoToolName(name) || data.is_error === true || data.isError === true) return null
        return extractOmpTodoSnapshot('output' in data ? data.output : null)
    }

    if (data.type !== 'tool-call') return null
    const name = typeof data.name === 'string' ? data.name : null
    if (name !== 'TodoWrite') return null
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
