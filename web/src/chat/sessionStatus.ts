import { isObject } from '@hapi/protocol'
import type { ThreadGoal, TodoItem } from '@/types/api'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { projectSessionTodoSnapshot } from '@/chat/projections/todoProjection'
import { getCodexAgentActivity, getCodexAgentSummary } from '@/components/ToolCard/codexAgents'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

export type SessionStatusSubagent = {
    id: string
    title: string
    detail: string | null
    state: 'running' | 'waiting' | 'error'
    startedAt: number | null
    endedAt: number | null
}

export type SessionStatusTerminal = {
    id: string
    command: string
    cwd: string | null
    startedAt: number
}

export type SessionStatusData = {
    goal: ThreadGoal | null
    tasks: TodoItem[]
    subagents: SessionStatusSubagent[]
    terminals: SessionStatusTerminal[]
    undiscoveredTerminalCount: number
    possibleTerminalCommands: string[]
}

const BACKGROUND_START_RE = /Command running in background with ID:\s*([^\s<]+)/
const TASK_ID_RE = /<task-id>\s*([^<]+?)\s*<\/task-id>/

function findBackgroundTaskId(value: unknown): string | null {
    if (typeof value === 'string') return value.match(BACKGROUND_START_RE)?.[1] ?? null
    const values = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []
    for (const item of values) {
        const taskId = findBackgroundTaskId(item)
        if (taskId) return taskId
    }
    return null
}

function commandFromInput(input: unknown): string | null {
    const command = getInputStringAny(input, ['command', 'cmd'])
    if (command) return command
    if (!isObject(input) || !Array.isArray(input.command)) return null
    const parts = input.command.filter((part): part is string => typeof part === 'string')
    return parts.length > 0 ? parts.join(' ') : null
}

function terminalFromBlock(block: ToolCallBlock): SessionStatusTerminal | null {
    if (block.tool.name !== 'Bash') return null
    const taskId = findBackgroundTaskId(block.tool.result)
    if (!taskId) return null

    return {
        id: taskId,
        command: commandFromInput(block.tool.input) ?? block.tool.description ?? block.tool.name,
        cwd: getInputStringAny(block.tool.input, ['cwd', 'workdir', 'path']),
        startedAt: block.tool.startedAt ?? block.createdAt
    }
}

function collectToolBlocks(blocks: readonly ChatBlock[]): ToolCallBlock[] {
    const tools: ToolCallBlock[] = []
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        tools.push(block, ...collectToolBlocks(block.children))
    }
    return tools
}

function backgroundTaskCompletions(messages: readonly NormalizedMessage[]): {
    ids: Set<string>
    latestUnknownAt: number | null
} {
    const ids = new Set<string>()
    let latestUnknownAt: number | null = null

    for (const message of messages) {
        if (message.role !== 'agent') continue
        for (const content of message.content) {
            if (content.type !== 'sidechain') continue
            const prompt = content.prompt.trimStart()
            if (!prompt.startsWith('<task-notification>')) continue
            const taskId = prompt.match(TASK_ID_RE)?.[1]?.trim()
            if (taskId) ids.add(taskId)
            else latestUnknownAt = Math.max(latestUnknownAt ?? 0, message.createdAt)
        }
    }

    return { ids, latestUnknownAt }
}

function buildBackgroundTerminals(
    tools: readonly ToolCallBlock[],
    messages: readonly NormalizedMessage[]
): { confirmed: SessionStatusTerminal[]; uncertain: SessionStatusTerminal[] } {
    const terminals = tools
        .map(terminalFromBlock)
        .filter((terminal): terminal is SessionStatusTerminal => terminal !== null)
    const completions = backgroundTaskCompletions(messages)
    const remaining = terminals.filter((terminal) => !completions.ids.has(terminal.id))
    const latestUnknownAt = completions.latestUnknownAt
    if (latestUnknownAt === null) return { confirmed: remaining, uncertain: [] }
    return {
        confirmed: remaining.filter((terminal) => terminal.startedAt > latestUnknownAt),
        uncertain: remaining.filter((terminal) => terminal.startedAt <= latestUnknownAt)
    }
}

function subagentTitle(block: ToolCallBlock): string {
    if (block.tool.name === 'CodexAgent') {
        return getCodexAgentSummary(block.tool.input) ?? 'Agent'
    }
    const explicit = getInputStringAny(block.tool.input, ['description', 'summary', 'title'])
    if (explicit) return truncate(explicit.replace(/\s+/g, ' ').trim(), 100)
    const prompt = getInputStringAny(block.tool.input, ['prompt', 'message'])
    if (prompt) return truncate(prompt.replace(/\s+/g, ' ').trim(), 100)
    return getInputStringAny(block.tool.input, ['subagent_type', 'agent_type']) ?? 'Agent'
}

