import type { ChatToolCall, RoundSummary, ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { extractTodoChecklist } from '@/components/ToolCard/checklist'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { isObject } from '@hapi/protocol'
import type { SessionMetadataSummary } from '@/types/api'

export type TurnContentPart = {
    type: string
    text?: string
    toolCallId?: string
    toolName?: string
    result?: unknown
    isError?: boolean
    artifact?: unknown
    status?: { type?: string }
}

export type TurnTextRow = {
    kind: 'text'
    key: string
    text: string
    /** Tool commentary stays inside the fold. The answer after the last tool does not. */
    trailing: boolean
}

export type TurnToolRow = {
    kind: 'tool'
    key: string
    block: ToolCallBlock
    verb: string
    intent: string
    /** Error, pending permission, and a question waiting on the user stay visible when folded. */
    pinned: boolean
    error: boolean
    permission: boolean
}

export type TurnReasoningRow = {
    kind: 'reasoning'
    key: string
    text: string
}

export type TurnRow = TurnTextRow | TurnToolRow | TurnReasoningRow

export type TurnPartition = {
    rows: TurnRow[]
    title: string
    hasFoldable: boolean
    hasPinned: boolean
    hasActivity: boolean
    streaming: boolean
}

const TODO_TOOL_NAMES: Record<string, true> = { TodoWrite: true, todo_write: true }

const PLAN_TOOL_NAMES: Record<string, true> = {
    TodoWrite: true,
    todo_write: true,
    update_plan: true,
    ExitPlanMode: true,
    exit_plan_mode: true,
    CodexReasoning: true,
}

const MILESTONE_TOOL_NAMES: Record<string, true> = {
    TeamCreate: true,
    TeamDelete: true,
    SendMessage: true,
    AgyTaskLog: true,
    Skill: true,
    spawn_agent: true,
    send_input: true,
    send_message: true,
    resume_agent: true,
    followup_task: true,
    wait_agent: true,
    close_agent: true,
    interrupt_agent: true,
    list_agents: true,
}
function stringField(value: unknown, keys: string[]): string | null {
    return getInputStringAny(value, keys)
}

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).find((part) => part.trim().length > 0) ?? ''
    return line.trim()
}

function sameText(left: string | null, right: string | null): boolean {
    if (!left || !right) return false
    return left.trim() === right.trim()
}

function commandOrPath(tool: ChatToolCall): string | null {
    return stringField(tool.input, ['command', 'cmd', 'file_path', 'path', 'pattern'])
}

function intentSentence(tool: ChatToolCall): string | null {
    const command = commandOrPath(tool)
    const candidates = [
        tool.nativeTitle,
        stringField(tool.input, ['i', 'intent', 'description']),
        tool.description,
    ]
    for (const candidate of candidates) {
        const text = typeof candidate === 'string' ? candidate.trim() : ''
        if (!text || sameText(text, command)) continue
        return firstLine(text)
    }
    return null
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
    return parts[parts.length - 1] ?? path
}

function verbFor(tool: ChatToolCall, fallbackTitle: string): string {
    if (tool.name === 'Read') return 'Read'
    if (tool.name === 'Grep') return 'Grep'
    if (tool.name === 'Glob') return 'Glob'
    if (tool.name === 'Bash' || tool.name === 'CodexBash') return 'Ran'
    if (tool.name === 'Edit' || tool.name === 'MultiEdit' || tool.name === 'Write') return tool.name === 'Write' ? 'Wrote' : 'Edit'
    if (isSubagentToolName(tool.name)) return 'Ran agent'
    if (TODO_TOOL_NAMES[tool.name]) return 'Todo'
    if (tool.name === 'CodexReasoning') return 'Reasoning'
    return fallbackTitle
}

function intentFor(tool: ChatToolCall, verb: string, fallbackTitle: string): string {
    if (tool.name === 'Read') {
        const file = stringField(tool.input, ['file_path', 'path'])
        return intentSentence(tool) ?? (file ? basename(file) : fallbackTitle)
    }
    if (tool.name === 'Bash' || tool.name === 'CodexBash' || tool.name === 'Grep' || tool.name === 'Glob') {
        return intentSentence(tool) ?? fallbackTitle
    }
    if (tool.name === 'Edit' || tool.name === 'MultiEdit' || tool.name === 'Write') {
        const file = stringField(tool.input, ['file_path', 'path'])
        return intentSentence(tool) ?? (file ? basename(file) : fallbackTitle)
    }
    return intentSentence(tool) ?? (fallbackTitle === verb ? '' : fallbackTitle)
}

export function newTodoTexts(tool: ChatToolCall): string[] {
    if (!TODO_TOOL_NAMES[tool.name]) return []
    if (isObject(tool.input) && Array.isArray(tool.input.todos) && tool.input.todos.length > 0) return []
    const result = tool.result
    if (!isObject(result) || !Array.isArray(result.newTodos)) return []
    return extractTodoChecklist(tool.input, result).map((item) => item.text).filter((text) => text.trim().length > 0)
}

function needsUser(tool: ChatToolCall): boolean {
    if (isAskUserQuestionToolName(tool.name) || isRequestUserInputToolName(tool.name)) return true
    if (tool.name === 'CodexPermission') return true
    return tool.permission?.status === 'pending'
}

