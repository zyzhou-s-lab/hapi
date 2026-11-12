import type { AssistantContentPhase, ChatToolCall, GeneratedFileBlock, GeneratedImageBlock, RoundSummary, ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import {
    projectSessionTodoSnapshot,
    projectToolTodoSnapshot,
    resolveTodoToolKind,
} from '@/chat/projections/todoProjection'
import {
    extractTodoChecklist,
    type TodoCardItem,
} from '@/components/ToolCard/checklist'
import { classifyToolPresentation } from '@/components/AssistantChat/messages/toolPresentationManifest'
import { findMatchingToolPreviewPlugin } from '@/components/AssistantChat/messages/toolPreviewRegistry'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { resolveToolViewName } from '@/components/ToolCard/toolNameAliases'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { isObject } from '@hapi/protocol'
import type { SessionMetadataSummary, TodoItem } from '@/types/api'
export type TurnContentPart = {
    type: string
    blockId?: string
    text?: string
    phase?: AssistantContentPhase
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
    blockId?: string
    text: string
    /** Tool commentary stays inside the fold. The answer after the last tool does not. */
    trailing: boolean
    phase?: AssistantContentPhase
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
    blockId?: string
    text: string
}

export type TurnImageRow = {
    kind: 'image'
    key: string
    block: GeneratedImageBlock
}

export type TurnFileRow = {
    kind: 'file'
    key: string
    block: GeneratedFileBlock
}

export type TurnRow = TurnTextRow | TurnToolRow | TurnReasoningRow | TurnImageRow | TurnFileRow

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

export function parseAgentUriTarget(path: string | null | undefined): string | null {
    if (typeof path !== 'string') return null
    const trimmed = path.trim()
    if (!trimmed.startsWith('agent://')) return null
    const target = trimmed.slice('agent://'.length).split('/')[0]?.trim() ?? ''
    return target || 'agent'
}

function isSubagentTool(rawName: string, resolvedName: string): boolean {
    return isSubagentToolName(rawName) || isSubagentToolName(resolvedName)
}

export function normalizeReadFilePath(rawPath: string): {
    basePath: string
    fileName: string
    selector: string | null
} {
    const trimmed = rawPath.trim()
    if (!trimmed) return { basePath: '', fileName: '', selector: null }
    let working = trimmed
    let selector: string | null = null
    const queryIdx = working.indexOf('?')
    if (queryIdx > 0) {
        selector = working.slice(queryIdx)
        working = working.slice(0, queryIdx)
    }
    const rangeMatch = working.match(/^(.+?)(:raw(?::-?\d+(?:-\d+)?)?|:-?\d+(?:-\d+)?)$/)
    if (rangeMatch && rangeMatch[1]) {
        working = rangeMatch[1]
        selector = `${rangeMatch[2]}${selector ?? ''}`
    }
    return {
        basePath: working,
        fileName: basename(working),
        selector,
    }
}

export function extractSubagentNames(tool: ChatToolCall): string[] {
    const names: string[] = []
    const addName = (candidate: unknown) => {
        if (typeof candidate !== 'string') return
        const clean = candidate.trim()
        if (!clean || clean === 'all' || clean === 'agent') return
        if (!names.includes(clean)) names.push(clean)
    }
    if (tool.name.startsWith('Agent:') || tool.name.startsWith('Task:')) {
        addName(tool.name.slice(tool.name.indexOf(':') + 1))
    }
    if (isObject(tool.input)) {
        if (Array.isArray(tool.input.tasks)) {
            for (const item of tool.input.tasks) {
                if (isObject(item)) {
                    addName(item.name ?? item.agent)
                }
            }
        }
        addName(stringField(tool.input, ['name', 'task_name']))
    }
    const uriTarget = parseAgentUriTarget(stringField(tool.input, ['file_path', 'path', 'to']))
    if (uriTarget) addName(uriTarget)
    return names
}

function verbFor(tool: ChatToolCall, fallbackTitle: string): string {
    const rawLower = tool.name.toLowerCase()
    const name = resolveToolViewName(tool.name)
    if (rawLower === 'wait') return 'turn.verb.wait'
    if (rawLower === 'delete') return 'turn.verb.delete'
    if (rawLower === 'write_stdin') return 'turn.verb.stdin'
    if (rawLower === 'kill_session') return 'turn.verb.killSession'
    if (name === 'Read') return 'turn.verb.read'
    if (name === 'Grep') return 'turn.verb.grep'
    if (name === 'Glob') return 'turn.verb.glob'
    if (name === 'Bash' || name === 'CodexBash') return 'turn.verb.ran'
    if (name === 'Write' && parseAgentUriTarget(stringField(tool.input, ['file_path', 'path']))) {
        return 'turn.verb.messagedAgent'
    }
    if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') return name === 'Write' ? 'turn.verb.wrote' : 'turn.verb.edit'
    if (isSubagentTool(tool.name, name)) return 'turn.verb.ranAgent'
    if (TODO_TOOL_NAMES[name] || TODO_TOOL_NAMES[tool.name]) return 'turn.verb.todo'
    if (name === 'CodexReasoning') return 'turn.verb.reasoning'
    if (tool.name === 'ContextCompaction') return 'turn.verb.compaction'
    return fallbackTitle
}

function extractCompactionIntent(input: unknown): string {
    if (!isObject(input)) return ''
    const frame = isObject(input.frame) ? input.frame : null
    const strategy = stringField(input, ['action', 'strategy']) ?? stringField(frame, ['action', 'strategy'])
    const reason = stringField(input, ['reason', 'trigger']) ?? stringField(frame, ['reason', 'trigger'])
    const phase = typeof input.phase === 'string'
        ? input.phase
        : frame?.type === 'auto_compaction_start'
            ? 'started'
            : null
    if (phase === 'started') {
        return [strategy, reason?.replaceAll('-', ' ')].filter(Boolean).join(' · ')
    }
    return strategy ?? (reason && reason !== 'auto' ? reason.replaceAll('-', ' ') : '')
}


const SUBAGENT_INTENT_LIMIT = 80
const TITLE_LIMIT = 80

function stripMarkdownLine(line: string): string {
    return line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/[`*_]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function plainSubagentLabel(value: string): string {
    const lines = value
        .split(/\r?\n/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^-{3,}$/.test(part))
    if (lines.length === 0) return ''
    const heading = /^\s{0,3}#{1,6}\s+/.test(lines[0] ?? '')
    const body = heading
        ? lines.slice(1).map(stripMarkdownLine).find((line) => line.length > 0)
        : stripMarkdownLine(lines[0] ?? '')
    const label = body || stripMarkdownLine(lines[0] ?? '')
    if (!label) return ''
    return truncate(label, SUBAGENT_INTENT_LIMIT)
}

export function extractThoughtSummary(text: string, maxLength = 72): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => stripMarkdownLine(line))
        .filter((line) => line.length > 0 && !/^-{3,}$/.test(line))
    if (lines.length === 0) return ''
    return truncate(lines[0]!, maxLength)
}

function subagentIntent(tool: ChatToolCall): string | null {
    const candidates = [
        stringField(tool.input, ['description', 'name', 'task_name', 'summary', 'title', 'task', 'i', 'intent']),
        tool.description,
        tool.nativeTitle,
        stringField(tool.input, ['prompt', 'message']),
    ]
    for (const candidate of candidates) {
        if (!candidate) continue
        const label = plainSubagentLabel(candidate)
        if (label) return label
    }
    return null
}

function intentFor(tool: ChatToolCall, verb: string, fallbackTitle: string): string {
    const name = resolveToolViewName(tool.name)
    if (tool.name === 'ContextCompaction') {
        return extractCompactionIntent(tool.input)
    }
    if (isSubagentTool(tool.name, name)) {
        return subagentIntent(tool) ?? (fallbackTitle === verb ? '' : fallbackTitle)
    }
    if (name === 'Read') {
        const file = stringField(tool.input, ['file_path', 'path'])
        return intentSentence(tool) ?? (file ? basename(file) : fallbackTitle)
    }
    if (name === 'Bash' || name === 'CodexBash' || name === 'Grep' || name === 'Glob') {
        return intentSentence(tool) ?? fallbackTitle
    }
    if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
        const file = stringField(tool.input, ['file_path', 'path'])
        return intentSentence(tool) ?? (file ? basename(file) : fallbackTitle)
    }
    return intentSentence(tool) ?? (fallbackTitle === verb ? '' : fallbackTitle)
}

export function newTodoTexts(tool: ChatToolCall): string[] {
    const name = resolveToolViewName(tool.name)
    if (!TODO_TOOL_NAMES[name] && !TODO_TOOL_NAMES[tool.name]) return []
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

function isPinned(tool: ChatToolCall, errorRecovered = false): boolean {
    const name = resolveToolViewName(tool.name)
    if (tool.state === 'error') return !errorRecovered
    if (needsUser(tool)) return true
    if (isSubagentTool(tool.name, name) || MILESTONE_TOOL_NAMES[name] || MILESTONE_TOOL_NAMES[tool.name]) return true
    if ((PLAN_TOOL_NAMES[name] || PLAN_TOOL_NAMES[tool.name]) && name !== 'CodexReasoning') return true
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

function isGeneratedImage(part: TurnContentPart): part is TurnContentPart & { artifact: GeneratedImageBlock } {
    return part.type === 'tool-call' && isObject(part.artifact) && part.artifact.kind === 'generated-image'
}

function isGeneratedFile(part: TurnContentPart): part is TurnContentPart & { artifact: GeneratedFileBlock } {
    return part.type === 'tool-call' && isObject(part.artifact) && part.artifact.kind === 'generated-file'
}

function shownTitle(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text.length > 0 ? text : null
}

function toolRows(block: ToolCallBlock, metadata: SessionMetadataSummary | null): TurnToolRow[] {
    const added = newTodoTexts(block.tool)
    if (added.length > 0) {
        return added.map((text, index) => ({
            kind: 'tool',
            key: `${block.id}:added:${index}`,
            block,
            verb: 'turn.verb.addedTask',
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

/** Re-derive labels and interaction flags whenever a row's live tool changes. */
export function resolveLiveToolRow(row: TurnToolRow, block: ToolCallBlock, metadata: SessionMetadataSummary | null): TurnToolRow {
    if (row.block === block) return row
    const derived = toolRows(block, metadata)
    return derived.find((candidate) => candidate.key === row.key) ?? derived[0] ?? { ...row, block }
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

function areTurnRowsEqual(a: TurnRow, b: TurnRow): boolean {
    if (a === b) return true
    if (a.kind !== b.kind || a.key !== b.key) return false
    switch (a.kind) {
        case 'reasoning': {
            const other = b as TurnReasoningRow
            return a.text === other.text && a.blockId === other.blockId
        }
        case 'text': {
            const other = b as TurnTextRow
            return a.text === other.text && a.trailing === other.trailing && a.phase === other.phase && a.blockId === other.blockId
        }
        case 'tool': {
            const other = b as TurnToolRow
            return a.block === other.block
                && a.verb === other.verb
                && a.intent === other.intent
                && a.pinned === other.pinned
                && a.error === other.error
                && a.permission === other.permission
        }
        case 'image':
        case 'file':
            return a.block === (b as TurnImageRow | TurnFileRow).block
    }
}

function isSameRefArray<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (!Object.is(a[i], b[i])) return false
    }
    return true
}

export function deriveTurnRowsTitle(rows: readonly TurnRow[]): string {
    const tools = rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const running = tools.find((row) => row.block.tool.state === 'pending')
        ?? tools.findLast((row) => row.block.tool.state === 'running')
    const reasoning = rows.findLast((row): row is TurnReasoningRow => row.kind === 'reasoning')
    const lastIntent = tools.findLast((row) => shownTitle(row.intent) !== null)
    return shownTitle(running?.intent)
        ?? shownTitle(lastIntent?.intent)
        ?? shownTitle(reasoning ? truncate(stripMarkdownLine(firstLine(reasoning.text)), TITLE_LIMIT) : null)
        ?? shownTitle(running?.verb)
        ?? shownTitle(tools[tools.length - 1]?.verb)
        ?? ''
}

export function partitionTurn(
    parts: readonly TurnContentPart[],
    metadata: SessionMetadataSummary | null,
    previousPartition?: TurnPartition | null
): TurnPartition {
    const rows: TurnRow[] = []
    let streaming = false
    const titles: string[] = []

    parts.forEach((part, index) => {
        if (part.status?.type === 'running') streaming = true
        const titled = activityTitle(part)
        if (titled) titles.push(titled)

        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
            rows.push({
                kind: 'reasoning',
                key: part.blockId && part.blockId.length > 0 ? part.blockId : `reasoning:${index}`,
                text: part.text.trim(),
                ...(part.blockId !== undefined ? { blockId: part.blockId } : {}),
            })
            return
        }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            const phase = part.phase === 'execution' || part.phase === 'final_answer' ? part.phase : undefined
            rows.push({
                kind: 'text',
                key: part.blockId && part.blockId.length > 0 ? part.blockId : `text:${index}`,
                text: part.text.trim(),
                trailing: false,
                ...(phase !== undefined ? { phase } : {}),
                ...(part.blockId !== undefined ? { blockId: part.blockId } : {}),
            })
            return
        }
        if (isToolGroup(part)) {
            for (const tool of part.artifact.tools) rows.push(...toolRows(tool, metadata))
            return
        }
        if (isToolCall(part)) {
            if (part.artifact.tool.name === 'CodexReasoning') return
            rows.push(...toolRows(part.artifact, metadata))
            return
        }
        if (isGeneratedImage(part)) {
            rows.push({ kind: 'image', key: part.artifact.id, block: part.artifact })
            return
        }
        if (isGeneratedFile(part)) {
            rows.push({ kind: 'file', key: part.artifact.id, block: part.artifact })
        }
    })

    const isSubRoundStep = ( candidate: TurnRow ): boolean =>
        (candidate.kind === 'tool' && candidate.block.tool.name !== 'ContextCompaction')
        || candidate.kind === 'image'
        || candidate.kind === 'file'
    const isCompactionBoundary = ( candidate: TurnRow ): boolean =>
        candidate.kind === 'tool' && candidate.block.tool.name === 'ContextCompaction'

    rows.forEach((row, index) => {
        if (row.kind !== 'text') return
        if (row.phase === 'execution') {
            row.trailing = false
            return
        }
        let boundaryIndex = rows.length
        for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
            if (isCompactionBoundary(rows[cursor]!)) {
                boundaryIndex = cursor
                break
            }
        }
        const hasStepBeforeBoundary = rows
            .slice(index + 1, boundaryIndex)
            .some(isSubRoundStep)
        if (row.phase === 'final_answer') {
            row.trailing = !hasStepBeforeBoundary
            return
        }
        if (!hasStepBeforeBoundary) {
            row.trailing = true
        }
    })

    const hasPendingTool = rows.some((row) => row.kind === 'tool' && row.block.tool.state === 'pending')
    rows.forEach((row, index) => {
        if (row.kind !== 'tool' || !row.error || hasPendingTool) return
        const recovered = rows
            .slice(index + 1)
            .some((later) => later.kind === 'tool' && (later.block.tool.state === 'completed' || later.block.tool.state === 'running'))
        if (recovered) {
            row.pinned = isPinned(row.block.tool, true)
        }
    })

    for (const verb of ['turn.verb.todo', 'turn.verb.plan'] as const) {
        let latestPinnedIndex = -1
        rows.forEach((row, index) => {
            if (row.kind === 'tool' && row.pinned && !row.error && row.verb === verb) {
                latestPinnedIndex = index
            }
        })
        if (latestPinnedIndex >= 0) {
            rows.forEach((row, index) => {
                if (index < latestPinnedIndex && row.kind === 'tool' && row.pinned && !row.error && row.verb === verb) {
                    row.pinned = false
                }
            })
        }
    }

    const foldable = rows.filter((row) => {
        if (row.kind === 'text') return !row.trailing
        if (row.kind === 'tool') return !row.pinned
        if (row.kind === 'image' || row.kind === 'file') return false
        return true
    })
    // Reasoning prose is a fallback: an opening thought ("I'm thinking through…") says
    // less than the tool intent, and a long paragraph would overflow the header.
    const title = shownTitle(titles[0]) ?? deriveTurnRowsTitle(rows)

    let stabilizedRows = rows
    if (previousPartition) {
        const prevByKey = new Map<string, TurnRow>()
        for (const prevRow of previousPartition.rows) {
            prevByKey.set(prevRow.key, prevRow)
        }
        const nextRows = rows.map((row) => {
            const prevRow = prevByKey.get(row.key)
            return prevRow && areTurnRowsEqual(prevRow, row) ? prevRow : row
        })
        stabilizedRows = isSameRefArray(nextRows, previousPartition.rows)
            ? previousPartition.rows
            : nextRows
    }

    const nextPartition: TurnPartition = {
        rows: stabilizedRows,
        title,
        hasFoldable: foldable.length > 0,
        hasPinned: stabilizedRows.some((row) => row.kind === 'tool' && row.pinned),
        hasActivity: stabilizedRows.some((row) => row.kind === 'reasoning' || row.kind === 'tool' || row.kind === 'image' || row.kind === 'file' || (row.kind === 'text' && row.phase === 'execution')),
        streaming,
    }
    if (
        previousPartition
        && previousPartition.rows === nextPartition.rows
        && previousPartition.title === nextPartition.title
        && previousPartition.hasFoldable === nextPartition.hasFoldable
        && previousPartition.hasPinned === nextPartition.hasPinned
        && previousPartition.hasActivity === nextPartition.hasActivity
        && previousPartition.streaming === nextPartition.streaming
    ) {
        return previousPartition
    }
    return nextPartition
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

export type TurnActionCounts = {
    commands: number
    reads: number
    edits: number
    searches: number
    webSearches: number
    webFetches: number
    agents: number
    thoughts: number
    compactions?: number
}

export type TurnWebSearchResultItem = {
    title: string
    url: string
    domain: string
    faviconUrl?: string
}

export type TurnDiffLine = {
    type: 'ctx' | 'add' | 'del'
    text: string
}

export type TurnStepPreview =
    | {
        kind: 'bash'
        command: string
        description: string | null
        output: string
        isError: boolean
    }
    | {
        kind: 'web-fetch'
        title: string
        url: string
        domain: string
        excerpt: string
        sizeLabel: string
        linesCount: number
    }
    | {
        kind: 'web-search'
        query: string
        results: TurnWebSearchResultItem[]
    }
    | {
        kind: 'file-diff'
        filePath: string
        added: number
        removed: number
        lines: TurnDiffLine[]
    }
    | {
        kind: 'file-read'
        filePath: string
        content: string
        lineCount: number
    }
    | {
        kind: 'compaction'
        strategy: string | null
        trigger: string | null
        tokensBeforeLabel: string | null
        archiveLabel: string | null
        summary: string | null
        errorMessage: string | null
        isRunning: boolean
    }
    | {
        kind: 'default'
        block: ToolCallBlock
    }

export type TurnToolStepDescriptor = {
    isRunning: boolean
    isQueued?: boolean
    verbLabel: string
    intentLabel: string
    secondaryBadge: string | null
    preview: TurnStepPreview
}

export function extractDomain(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl)
        return parsed.hostname.replace(/^www\./, '')
    } catch {
        return rawUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] ?? rawUrl
    }
}

export function extractResultText(result: unknown): string {
    if (typeof result === 'string') return result
    if (!isObject(result)) return ''
    if (typeof result.stdout === 'string' && result.stdout.trim()) {
        return typeof result.stderr === 'string' && result.stderr.trim()
            ? `${result.stdout}\n${result.stderr}`
            : result.stdout
    }
    if (typeof result.output === 'string') return result.output
    if (typeof result.content === 'string') return result.content
    if (typeof result.text === 'string') return result.text
    if (Array.isArray(result.content)) {
        const parts = result.content
            .map((item) => (isObject(item) && typeof item.text === 'string' ? item.text : ''))
            .filter((part) => part.length > 0)
        if (parts.length > 0) return parts.join('\n')
    }
    return ''
}

export function extractWebSearchResults(result: unknown): TurnWebSearchResultItem[] {
    if (!isObject(result)) return []
    const rawList = Array.isArray(result.results)
        ? result.results
        : Array.isArray(result.content)
            ? result.content
            : []
    const items: TurnWebSearchResultItem[] = []
    for (const entry of rawList) {
        if (!isObject(entry)) continue
        const url = typeof entry.url === 'string' ? entry.url : ''
        const title = typeof entry.title === 'string' ? entry.title : url
        if (!title && !url) continue
        const domain = typeof entry.domain === 'string' && entry.domain
            ? entry.domain
            : url
                ? extractDomain(url)
                : ''
        const faviconUrl = typeof entry.faviconUrl === 'string'
            ? entry.faviconUrl
            : typeof entry.favicon_url === 'string'
                ? entry.favicon_url
                : undefined
        items.push({ title, url, domain, faviconUrl })
    }
    return items
}

export function isWebFetchTool(rawName: string, resolvedName: string): boolean {
    const lower = rawName.toLowerCase()
    return resolvedName === 'WebFetch' || lower === 'webfetch' || lower === 'web_fetch' || lower.endsWith('__web_fetch')
}

export function isWebSearchTool(rawName: string, resolvedName: string): boolean {
    const lower = rawName.toLowerCase()
    return resolvedName === 'WebSearch' || lower === 'websearch' || lower === 'web_search' || lower === 'web_search_fast' || lower.endsWith('__web_search')
}

export function countTurnActions(rows: readonly TurnRow[]): TurnActionCounts {
    const counts: TurnActionCounts = {
        commands: 0,
        reads: 0,
        edits: 0,
        searches: 0,
        webSearches: 0,
        webFetches: 0,
        agents: 0,
        thoughts: 0,
        compactions: 0,
    }
    const hasChildAgentRows = rows.some(
        (row) => row.kind === 'tool' && (row.block.tool.name.startsWith('Agent:') || row.block.tool.name.startsWith('Task:'))
    )
    let hasAgentMessage = false
    for (const row of rows) {
        if (row.kind === 'reasoning') {
            counts.thoughts += 1
            continue
        }
        if (row.kind !== 'tool') continue
        const rawName = row.block.tool.name
        const rawLower = rawName.toLowerCase()
        const name = resolveToolViewName(rawName)
        if (
            TODO_TOOL_NAMES[name]
            || TODO_TOOL_NAMES[rawName]
            || isAskUserQuestionToolName(rawName)
            || isRequestUserInputToolName(rawName)
            || rawLower === 'wait'
        ) {
            continue
        }
        if (rawName === 'ContextCompaction') {
            counts.compactions = (counts.compactions ?? 0) + 1
            continue
        }
        if (name === 'Write' && parseAgentUriTarget(stringField(row.block.tool.input, ['file_path', 'path']))) {
            hasAgentMessage = true
            continue
        }
        if (rawLower === 'delete') {
            counts.edits += 1
        } else if (isWebFetchTool(rawName, name)) {
            counts.webFetches += 1
        } else if (isWebSearchTool(rawName, name)) {
            counts.webSearches += 1
        } else if (name === 'Bash' || name === 'CodexBash') {
            counts.commands += 1
        } else if (name === 'Read') {
            counts.reads += 1
        } else if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
            counts.edits += 1
        } else if (name === 'Grep' || name === 'Glob') {
            counts.searches += 1
        } else if (isSubagentTool(rawName, name)) {
            const tasksList = isObject(row.block.tool.input) && Array.isArray(row.block.tool.input.tasks)
                ? row.block.tool.input.tasks
                : null
            counts.agents += !hasChildAgentRows && tasksList && tasksList.length > 1 ? tasksList.length : 1
        } else {
            counts.commands += 1
        }
    }
    if (hasAgentMessage && counts.agents === 0) {
        counts.agents = 1
    }
    return counts
}

function capitalizeFirst(text: string): string {
    if (!text) return text
    return text.charAt(0).toUpperCase() + text.slice(1)
}

export function formatTurnAggregatedSummary(
    counts: TurnActionCounts,
    lang: 'en' | 'zh-CN' = 'en'
): string {
    if (lang === 'zh-CN') {
        const parts: string[] = []
        if (counts.commands > 0) parts.push(`运行了 ${counts.commands} 个命令`)
        if (counts.reads > 0) parts.push(`查看了 ${counts.reads} 个文件`)
        if (counts.edits > 0) parts.push(`编辑了 ${counts.edits} 个文件`)
        if (counts.searches > 0) parts.push(`搜索了 ${counts.searches} 次文件`)
        if (counts.webFetches > 0) parts.push(`抓取了 ${counts.webFetches} 个页面`)
        if (counts.webSearches > 0) parts.push(`搜索了 ${counts.webSearches} 次网页`)
        if (counts.agents > 0) parts.push(`运行了 ${counts.agents} 个子代理`)
        if ((counts.compactions ?? 0) > 0) {
            parts.push(counts.compactions === 1 ? '压缩了上下文' : `压缩了 ${counts.compactions} 次上下文`)
        }
        if (parts.length === 0) return counts.thoughts > 0 ? '已思考' : '已完成步骤'
        if (parts.length === 1) return parts[0]!
        return `${parts.slice(0, -1).join('，')}，并${parts[parts.length - 1]}`
    }

    const clauses: string[] = []
    if (counts.commands > 0) {
        clauses.push(counts.commands === 1 ? 'ran a command' : `ran ${counts.commands} commands`)
    }
    if (counts.reads > 0) {
        clauses.push(counts.reads === 1 ? 'viewed a file' : `viewed ${counts.reads} files`)
    }
    if (counts.edits > 0) {
        clauses.push(counts.edits === 1 ? 'edited a file' : `edited ${counts.edits} files`)
    }
    if (counts.searches > 0) {
        clauses.push(counts.searches === 1 ? 'searched files' : `searched files ${counts.searches} times`)
    }
    if (counts.webFetches > 0) {
        clauses.push(counts.webFetches === 1 ? 'fetched a page' : `fetched ${counts.webFetches} pages`)
    }
    if (counts.webSearches > 0) {
        clauses.push(counts.webSearches === 1 ? 'searched the web' : `searched the web ${counts.webSearches} times`)
    }
    if (counts.agents > 0) {
        clauses.push(counts.agents === 1 ? 'ran an agent' : `ran ${counts.agents} agents`)
    }
    if ((counts.compactions ?? 0) > 0) {
        clauses.push(counts.compactions === 1 ? 'compacted conversation' : `compacted conversation ${counts.compactions} times`)
    }

    if (clauses.length === 0) {
        return counts.thoughts > 0 ? 'Thought' : 'Completed steps'
    }
    if (clauses.length === 1) {
        return capitalizeFirst(clauses[0]!)
    }
    if (clauses.length === 2) {
        return capitalizeFirst(`${clauses[0]} and ${clauses[1]}`)
    }
    return capitalizeFirst(`${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`)
}

function translateTurnVerbKey(
    verb: string,
    isRunning: boolean,
    isQueued: boolean,
    zh: boolean
): string {
    switch (verb) {
        case 'turn.verb.todo':
            return zh
                ? (isRunning ? '正在更新待办' : isQueued ? '待更新待办' : '已更新待办')
                : (isRunning ? 'Updating todos' : isQueued ? 'Queued todos' : 'Updated todos')
        case 'turn.verb.addedTask':
            return zh
                ? (isRunning ? '正在添加待办' : isQueued ? '待添加待办' : '已添加待办')
                : (isRunning ? 'Adding todo' : isQueued ? 'Queued todo' : 'Added todo')
        case 'turn.verb.reasoning':
            return zh
                ? (isRunning ? '正在思考' : '思考过程')
                : (isRunning ? 'Thinking' : 'Thought')
        case 'turn.verb.read':
            return zh
                ? (isRunning ? '正在查看' : isQueued ? '待查看' : '已查看')
                : (isRunning ? 'Viewing' : isQueued ? 'Queued view' : 'Viewed')
        case 'turn.verb.grep':
        case 'turn.verb.glob':
            return zh
                ? (isRunning ? '正在搜索' : isQueued ? '待搜索' : '已搜索')
                : (isRunning ? 'Searching' : isQueued ? 'Queued search' : 'Searched')
        case 'turn.verb.ran':
            return zh
                ? (isRunning ? '正在运行' : isQueued ? '待运行' : '已运行')
                : (isRunning ? 'Running' : isQueued ? 'Queued' : 'Ran')
        case 'turn.verb.wrote':
            return zh
                ? (isRunning ? '正在创建' : isQueued ? '待创建' : '已创建')
                : (isRunning ? 'Creating' : isQueued ? 'Queued create' : 'Created')
        case 'turn.verb.edit':
            return zh
                ? (isRunning ? '正在编辑' : isQueued ? '待编辑' : '已编辑')
                : (isRunning ? 'Editing' : isQueued ? 'Queued edit' : 'Edited')
        case 'turn.verb.ranAgent':
            return zh
                ? (isRunning ? '正在运行代理' : isQueued ? '待运行代理' : '已运行代理')
                : (isRunning ? 'Running agent' : isQueued ? 'Queued agent' : 'Ran agent')
        case 'turn.verb.compaction':
            return zh
                ? (isRunning ? '正在压缩上下文' : isQueued ? '待压缩上下文' : '已压缩上下文')
                : (isRunning ? 'Compacting conversation' : isQueued ? 'Queued compaction' : 'Compacted conversation')
        case 'turn.verb.messagedAgent':
            return zh
                ? (isRunning ? '正在通知代理' : isQueued ? '待通知代理' : '已通知代理')
                : (isRunning ? 'Messaging' : isQueued ? 'Queued message' : 'Messaged')
        case 'turn.verb.wait':
            return zh
                ? (isRunning ? '正在等待代理完成' : isQueued ? '待等待' : '已等待代理完成')
                : (isRunning ? 'Waiting for agents' : isQueued ? 'Queued wait' : 'Waited for agents')
        case 'turn.verb.delete':
            return zh
                ? (isRunning ? '正在删除' : isQueued ? '待删除' : '已删除')
                : (isRunning ? 'Deleting' : isQueued ? 'Queued delete' : 'Deleted')
        case 'turn.verb.stdin':
            return zh
                ? (isRunning ? '正在发送输入' : isQueued ? '待发送输入' : '已发送输入')
                : (isRunning ? 'Sending input' : isQueued ? 'Queued input' : 'Sent input')
        case 'turn.verb.killSession':
            return zh
                ? (isRunning ? '正在停止会话' : isQueued ? '待停止会话' : '已停止会话')
                : (isRunning ? 'Stopping session' : isQueued ? 'Queued stop' : 'Stopped session')
        default:
            if (verb.startsWith('turn.verb.')) {
                const suffix = verb.slice('turn.verb.'.length)
                return capitalizeFirst(suffix)
            }
            return isRunning && !verb.endsWith('...') ? `${verb}...` : verb
    }
}
export function describeTurnToolStep(
    row: TurnToolRow,
    lang: 'en' | 'zh-CN' = 'en'
): TurnToolStepDescriptor {
    const tool = row.block.tool
    const rawName = tool.name
    const name = resolveToolViewName(rawName)
    const isQueued = tool.state === 'pending' && !row.permission
    const isRunning = tool.state === 'running' || (tool.state === 'pending' && row.permission)
    const zh = lang === 'zh-CN'
    const activeIntent = isRunning || isQueued ? intentSentence(tool) : null

    const matchedPlugin = findMatchingToolPreviewPlugin({
        row,
        tool,
        rawName,
        resolvedName: name,
        isRunning,
        isQueued,
        zh,
        activeIntent,
    })
    if (matchedPlugin) {
        return matchedPlugin.describe({
            row,
            tool,
            rawName,
            resolvedName: name,
            isRunning,
            isQueued,
            zh,
            activeIntent,
        })
    }
    if (name === 'Write') {
        const rawTarget = stringField(tool.input, ['file_path', 'path'])
        const agentTarget = parseAgentUriTarget(rawTarget)
        if (agentTarget) {
            return {
                isRunning,
                isQueued,
                verbLabel: translateTurnVerbKey('turn.verb.messagedAgent', isRunning, isQueued, zh),
                intentLabel: isRunning || isQueued ? (activeIntent ?? agentTarget) : agentTarget,
                secondaryBadge: null,
                preview: {
                    kind: 'default',
                    block: row.block,
                },
            }
        }
    }

    if (rawName.toLowerCase() === 'delete' || row.verb === 'turn.verb.delete') {
        const paths = isObject(tool.input) && Array.isArray(tool.input.paths)
            ? tool.input.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : []
        const targetSummary = paths.length === 1
            ? basename(paths[0]!)
            : paths.length > 1
                ? (zh ? `${paths.length} 个路径 (${basename(paths[0]!)} …)` : `${paths.length} paths (${basename(paths[0]!)} …)`)
                : ''
        return {
            isRunning,
            isQueued,
            verbLabel: translateTurnVerbKey('turn.verb.delete', isRunning, isQueued, zh),
            intentLabel: isRunning || isQueued ? (activeIntent ?? (targetSummary || row.intent)) : targetSummary,
            secondaryBadge: null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }

    if (rawName.toLowerCase() === 'wait' || row.verb === 'turn.verb.wait') {
        return {
            isRunning,
            isQueued,
            verbLabel: translateTurnVerbKey('turn.verb.wait', isRunning, isQueued, zh),
            intentLabel: isRunning || isQueued ? (activeIntent ?? '') : '',
            secondaryBadge: null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }
    if (name === 'Grep' || name === 'Glob') {
        const pattern = stringField(tool.input, ['pattern', 'query', 'pat']) ?? ''
        const target = stringField(tool.input, ['path', 'include'])
        const targetSummary = pattern && target
            ? (zh ? `在 ${basename(target)} 中搜索 ${pattern}` : `for ${pattern} in ${basename(target)}`)
            : (pattern || (target ? basename(target) : ''))
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning ? '正在搜索' : isQueued ? '待搜索' : '已搜索')
                : (isRunning ? 'Searching' : isQueued ? 'Queued search' : 'Searched'),
            intentLabel: isRunning || isQueued ? (activeIntent ?? (targetSummary || row.intent)) : targetSummary,
            secondaryBadge: null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }

    if (isSubagentTool(rawName, name)) {
        const agentNames = extractSubagentNames(tool)
        const completedVerb = agentNames.length > 1
            ? (zh ? `已运行 ${agentNames.length} 个代理` : `Ran ${agentNames.length} agents`)
            : (zh ? '已运行代理' : 'Ran agent')
        const completedIntent = agentNames.length > 1
            ? `(${agentNames.join(', ')})`
            : agentNames.length === 1
                ? agentNames[0]!
                : ''
        return {
            isRunning,
            isQueued,
            verbLabel: isRunning || isQueued
                ? (zh
                    ? (isRunning ? '正在运行代理' : '待运行代理')
                    : (isRunning ? 'Running agent' : 'Queued agent'))
                : completedVerb,
            intentLabel: isRunning || isQueued ? row.intent : completedIntent,
            secondaryBadge: !isRunning && !isQueued ? (zh ? '完成' : 'Done') : null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }

    if (
        TODO_TOOL_NAMES[name]
        || TODO_TOOL_NAMES[rawName]
        || row.verb === 'turn.verb.todo'
        || row.verb === 'turn.verb.addedTask'
    ) {
        const verbKey = row.verb === 'turn.verb.addedTask' ? 'turn.verb.addedTask' : 'turn.verb.todo'
        return {
            isRunning,
            isQueued,
            verbLabel: translateTurnVerbKey(verbKey, isRunning, isQueued, zh),
            intentLabel: isRunning || isQueued || row.verb === 'turn.verb.addedTask' ? row.intent : '',
            secondaryBadge: null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }

    if (name === 'CodexReasoning' || row.verb === 'turn.verb.reasoning') {
        return {
            isRunning,
            isQueued,
            verbLabel: translateTurnVerbKey('turn.verb.reasoning', isRunning, isQueued, zh),
            intentLabel: isRunning || isQueued ? row.intent : '',
            secondaryBadge: null,
            preview: {
                kind: 'default',
                block: row.block,
            },
        }
    }

    return {
        isRunning,
        isQueued,
        verbLabel: translateTurnVerbKey(row.verb, isRunning, isQueued, zh),
        intentLabel: isRunning || isQueued ? row.intent : '',
        secondaryBadge: null,
        preview: {
            kind: 'default',
            block: row.block,
        },
    }
}

export type TurnCoalescedCategory = 'read' | 'search' | 'subagent' | 'compaction'

export type TurnCoalescedRow = {
    kind: 'coalesced'
    key: string
    category: TurnCoalescedCategory
    memberKeys: string[]
    rows: Array<TurnToolRow | TurnReasoningRow>
    toolRows: TurnToolRow[]
    pinned: boolean
}

export type TurnDisplayStepRow = TurnRow | TurnCoalescedRow

function coalescibleCategoryForToolRow(row: TurnToolRow): TurnCoalescedCategory | null {
    const tool = row.block.tool
    if (tool.state !== 'completed' || row.error || row.permission) return null
    const rawName = tool.name
    if (isAskUserQuestionToolName(rawName) || isRequestUserInputToolName(rawName)) return null
    const name = resolveToolViewName(rawName)
    if (rawName === 'ContextCompaction' || row.verb === 'turn.verb.compaction') return 'compaction'
    if (name === 'Read') return 'read'
    if (name === 'Grep' || name === 'Glob') return 'search'
    if (
        isSubagentTool(rawName, name)
        || (name === 'Write' && parseAgentUriTarget(stringField(tool.input, ['file_path', 'path'])) !== null)
        || rawName.toLowerCase() === 'wait'
    ) {
        return 'subagent'
    }
    return null
}

export function coalesceTurnStepRows(
    stepRows: readonly TurnRow[],
    options?: {
        absorbTransitionalThoughts?: boolean
    }
): TurnDisplayStepRow[] {
    const absorbThoughts = options?.absorbTransitionalThoughts ?? true
    const result: TurnDisplayStepRow[] = []
    let i = 0
    while (i < stepRows.length) {
        const current = stepRows[i]!
        if (current.kind !== 'tool') {
            result.push(current)
            i += 1
            continue
        }
        const category = coalescibleCategoryForToolRow(current)
        if (!category) {
            result.push(current)
            i += 1
            continue
        }
        const collectedRows: Array<TurnToolRow | TurnReasoningRow> = [current]
        const collectedTools: TurnToolRow[] = [current]
        let j = i + 1
        while (j < stepRows.length) {
            const next = stepRows[j]!
            if (next.kind === 'tool' && coalescibleCategoryForToolRow(next) === category) {
                collectedRows.push(next)
                collectedTools.push(next)
                j += 1
                continue
            }
            if (absorbThoughts && next.kind === 'reasoning') {
                let k = j
                while (k < stepRows.length && stepRows[k]?.kind === 'reasoning') {
                    k += 1
                }
                const afterThoughts = k < stepRows.length ? stepRows[k] : undefined
                if (afterThoughts?.kind === 'tool' && coalescibleCategoryForToolRow(afterThoughts) === category) {
                    for (let m = j; m < k; m += 1) {
                        collectedRows.push(stepRows[m] as TurnReasoningRow)
                    }
                    collectedRows.push(afterThoughts)
                    collectedTools.push(afterThoughts)
                    j = k + 1
                    continue
                }
            }
            break
        }
        if (collectedTools.length >= 2) {
            result.push({
                kind: 'coalesced',
                key: `coalesced:${category}:${collectedTools[0]!.key}`,
                category,
                memberKeys: collectedTools.map((t) => t.key),
                rows: collectedRows,
                toolRows: collectedTools,
                pinned: collectedTools.some((t) => t.pinned),
            })
            i = j
        } else {
            result.push(current)
            i += 1
        }
    }
    return result
}

export function describeCoalescedTurnStep(
    row: TurnCoalescedRow,
    lang: 'en' | 'zh-CN' = 'en'
): {
    verbLabel: string
    intentLabel: string
    secondaryBadge: string | null
} {
    const zh = lang === 'zh-CN'
    const count = row.toolRows.length

    if (row.category === 'compaction') {
        return {
            verbLabel: zh ? '已压缩上下文' : 'Compacted conversation',
            intentLabel: '',
            secondaryBadge: `${count}×`,
        }
    }

    if (row.category === 'read') {
        const uniqueFiles: string[] = []
        let totalLines = 0
        for (const toolRow of row.toolRows) {
            const rawPath = stringField(toolRow.block.tool.input, ['file_path', 'path']) ?? ''
            const { fileName } = normalizeReadFilePath(rawPath)
            if (fileName && !uniqueFiles.includes(fileName)) {
                uniqueFiles.push(fileName)
            }
            const content = extractResultText(toolRow.block.tool.result)
            if (content) {
                totalLines += content.split(/\r?\n/).length
            }
        }
        if (uniqueFiles.length === 1) {
            const linesSuffix = totalLines > 0
                ? (zh ? ` · ${totalLines} 行` : ` · ${totalLines} lines`)
                : ''
            return {
                verbLabel: zh ? '已查看' : 'Viewed',
                intentLabel: uniqueFiles[0]!,
                secondaryBadge: zh ? `${count} 处${linesSuffix}` : `${count} ranges${linesSuffix}`,
            }
        }
        const fileSummary = uniqueFiles.length <= 3
            ? uniqueFiles.join(', ')
            : `${uniqueFiles[0]} … ${uniqueFiles[uniqueFiles.length - 1]}`
        const fileCount = uniqueFiles.length || count
        return {
            verbLabel: zh ? '已查看' : 'Viewed',
            intentLabel: zh
                ? `${fileCount} 个文件${fileSummary ? ` (${fileSummary})` : ''}`
                : `${fileCount} files${fileSummary ? ` (${fileSummary})` : ''}`,
            secondaryBadge: totalLines > 0 ? (zh ? `${totalLines} 行` : `${totalLines} lines`) : null,
        }
    }

    if (row.category === 'search') {
        const patterns: string[] = []
        for (const toolRow of row.toolRows) {
            const rawPattern = stringField(toolRow.block.tool.input, ['pattern', 'query', 'pat'])
                ?? stringField(toolRow.block.tool.input, ['path', 'include'])
                ?? ''
            const clean = truncate(rawPattern.trim(), 28)
            if (clean && !patterns.includes(clean)) {
                patterns.push(clean)
            }
        }
        const patternSummary = patterns.length <= 2
            ? patterns.join(', ')
            : `${patterns.slice(0, 2).join(', ')}, …`
        return {
            verbLabel: zh ? '已搜索' : 'Searched',
            intentLabel: zh
                ? `${count} 次${patternSummary ? ` (${patternSummary})` : ''}`
                : `${count} patterns${patternSummary ? ` (${patternSummary})` : ''}`,
            secondaryBadge: null,
        }
    }

    const uniqueAgents: string[] = []
    let subagentLaunchCount = 0
    for (const toolRow of row.toolRows) {
        const rawName = toolRow.block.tool.name
        const name = resolveToolViewName(rawName)
        if (isSubagentTool(rawName, name)) {
            const tasksList = isObject(toolRow.block.tool.input) && Array.isArray(toolRow.block.tool.input.tasks)
                ? toolRow.block.tool.input.tasks
                : null
            subagentLaunchCount += tasksList && tasksList.length > 1 ? tasksList.length : 1
        }
        for (const agentName of extractSubagentNames(toolRow.block.tool)) {
            if (!uniqueAgents.includes(agentName)) {
                uniqueAgents.push(agentName)
            }
        }
    }
    if (subagentLaunchCount > 0) {
        const agentCount = Math.max(uniqueAgents.length, subagentLaunchCount)
        return {
            verbLabel: zh
                ? (agentCount === 1 ? '已运行代理' : `已运行 ${agentCount} 个代理`)
                : (agentCount === 1 ? 'Ran agent' : `Ran ${agentCount} agents`),
            intentLabel: uniqueAgents.length > 0
                ? (agentCount === 1 && uniqueAgents.length === 1 ? uniqueAgents[0]! : `(${uniqueAgents.join(', ')})`)
                : '',
            secondaryBadge: zh ? '完成' : 'Done',
        }
    }
    return {
        verbLabel: zh ? '已通知代理' : 'Messaged',
        intentLabel: uniqueAgents.join(', ') || 'agent',
        secondaryBadge: zh ? '完成' : 'Done',
    }
}

export function summarizeTurnActivity(
    partition: TurnPartition,
    options?: {
        activeTodoText?: string | null
        lang?: 'en' | 'zh-CN'
    }
): {
    workingHeader: string
    completedHeader: string
    counts: TurnActionCounts
} {
    const lang = options?.lang ?? 'en'
    const counts = countTurnActions(partition.rows)
    const completedHeader = formatTurnAggregatedSummary(counts, lang)

    const activeTodo = shownTitle(options?.activeTodoText)
    const tools = partition.rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const runningTool = tools.find((row) => row.block.tool.state === 'pending' && row.permission)
        ?? tools.findLast((row) => row.block.tool.state === 'running')
        ?? tools.findLast((row) => row.block.tool.state === 'pending')
    const isCompacting = runningTool?.block.tool.name === 'ContextCompaction'
    const runningStep = runningTool ? describeTurnToolStep(runningTool, lang) : null
    const runningPhrase = runningStep
        ? (isCompacting
            ? `${runningStep.verbLabel}...`
            : `${runningStep.verbLabel}${runningStep.intentLabel ? ` ${runningStep.intentLabel}` : ''}...`)
        : null

    const lastStepRow = [...partition.rows].reverse().find((row) => !(row.kind === 'text' && row.trailing))
    const trailingThoughtTitle = !runningTool && lastStepRow?.kind === 'reasoning'
        ? shownTitle(extractThoughtSummary(lastStepRow.text, TITLE_LIMIT))
        : null
    const fallbackTitle = trailingThoughtTitle
        ?? (partition.title
            ? translateTurnVerbKey(partition.title, true, false, lang === 'zh-CN')
            : '')
    const workingHeader = isCompacting && runningPhrase
        ? runningPhrase
        : activeTodo
            ? (activeTodo.endsWith('...') ? activeTodo : `${activeTodo}...`)
            : runningPhrase
                ?? (fallbackTitle
                    ? (fallbackTitle.endsWith('...') ? fallbackTitle : `${fallbackTitle}...`)
                    : (lang === 'zh-CN' ? '正在思考...' : 'Thinking...'))
    return {
        workingHeader,
        completedHeader,
        counts,
    }
}

/**
 * Lightweight $O(k)$ check whether raw message content parts produce any
 * non-text turn activity (reasoning, non-CodexReasoning tool calls, tool groups,
 * generated images, or generated files) without allocating a full `TurnPartition`.
 */
export function hasTurnContentActivity(parts: readonly TurnContentPart[]): boolean {
    for (const part of parts) {
        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0) {
            return true
        }
        if (part.type === 'text' && part.phase === 'execution' && typeof part.text === 'string' && part.text.trim().length > 0) {
            return true
        }
        if (isToolGroup(part)) {
            if (part.artifact.tools.length > 0) return true
            continue
        }
        if (isToolCall(part)) {
            if (part.artifact.tool.name !== 'CodexReasoning') return true
            continue
        }
        if (isGeneratedImage(part) || isGeneratedFile(part)) {
            return true
        }
    }
    return false
}

export interface ProjectedTodoChecklist {
    readonly key: string
    readonly items: TodoCardItem[]
}

export interface ProjectedQuietTextRow {
    readonly row: TurnTextRow
    readonly keepVisibleWhenCollapsed: boolean
}

export interface ProjectedSubturn {
    readonly key: string
    readonly rows: TurnRow[]
    readonly nonTrailingRows: TurnRow[]
    readonly stepRows: TurnDisplayStepRow[]
    readonly collapsedPinnedRailRows: Array<TurnToolRow | TurnCoalescedRow>
    readonly todoChecklists: ProjectedTodoChecklist[]
    readonly quietTextRows: ProjectedQuietTextRow[]
    readonly mediaRows: Array<TurnImageRow | TurnFileRow>
    readonly answerRows: TurnTextRow[]
    readonly hasSteps: boolean
    readonly lastRow: TurnRow | undefined
}

export interface ProjectedTurn {
    readonly subturns: ProjectedSubturn[]
}

function areTodoCardItemsEqual(a: readonly TodoCardItem[], b: readonly TodoCardItem[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i]!
        const right = b[i]!
        if (
            left.id !== right.id
            || left.text !== right.text
            || left.activeForm !== right.activeForm
            || left.status !== right.status
        ) {
            return false
        }
    }
    return true
}

function areDisplayStepRowsEqual(a: TurnDisplayStepRow, b: TurnDisplayStepRow): boolean {
    if (a === b) return true
    if (a.kind !== b.kind || a.key !== b.key) return false
    if (a.kind === 'coalesced' && b.kind === 'coalesced') {
        return a.category === b.category
            && a.pinned === b.pinned
            && isSameRefArray(a.rows, b.rows)
            && isSameRefArray(a.toolRows, b.toolRows)
    }
    return areTurnRowsEqual(a as TurnRow, b as TurnRow)
}

export function projectSubturnTodoChecklists(
    rows: readonly TurnRow[],
    options?: {
        readonly streaming?: boolean
        readonly fallbackTodos?: readonly TodoItem[] | null
    },
    previousChecklists?: readonly ProjectedTodoChecklist[] | null
): {
    readonly todoChecklists: ProjectedTodoChecklist[]
    readonly pinnedChecklistKeys: ReadonlySet<string>
} {
    const streaming = options?.streaming ?? false
    const rawFallbackChecklistItems: TodoCardItem[] =
        options?.fallbackTodos && options.fallbackTodos.length > 0
            ? [...projectSessionTodoSnapshot(options.fallbackTodos).items]
            : []
    const fallbackChecklistItems: TodoCardItem[] =
        rawFallbackChecklistItems.length > 0 && !rawFallbackChecklistItems.every((item) => item.status === 'blocked')
            ? rawFallbackChecklistItems
            : []
    const toolRowsInTurn = rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const allToolBlocks = toolRowsInTurn.map((row) => row.block)

    const pinnedChecklistByKey = new Map<string, TodoCardItem[]>()
    for (const row of toolRowsInTurn) {
        if (!row.pinned || row.error) continue
        const checklist = [...projectToolTodoSnapshot(row.block, allToolBlocks, fallbackChecklistItems).items]
        const rule = classifyToolPresentation(row.block, {
            hasValidTodoChecklist: checklist.length > 0,
            errorRecovered: false,
        })
        if (rule.slot === 'turn-todo-section' && checklist.length > 0) {
            pinnedChecklistByKey.set(row.key, checklist)
        }
    }

    const rawChecklists: ProjectedTodoChecklist[] = []
    if (pinnedChecklistByKey.size > 0) {
        for (const [key, items] of pinnedChecklistByKey.entries()) {
            rawChecklists.push({ key, items })
        }
    } else if (
        fallbackChecklistItems.length > 0
        && (
            (streaming && fallbackChecklistItems.some((item) => item.status === 'in_progress' || item.status === 'pending'))
            || (previousChecklists?.some((checklist) => checklist.key === 'session-fallback-todos')
                && !fallbackChecklistItems.every((item) => item.status === 'blocked' || item.status === 'completed')
                || previousChecklists?.some((checklist) => checklist.key === 'session-fallback-todos')
                    && fallbackChecklistItems.every((item) => item.status === 'completed'))
        )
    ) {
        rawChecklists.push({ key: 'session-fallback-todos', items: fallbackChecklistItems })
    }

    const mappedChecklists = rawChecklists.map((checklist) => {
        const prevChecklist = previousChecklists?.find((c) => c.key === checklist.key)
        return prevChecklist && areTodoCardItemsEqual(prevChecklist.items, checklist.items)
            ? prevChecklist
            : checklist
    })
    const stableTodoChecklists = previousChecklists && isSameRefArray(mappedChecklists, previousChecklists)
        ? [...previousChecklists]
        : mappedChecklists
    return {
        todoChecklists: stableTodoChecklists,
        pinnedChecklistKeys: new Set(pinnedChecklistByKey.keys()),
    }
}

export function projectTurn(
    partition: TurnPartition,
    options?: {
        readonly viewMode?: 'normal' | 'thinking' | 'verbose'
        readonly streaming?: boolean
        readonly fallbackTodos?: readonly TodoItem[] | null
    },
    previousProjected?: ProjectedTurn | null
): ProjectedTurn {
    const viewMode = options?.viewMode ?? 'normal'
    const streaming = options?.streaming ?? false
    const rows = partition.rows
    const isInitialStreamingWait = streaming && rows.length === 0
    const answerRows = rows.filter((row): row is TurnTextRow => row.kind === 'text' && row.trailing)
    const nonTrailingRows = rows.filter((row) => !(row.kind === 'text' && row.trailing))
    const mediaRows = nonTrailingRows.filter(
        (row): row is TurnImageRow | TurnFileRow => row.kind === 'image' || row.kind === 'file'
    )
    const stepCandidates = nonTrailingRows.filter(
        (row): row is Exclude<TurnRow, TurnImageRow | TurnFileRow> => row.kind !== 'image' && row.kind !== 'file'
    )
    const stepRows: TurnDisplayStepRow[] = viewMode === 'verbose'
        ? stepCandidates
        : coalesceTurnStepRows(stepCandidates, { absorbTransitionalThoughts: viewMode === 'normal' })
    const hasSteps = stepRows.some((row) => row.kind !== 'text' || row.phase === 'execution') || isInitialStreamingWait

    const { todoChecklists, pinnedChecklistKeys } = projectSubturnTodoChecklists(
        stepCandidates,
        { streaming, fallbackTodos: options?.fallbackTodos },
        previousProjected?.subturns[0]?.todoChecklists
    )

    const collapsedPinnedRailRows = stepRows.filter((row): row is TurnToolRow | TurnCoalescedRow => {
        if (row.kind === 'coalesced') {
            return row.rows.some(
                (r) => r.kind === 'tool' && r.pinned && !pinnedChecklistKeys.has(r.key)
            )
        }
        if (row.kind === 'tool') {
            if (!row.error && !row.permission && resolveTodoToolKind(row.block.tool.name) !== null) {
                return false
            }
            const rule = classifyToolPresentation(row.block, {
                hasValidTodoChecklist: pinnedChecklistKeys.has(row.key),
                errorRecovered: !row.pinned && row.error,
            })
            return rule.slot === 'rail' && row.pinned && !pinnedChecklistKeys.has(row.key)
        }
        return false
    })

    const quietTextRows: ProjectedQuietTextRow[] = []
    nonTrailingRows.forEach((row, idx) => {
        if (row.kind !== 'text') return
        const laterRows = nonTrailingRows.slice(idx + 1)
        const keepVisibleWhenCollapsed =
            laterRows.some((later) => later.kind === 'image' || later.kind === 'file')
            || (
                answerRows.length === 0
                && laterRows.length > 0
                && laterRows.every((later) => later.kind === 'tool' && later.block.tool.name === 'ContextCompaction')
            )
        quietTextRows.push({ row, keepVisibleWhenCollapsed })
    })

    const firstStableKey = rows[0]?.key ?? 'subturn:initial'
    const prevSubturn = previousProjected?.subturns[0] ?? null
    const stableRows = prevSubturn && isSameRefArray(rows, prevSubturn.rows) ? prevSubturn.rows : rows
    const stableNonTrailingRows = prevSubturn && isSameRefArray(nonTrailingRows, prevSubturn.nonTrailingRows)
        ? prevSubturn.nonTrailingRows
        : nonTrailingRows
    const prevStepByKey = new Map<string, TurnDisplayStepRow>()
    if (prevSubturn) {
        for (const prevStep of prevSubturn.stepRows) {
            prevStepByKey.set(prevStep.key, prevStep)
        }
    }
    const mappedStepRows = stepRows.map((step) => {
        const prevStep = prevStepByKey.get(step.key)
        return prevStep && areDisplayStepRowsEqual(prevStep, step) ? prevStep : step
    })
    const stableStepRows = prevSubturn && isSameRefArray(mappedStepRows, prevSubturn.stepRows)
        ? prevSubturn.stepRows
        : mappedStepRows
    const mappedCollapsedPinned = collapsedPinnedRailRows.map((row) => {
        const prevStep = prevStepByKey.get(row.key)
        return (prevStep && areDisplayStepRowsEqual(prevStep, row) ? prevStep : row) as TurnToolRow | TurnCoalescedRow
    })
    const stableCollapsedPinnedRailRows = prevSubturn && isSameRefArray(mappedCollapsedPinned, prevSubturn.collapsedPinnedRailRows)
        ? prevSubturn.collapsedPinnedRailRows
        : mappedCollapsedPinned
    const mappedChecklists = todoChecklists.map((checklist) => {
        const prevChecklist = prevSubturn?.todoChecklists.find((c) => c.key === checklist.key)
        return prevChecklist && areTodoCardItemsEqual(prevChecklist.items, checklist.items)
            ? prevChecklist
            : checklist
    })
    const stableTodoChecklists = prevSubturn && isSameRefArray(mappedChecklists, prevSubturn.todoChecklists)
        ? prevSubturn.todoChecklists
        : mappedChecklists
    const mappedQuietTextRows = quietTextRows.map((entry) => {
        const prevEntry = prevSubturn?.quietTextRows.find((q) => q.row.key === entry.row.key)
        return prevEntry && prevEntry.row === entry.row && prevEntry.keepVisibleWhenCollapsed === entry.keepVisibleWhenCollapsed
            ? prevEntry
            : entry
    })
    const stableQuietTextRows = prevSubturn && isSameRefArray(mappedQuietTextRows, prevSubturn.quietTextRows)
        ? prevSubturn.quietTextRows
        : mappedQuietTextRows
    const stableMediaRows = prevSubturn && isSameRefArray(mediaRows, prevSubturn.mediaRows)
        ? prevSubturn.mediaRows
        : mediaRows
    const stableAnswerRows = prevSubturn && isSameRefArray(answerRows, prevSubturn.answerRows)
        ? prevSubturn.answerRows
        : answerRows
    const subturnKey = `subturn:${firstStableKey}`
    const lastRow = stableRows[stableRows.length - 1]
    if (
        prevSubturn
        && prevSubturn.key === subturnKey
        && prevSubturn.rows === stableRows
        && prevSubturn.nonTrailingRows === stableNonTrailingRows
        && prevSubturn.stepRows === stableStepRows
        && prevSubturn.collapsedPinnedRailRows === stableCollapsedPinnedRailRows
        && prevSubturn.todoChecklists === stableTodoChecklists
        && prevSubturn.quietTextRows === stableQuietTextRows
        && prevSubturn.mediaRows === stableMediaRows
        && prevSubturn.answerRows === stableAnswerRows
        && prevSubturn.hasSteps === hasSteps
        && prevSubturn.lastRow === lastRow
        && previousProjected
    ) {
        return previousProjected
    }
    return {
        subturns: [
            {
                key: subturnKey,
                rows: stableRows,
                nonTrailingRows: stableNonTrailingRows,
                stepRows: stableStepRows,
                collapsedPinnedRailRows: stableCollapsedPinnedRailRows,
                todoChecklists: stableTodoChecklists,
                quietTextRows: stableQuietTextRows,
                mediaRows: stableMediaRows,
                answerRows: stableAnswerRows,
                hasSteps,
                lastRow,
            },
        ],
    }
}