function subagentFromBlock(block: ToolCallBlock): SessionStatusSubagent | null {
    if (block.tool.name !== 'CodexAgent' && !isSubagentToolName(block.tool.name)) return null
    if (block.tool.state === 'completed') return null

    const latestChild = block.children.at(-1)
    const activity = block.tool.name === 'CodexAgent'
        ? getCodexAgentActivity(block.tool.input)
        : latestChild?.kind === 'tool-call'
            ? latestChild.tool.nativeTitle ?? latestChild.tool.name
            : null
    const waiting = block.tool.state === 'pending'
        || (activity?.toLowerCase().startsWith('waiting') ?? false)

    return {
        id: block.tool.id,
        title: subagentTitle(block),
        detail: activity,
        state: block.tool.state === 'error' ? 'error' : waiting ? 'waiting' : 'running',
        startedAt: block.tool.startedAt ?? (block.tool.state === 'pending' ? null : block.createdAt),
        endedAt: block.tool.state === 'error'
            ? block.tool.completedAt ?? block.tool.startedAt ?? block.createdAt
            : null
    }
}

export function buildSessionStatusData(args: {
    goal: ThreadGoal | null | undefined
    tasks?: readonly TodoItem[] | null | undefined
    blocks: readonly ChatBlock[]
    messages: readonly NormalizedMessage[]
    backgroundTaskCount?: number
    includeSubagents?: boolean
}): SessionStatusData | null {
    const tools = collectToolBlocks(args.blocks)
    const detectedTerminals = buildBackgroundTerminals(tools, args.messages)
    const terminals = args.backgroundTaskCount === undefined
        ? [...detectedTerminals.confirmed, ...detectedTerminals.uncertain]
        : args.backgroundTaskCount > 0
            ? detectedTerminals.confirmed.slice(-args.backgroundTaskCount)
            : []
    const undiscoveredTerminalCount = args.backgroundTaskCount === undefined
        ? 0
        : Math.max(0, args.backgroundTaskCount - terminals.length)
    const possibleTerminalCommands = undiscoveredTerminalCount > 0
        ? detectedTerminals.uncertain.map((terminal) => terminal.command)
        : []
    const activeGoal = args.goal && args.goal.status !== 'complete' ? args.goal : null
    const projectedTaskIds = args.tasks && args.tasks.length > 0
        ? new Set(projectSessionTodoSnapshot(args.tasks).items.map((item) => item.id).filter(Boolean))
        : null
    const scopedTasks = args.tasks
        ? (projectedTaskIds && projectedTaskIds.size > 0
            ? args.tasks.filter((task) => !task.id || projectedTaskIds.has(task.id))
            : [...args.tasks])
        : []
    const data: SessionStatusData = {
        goal: activeGoal,
        tasks: scopedTasks,
        subagents: args.includeSubagents === false
            ? []
            : tools
                .map(subagentFromBlock)
                .filter((subagent): subagent is SessionStatusSubagent => subagent !== null),
        terminals,
        undiscoveredTerminalCount,
        possibleTerminalCommands
    }

    return data.goal
        || data.tasks.length > 0
        || data.subagents.length > 0
        || data.terminals.length > 0
        || data.undiscoveredTerminalCount > 0
        ? data
        : null
}

export function areSessionStatusDataEqual(
    a: SessionStatusData | null,
    b: SessionStatusData | null
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    if (a.undiscoveredTerminalCount !== b.undiscoveredTerminalCount) return false
    if (a.goal !== b.goal) {
        if (!a.goal || !b.goal) return false
        if (
            a.goal.text !== b.goal.text
            || a.goal.status !== b.goal.status
            || a.goal.updatedAt !== b.goal.updatedAt
        ) {
            return false
        }
    }
    if (a.tasks.length !== b.tasks.length) return false
    for (let i = 0; i < a.tasks.length; i += 1) {
        const t1 = a.tasks[i]!
        const t2 = b.tasks[i]!
        if (
            t1 !== t2
            && (
                t1.id !== t2.id
                || t1.content !== t2.content
                || t1.status !== t2.status
                || t1.priority !== t2.priority
                || t1.phaseId !== t2.phaseId
            )
        ) {
            return false
        }
    }
    if (a.subagents.length !== b.subagents.length) return false
    for (let i = 0; i < a.subagents.length; i += 1) {
        const s1 = a.subagents[i]!
        const s2 = b.subagents[i]!
        if (
            s1.id !== s2.id
            || s1.title !== s2.title
            || s1.detail !== s2.detail
            || s1.state !== s2.state
            || s1.startedAt !== s2.startedAt
            || s1.endedAt !== s2.endedAt
        ) {
            return false
        }
    }
    if (a.terminals.length !== b.terminals.length) return false
    for (let i = 0; i < a.terminals.length; i += 1) {
        const term1 = a.terminals[i]!
        const term2 = b.terminals[i]!
        if (
            term1.id !== term2.id
            || term1.command !== term2.command
            || term1.cwd !== term2.cwd
            || term1.startedAt !== term2.startedAt
        ) {
            return false
        }
    }
    if (a.possibleTerminalCommands.length !== b.possibleTerminalCommands.length) return false
    for (let i = 0; i < a.possibleTerminalCommands.length; i += 1) {
        if (a.possibleTerminalCommands[i] !== b.possibleTerminalCommands[i]) return false
    }
    return true
}