function isPinned(tool: ChatToolCall): boolean {
    if (tool.state === 'error') return true
    if (needsUser(tool)) return true
    if (isSubagentToolName(tool.name) || MILESTONE_TOOL_NAMES[tool.name]) return true
    if (PLAN_TOOL_NAMES[tool.name] && tool.name !== 'CodexReasoning') return true
    return false
}

function isToolGroup(part: TurnContentPart): part is TurnContentPart & { artifact: ToolGroupBlock } {
    return part.type === 'tool-call' && part.toolName === 'ToolGroup' && isObject(part.artifact) && part.artifact.kind === 'tool-group'
}

function isToolCall(part: TurnContentPart): part is TurnContentPart & { artifact: ToolCallBlock } {
    return part.type === 'tool-call'
        && part.toolName !== 'ToolGroup'
        && isObject(part.artifact)
        && part.artifact.kind === 'tool-call'
}

function toolRows(block: ToolCallBlock, metadata: SessionMetadataSummary | null): TurnToolRow[] {
    const added = newTodoTexts(block.tool)
    if (added.length > 0) {
        return added.map((text, index) => ({
            kind: 'tool',
            key: `${block.id}:added:${index}`,
            block,
            verb: 'Added task',
            intent: text,
            pinned: false,
            error: false,
            permission: false,
        }))
    }

    const presentation = getToolPresentation({
        toolName: block.tool.name,
        input: block.tool.input,
        result: block.tool.result,
        childrenCount: block.children.length,
        description: block.tool.nativeTitle ?? block.tool.description,
        metadata,
    })
    const verb = verbFor(block.tool, presentation.title)
    return [{
        kind: 'tool',
        key: block.id,
        block,
        verb,
        intent: intentFor(block.tool, verb, presentation.title),
        pinned: isPinned(block.tool),
        error: block.tool.state === 'error',
        permission: block.tool.permission?.status === 'pending',
    }]
}

function activityTitle(part: TurnContentPart): string | null {
    if (isToolGroup(part)) {
        const title = part.artifact.activityTitle
        return typeof title === 'string' && title.trim() ? firstLine(title) : null
    }
    if (!isToolCall(part) || part.artifact.tool.name !== 'CodexReasoning') return null
    const title = stringField(part.artifact.tool.input, ['title'])
    return title ? firstLine(title) : null
}

export function partitionTurn(
    parts: readonly TurnContentPart[],
    metadata: SessionMetadataSummary | null
): TurnPartition {
    const rows: TurnRow[] = []
    let streaming = false
    const titles: string[] = []

    parts.forEach((part, index) => {
        if (part.status?.type === 'running') streaming = true
        const titled = activityTitle(part)
        if (titled) titles.push(titled)

        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
            rows.push({ kind: 'reasoning', key: `reasoning:${index}`, text: part.text.trim() })
            return
        }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            rows.push({ kind: 'text', key: `text:${index}`, text: part.text.trim(), trailing: false })
            return
        }
        if (isToolGroup(part)) {
            for (const tool of part.artifact.tools) rows.push(...toolRows(tool, metadata))
            return
        }
        if (isToolCall(part)) {
            if (part.artifact.tool.name === 'CodexReasoning') return
            rows.push(...toolRows(part.artifact, metadata))
        }
    })

    let lastTool = -1
    rows.forEach((row, index) => {
        if (row.kind === 'tool') lastTool = index
    })
    for (let index = lastTool + 1; index < rows.length; index += 1) {
        const row = rows[index]
        if (row.kind === 'text') row.trailing = true
    }

    const foldable = rows.filter((row) => {
        if (row.kind === 'text') return !row.trailing
        if (row.kind === 'tool') return !row.pinned
        return true
    })
    const tools = rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const running = tools.find((row) => row.block.tool.state === 'running' || row.block.tool.state === 'pending')
    const reasoning = rows.find((row): row is TurnReasoningRow => row.kind === 'reasoning')
    const title = titles[0]
        ?? (reasoning ? firstLine(reasoning.text) : null)
        ?? running?.intent
        ?? running?.verb
        ?? tools[tools.length - 1]?.intent
        ?? tools[tools.length - 1]?.verb
        ?? ''

    return {
        rows,
        title,
        hasFoldable: foldable.length > 0,
        hasPinned: rows.some((row) => row.kind === 'tool' && row.pinned),
        hasActivity: rows.some((row) => row.kind === 'reasoning' || row.kind === 'tool'),
        streaming,
    }
}

export function turnDurationMs(input: {
    roundSummary?: RoundSummary | null
    invokedAt?: number | null
    createdAt?: number | null
    now: number
    streaming: boolean
}): number | null {
    const reported = input.roundSummary?.durationMs
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return reported
    if (typeof input.invokedAt !== 'number' || !Number.isFinite(input.invokedAt)) return null
    const end = input.streaming ? input.now : input.createdAt
    if (typeof end !== 'number' || !Number.isFinite(end)) return null
    const elapsed = end - input.invokedAt
    return elapsed >= 0 ? elapsed : null
}
