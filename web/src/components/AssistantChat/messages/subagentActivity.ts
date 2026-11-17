import { isObject } from '@hapi/protocol'
import { isSubagentToolName } from '@/chat/subagentTool'
import { getCodexAgentTargets, parseCodexSpawnAgentResult, parseMaybeJsonObject } from '@/components/ToolCard/codexAgents'
import { resolveToolViewName } from '@/components/ToolCard/toolNameAliases'
import { extractResultText, type TurnRow, type TurnToolRow } from './turnBlockModel'

export type SubagentActivityStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'

export type SubagentActivity = {
    key: string
    taskId: string
    anchorKey: string
    name: string
    status: SubagentActivityStatus
    startedAt: number | null
    completedAt: number | null
    resultExcerpt: string | null
    tools: readonly TurnToolRow[]
}

export type SubagentActivityProjection = {
    activityByAnchorKey: ReadonlyMap<string, readonly SubagentActivity[]>
    consumedToolKeys: ReadonlySet<string>
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function status(value: unknown): SubagentActivityStatus {
    switch (value) {
        case 'pending': case 'pending_init': return 'pending'
        case 'started': case 'running': case 'in_progress': return 'running'
        case 'completed': return 'completed'
        case 'failed': case 'errored': case 'error': return 'failed'
        case 'canceled': case 'cancelled': case 'aborted': case 'interrupted': case 'killed': return 'canceled'
        default: return 'unknown'
    }
}

function terminal(value: SubagentActivityStatus): boolean {
    return value === 'completed' || value === 'failed' || value === 'canceled'
}

function excerpt(result: unknown): string | null {
    const details = isObject(result) && isObject(result.details) ? result.details : null
    const display = details?.displayContent
    const original = text(typeof display === 'string' ? display : isObject(display) ? display.text : null)
        ?? text(extractResultText(result))
    if (!original) return null
    return original.length > 240 ? `${original.slice(0, 240)}…` : original
}


/** Project only explicit task identities. Tool completion is never a task lifecycle signal. */
export function projectSubagentActivities(rows: readonly TurnRow[]): SubagentActivityProjection {
    const toolRows = rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const rowsByCallId = new Map(toolRows.map((row) => [row.block.tool.id, row]))
    const activities = new Map<string, SubagentActivity>()
    const consumedToolKeys = new Set<string>()

    function attach(activity: SubagentActivity, row: TurnToolRow) {
        if (!activity.tools.some((tool) => tool.key === row.key)) {
            activity.tools = [...activity.tools, row]
        }
        consumedToolKeys.add(row.key)
    }

    function ensure(taskId: string, row: TurnToolRow, name: string | null, parentId: string | null = null) {
        let activity = activities.get(taskId)
        if (!activity) {
            const parent = parentId ? rowsByCallId.get(parentId) : undefined
            // Permission/error dispatches keep their own actionable top-level row.
            const parentIsDispatch = parent && (isSubagentToolName(resolveToolViewName(parent.block.tool.name)) || parent.block.tool.name === 'spawn_agent')
            const anchor = parentIsDispatch && !parent.error && !parent.permission ? parent : row
            activity = {
                key: `subagent:${taskId}`,
                taskId,
                anchorKey: anchor.key,
                name: name ?? taskId,
                status: 'unknown',
                startedAt: null,
                completedAt: null,
                resultExcerpt: null,
                tools: [],
            }
            activities.set(taskId, activity)
            if (anchor !== row) attach(activity, anchor)
        } else if (name) {
            activity.name = name
        }
        attach(activity, row)
        return activity
    }

    // First establish identities, so related calls can precede their lifecycle row.
    for (const row of toolRows) {
        const { tool } = row.block
        if (tool.name === 'CodexAgent' && isObject(tool.input)) {
            const input = tool.input
            const taskId = text(input.agentId) ?? text(input.agent_id)
            if (!taskId) continue
            const activity = ensure(taskId, row, text(input.agent) ?? text(input.summary) ?? text(input.description), text(input.parentToolCallId))
            activity.status = status(input.agentStatus)
            if (tool.startedAt !== null) activity.startedAt = activity.startedAt === null
                ? tool.startedAt : Math.min(activity.startedAt, tool.startedAt)
            activity.completedAt = terminal(activity.status) && !tool.completionSource ? tool.completedAt : null
            activity.resultExcerpt = excerpt(tool.result) ?? activity.resultExcerpt
        } else if (tool.name === 'spawn_agent' && !row.error && !row.permission) {
            const result = parseCodexSpawnAgentResult(tool.result)
            if (!result?.agentId) continue
            const input = isObject(tool.input) ? tool.input : null
            ensure(result.agentId, row, result.taskName ?? result.nickname ?? text(input?.description))
        }
    }

    for (const row of toolRows) {
        const { tool } = row.block
        if (tool.name === 'wait_agent' && !row.error && !row.permission) {
            const result = parseMaybeJsonObject(tool.result)
            if (result && isObject(result.status)) {
                for (const [taskId, rawStatus] of Object.entries(result.status)) {
                    if (!text(taskId)) continue
                    const record = isObject(rawStatus) ? rawStatus : null
                    let nextStatus = status(record?.status ?? record?.state ?? rawStatus)
                    let resultText: string | null = null
                    if (record) {
                        for (const key of ['completed', 'failed', 'errored', 'error', 'canceled', 'cancelled'] as const) {
                            if (key in record) {
                                nextStatus = status(key)
                                resultText = excerpt(record[key])
                                break
                            }
                        }
                        resultText ??= excerpt(record)
                    }
                    const activity = activities.get(taskId) ?? (nextStatus !== 'unknown' ? ensure(taskId, row, null) : undefined)
                    if (!activity) continue
                    attach(activity, row)
                    // Folded lifecycle rows already contain the latest native terminal event.
                    // Older waits and cleanup calls cannot replace that result or outcome.
                    if (!terminal(activity.status)) {
                        if (nextStatus !== 'unknown') activity.status = nextStatus
                        if (resultText) activity.resultExcerpt = resultText
                    }
                }
            }
        }
        const relatedCall = ['send_input', 'send_message', 'resume_agent', 'followup_task', 'wait_agent', 'close_agent', 'interrupt_agent'].includes(tool.name)
        const input = isObject(tool.input) ? tool.input : null
        const path = text(input?.path)
        const uriTarget = path?.match(/^agent:\/\/([^/?#]+)(?:\/.*)?$/)?.[1]
        const targets = relatedCall ? getCodexAgentTargets(tool.input)
            : uriTarget && ['Read', 'Write'].includes(resolveToolViewName(tool.name)) ? [uriTarget] : []
        for (const target of targets) {
            const activity = activities.get(target)
            if (activity && !row.permission && !row.error) attach(activity, row)
        }
    }

    // Retain atomic chronology in details, including dispatches shared by parallel tasks.
    const rowOrder = new Map(toolRows.map((row, index) => [row.key, index]))
    const activityByAnchorKey = new Map<string, SubagentActivity[]>()
    for (const activity of activities.values()) {
        activity.tools = [...activity.tools].sort((left, right) => rowOrder.get(left.key)! - rowOrder.get(right.key)!)
        const anchored = activityByAnchorKey.get(activity.anchorKey)
        if (anchored) anchored.push(activity)
        else activityByAnchorKey.set(activity.anchorKey, [activity])
    }
    return { activityByAnchorKey, consumedToolKeys }
}
