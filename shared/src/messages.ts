import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
import type { ToolCallLifecycleState } from './schemas'
import { isObject } from './utils'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

const VISIBLE_CLAUDE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary',
    // Auto-generated recap Claude Code's local TUI writes to the transcript on
    // window blur/focus (5min+ idle). Only observed via the local launcher's
    // transcript scan — SDK/remote mode never emits it. Chat-visible here also
    // means CLI-forwarded, web-rendered, and included in session export
    // (parity with turn_duration / compact_boundary).
    'away_summary',
    'model_refusal_fallback'
])

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

export function isClaudeChatVisibleSystemSubtype(subtype: unknown): subtype is string {
    return typeof subtype === 'string' && VISIBLE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)
}

export function isClaudeChatVisibleMessage(message: { type: unknown; subtype?: unknown }): boolean {
    if (message.type === 'rate_limit_event') {
        return false
    }

    if (message.type === 'tool_progress') {
        return false
    }

    if (message.type !== 'system') {
        return true
    }

    return isClaudeChatVisibleSystemSubtype(message.subtype)
}

export function isRedundantGoalStatusMessageText(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const message = value.trim()
    return message === 'Goal cleared'
        || /^Goal (active|paused|complete|blocked|limited by (?:budget|usage))(?:$|\s+·\s+)/.test(message)
}

/** Read kind-safe identities for cumulative snapshots. Only explicit live
 * snapshots are replaceable; a settled snapshot is authoritative even when its
 * content is shorter or empty. Ordinary assistant messages remain independent. */
function readMessageStreamId(value: unknown, liveOnly: boolean): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return null

    const content = record.content
    if (!isObject(content)) return null
    const data = isObject(content.data) ? content.data : null
    if (!data || (liveOnly && data.live !== true)) return null

    const turnScope = isObject(record.meta) ? readNonEmptyTurnId(record.meta.turnId) : null
    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE
        && (data.type === 'reasoning' || (data.type === 'message' && data.streamSnapshot === true))) {
        const id = data.id
        if (typeof id !== 'string' || id.trim().length === 0) return null
        return turnScope ? `codex:${data.type}:${turnScope}:${id}` : `codex:${data.type}:${id}`
    }
    if (content.type === 'output' && data.type === 'assistant' && data.streamSnapshot === true) {
        const uuid = data.uuid
        if (typeof uuid !== 'string' || uuid.trim().length === 0) return null
        return turnScope ? `output:assistant:${turnScope}:${uuid}` : `output:assistant:${uuid}`
    }
    return null
}

export function getMessageStreamId(value: unknown): string | null {
    return readMessageStreamId(value, false)
}

export function getLiveMessageStreamId(value: unknown): string | null {
    return readMessageStreamId(value, true)
}

type AgentRunUpdateMeta = {
    key: string
    isTerminal: boolean
    hasPayload: boolean
    hasProgress: boolean
    hasSummary: boolean
    hasParentToolCallId: boolean
}

function isTerminalAgentRunStatusValue(status: string): boolean {
    return status === 'completed'
        || status === 'failed'
        || status === 'error'
        || status === 'errored'
        || status === 'canceled'
        || status === 'cancelled'
        || status === 'aborted'
        || status === 'stopped'
        || status === 'interrupted'
        || status === 'notFound'
        || status === 'not_found'
}

function readAgentRunUpdateMeta(value: unknown): AgentRunUpdateMeta | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return null

    const content = record.content
    if (!isObject(content) || content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'agent-run-update') return null

    const cardId = readNonEmptyTurnId(data.cardId) ?? readNonEmptyTurnId(data.card_id)
    const agentId = readNonEmptyTurnId(data.agentId) ?? readNonEmptyTurnId(data.agent_id)
    if (!cardId && !agentId) return null

    const turnScope = isObject(record.meta) ? readNonEmptyTurnId(record.meta.turnId) : null
    const status = readNonEmptyTurnId(data.status) ?? 'running'
    const isTerminal = isTerminalAgentRunStatusValue(status)
    const hasPayload = data.input !== undefined
        || data.result !== undefined
        || data.error !== undefined
        || data.spawnResult !== undefined
    return {
        key: `${turnScope ?? ''}:${cardId ?? ''}:${agentId ?? ''}`,
        isTerminal,
        hasPayload,
        hasProgress: data.progress !== undefined,
        hasSummary: readNonEmptyTurnId(data.summary) !== null,
        hasParentToolCallId: readNonEmptyTurnId(data.parentToolCallId) !== null
    }
}

/**
 * Collapse superseded intermediate `codex:agent-run-update` snapshots for the
 * same subagent card while preserving 100% of fields consumed by `reduceTimeline`:
 * - the first update (initializes earliest `createdAt` / `startedAt` and seed metadata),
 * - the latest non-terminal update and latest `progress` / `summary` / `parentToolCallId` carrier,
 * - any terminal update or update carrying `input` / `result` / `error` / `spawnResult`.
 */
export function compactAgentRunUpdateMessages<T extends { content: unknown }>(
    messages: readonly T[]
): T[] {
    if (messages.length <= 2) return messages as T[]

    type GroupBounds = {
        count: number
        firstIndex: number
        lastNonTerminalIndex: number
        lastProgressIndex: number
        lastSummaryIndex: number
        lastParentToolCallIdIndex: number
    }

    const metas = new Array<AgentRunUpdateMeta | null>(messages.length)
    const groups = new Map<string, GroupBounds>()
    let hasCandidateGroup = false

    for (let index = 0; index < messages.length; index += 1) {
        const meta = readAgentRunUpdateMeta(messages[index]!.content)
        metas[index] = meta
        if (!meta) continue

        let group = groups.get(meta.key)
        if (!group) {
            group = {
                count: 1,
                firstIndex: index,
                lastNonTerminalIndex: meta.isTerminal ? -1 : index,
                lastProgressIndex: meta.hasProgress ? index : -1,
                lastSummaryIndex: meta.hasSummary ? index : -1,
                lastParentToolCallIdIndex: meta.hasParentToolCallId ? index : -1
            }
            groups.set(meta.key, group)
            continue
        }

        group.count += 1
        if (group.count > 2) {
            hasCandidateGroup = true
        }
        if (!meta.isTerminal) {
            group.lastNonTerminalIndex = index
        }
        if (meta.hasProgress) {
            group.lastProgressIndex = index
        }
        if (meta.hasSummary) {
            group.lastSummaryIndex = index
        }
        if (meta.hasParentToolCallId) {
            group.lastParentToolCallIdIndex = index
        }
    }

    if (!hasCandidateGroup) return messages as T[]

    const compacted: T[] = []
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!
        const meta = metas[index]
        if (!meta) {
            compacted.push(message)
            continue
        }
        const group = groups.get(meta.key)!
        if (
            meta.isTerminal
            || meta.hasPayload
            || index === group.firstIndex
            || index === group.lastNonTerminalIndex
            || index === group.lastProgressIndex
            || index === group.lastSummaryIndex
            || index === group.lastParentToolCallIdIndex
        ) {
            compacted.push(message)
        }
    }

    return compacted.length === messages.length ? (messages as T[]) : compacted
}

function readNonEmptyTurnId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function readTurnPhaseValue(rawPhase: unknown): 'execution' | 'final_answer' | null {
    if (rawPhase === 'execution' || rawPhase === 'commentary') {
        return 'execution'
    }
    if (rawPhase === 'final_answer') {
        return 'final_answer'
    }
    return null
}

export type HapiMessageScope = 'main' | 'child' | 'history'

export type TurnLifecycleOutcome = 'completed' | 'failed' | 'aborted'

export type TurnLifecycleEventPayload = {
    type: 'turn-lifecycle'
    eventId: string
    transition: 'started' | 'finished'
    turnId: string
    invocationId?: string
    providerTurnId?: string
    sourceInstanceId?: string
    sourceGeneration?: number
    scope: HapiMessageScope
    outcome?: TurnLifecycleOutcome
    source?: string
    preHandshake?: boolean
}

export function getMessageTurnId(value: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record || !isObject(record.meta)) return null
    return readNonEmptyTurnId(record.meta.turnId)
}

export function getLegacyMessageTurnId(value: unknown): string | null {
    const canonical = getMessageTurnId(value)
    if (canonical) return canonical
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record) return null
    if (isObject(record.meta)) {
        const metaLegacy = readNonEmptyTurnId(record.meta.turn_id)
        if (metaLegacy) return metaLegacy
    }
    const content = record.content
    if (!isObject(content)) return null
    const contentTurnId = readNonEmptyTurnId(content.turnId) ?? readNonEmptyTurnId(content.turn_id)
    if (contentTurnId) return contentTurnId
    const data = isObject(content.data) ? content.data : null
    if (!data) return null
    const dataTurnId = readNonEmptyTurnId(data.turnId) ?? readNonEmptyTurnId(data.turn_id)
    if (dataTurnId) return dataTurnId
    if (isObject(data.message)) {
        return readNonEmptyTurnId(data.message.turnId) ?? readNonEmptyTurnId(data.message.turn_id)
    }
    return null
}

export function getMessageTurnPhase(value: unknown): 'execution' | 'final_answer' | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record) return null
    if (isObject(record.meta)) {
        const metaPhase = readTurnPhaseValue(record.meta.turnPhase ?? record.meta.phase)
        if (metaPhase) return metaPhase
    }
    const content = record.content
    if (!isObject(content)) return null
    const data = isObject(content.data) ? content.data : null
    return readTurnPhaseValue(data?.turnPhase ?? data?.phase ?? content.turnPhase ?? content.phase)
}

export function getMessageScope(value: unknown): HapiMessageScope | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (!record) return null
    if (isObject(record.meta)) {
        if (record.meta.replayedHistory === true || record.meta.importedHistory === true || record.meta.scope === 'history') {
            return 'history'
        }
        if (record.meta.scope === 'child') return 'child'
        if (record.meta.scope === 'main') return 'main'
    }
    const content = isObject(record.content) ? record.content : null
    const data = content && isObject(content.data) ? content.data : null
    if (data?.replayedHistory === true || data?.importedHistory === true) {
        return 'history'
    }
    if (data?.scope === 'child' || data?.isSidechain === true || typeof data?.parentToolUseId === 'string' || typeof data?.parent_tool_use_id === 'string') {
        return 'child'
    }
    return null
}

export type MessageSourceAuthorityMetadata = {
    sourceInstanceId: string | null
    sourceGeneration: number | null
    preHandshake: boolean
}

export function getMessageSourceAuthority(value: unknown): MessageSourceAuthorityMetadata {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    const meta = record && isObject(record.meta) ? record.meta : null
    const content = record && isObject(record.content) ? record.content : null
    const data = content && isObject(content.data) ? content.data : null
    const sourceInstanceId = readNonEmptyTurnId(meta?.sourceInstanceId) ?? readNonEmptyTurnId(data?.sourceInstanceId)
    const rawGeneration = typeof meta?.sourceGeneration === 'number' && Number.isFinite(meta.sourceGeneration)
        ? meta.sourceGeneration
        : typeof data?.sourceGeneration === 'number' && Number.isFinite(data.sourceGeneration)
            ? data.sourceGeneration
            : null
    const preHandshake = meta?.preHandshake === true || data?.preHandshake === true
    return {
        sourceInstanceId,
        sourceGeneration: rawGeneration,
        preHandshake
    }
}

export function getTurnLifecycleEvent(value: unknown): TurnLifecycleEventPayload | null {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return null
    const content = isObject(record.content) ? record.content : null
    if (!content || content.type !== 'event') return null
    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'turn-lifecycle') return null
    const transition = data.transition === 'started' || data.transition === 'finished' ? data.transition : null
    const turnId = readNonEmptyTurnId(data.turnId) ?? getMessageTurnId(value)
    if (!transition || !turnId) return null
    const eventId = readNonEmptyTurnId(data.eventId) ?? readNonEmptyTurnId(content.id) ?? `${turnId}:${transition}`
    const rawScope = data.scope ?? (isObject(record.meta) ? record.meta.scope : undefined)
    const replayed = data.replayedHistory === true
        || data.importedHistory === true
        || (isObject(record.meta) && (record.meta.replayedHistory === true || record.meta.importedHistory === true))
    const scope: HapiMessageScope = replayed
        ? 'history'
        : rawScope === 'child'
            ? 'child'
            : rawScope === 'history'
                ? 'history'
                : 'main'
    const rawOutcome = data.outcome
    const outcome: TurnLifecycleOutcome | undefined = rawOutcome === 'completed' || rawOutcome === 'failed' || rawOutcome === 'aborted'
        ? rawOutcome
        : undefined
    if (transition === 'finished' && !outcome) return null
    const invocationId = readNonEmptyTurnId(data.invocationId)
        ?? (isObject(record.meta) ? readNonEmptyTurnId(record.meta.invocationId) : null)
        ?? undefined
    const providerTurnId = readNonEmptyTurnId(data.providerTurnId)
        ?? (isObject(record.meta) ? readNonEmptyTurnId(record.meta.providerTurnId) : null)
        ?? undefined
    const sourceInstanceId = readNonEmptyTurnId(data.sourceInstanceId)
        ?? (isObject(record.meta) ? readNonEmptyTurnId(record.meta.sourceInstanceId) : null)
        ?? undefined
    const sourceGeneration = typeof data.sourceGeneration === 'number' && Number.isFinite(data.sourceGeneration)
        ? data.sourceGeneration
        : isObject(record.meta) && typeof record.meta.sourceGeneration === 'number' && Number.isFinite(record.meta.sourceGeneration)
            ? record.meta.sourceGeneration
            : undefined
    const preHandshake = data.preHandshake === true || (isObject(record.meta) && record.meta.preHandshake === true)
    return {
        type: 'turn-lifecycle',
        eventId,
        transition,
        turnId,
        ...(invocationId ? { invocationId } : {}),
        ...(providerTurnId ? { providerTurnId } : {}),
        ...(sourceInstanceId ? { sourceInstanceId } : {}),
        ...(sourceGeneration !== undefined ? { sourceGeneration } : {}),
        scope,
        ...(outcome ? { outcome } : {}),
        ...(typeof data.source === 'string' && data.source.trim().length > 0 ? { source: data.source.trim() } : {}),
        ...(preHandshake ? { preHandshake: true } : {}),
    }
}

export function isTurnStartAuthorizedMessage(value: unknown): boolean {
    const lifecycle = getTurnLifecycleEvent(value)
    if (!lifecycle) return false
    return lifecycle.transition === 'started' && lifecycle.scope === 'main'
}
export function getMessageLifecycleState(value: unknown): 'streaming' | 'settled' {
    return getLiveMessageStreamId(value) !== null ? 'streaming' : 'settled'
}

export function isRedundantGoalStatusEventContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return false

    const eventContent = record.content
    if (!isObject(eventContent) || eventContent.type !== 'event') return false

    const data = isObject(eventContent.data) ? eventContent.data : null
    if (!data || data.type !== 'message') return false

    return isRedundantGoalStatusMessageText(data.message)
}

/**
 * Best-effort plain-text extraction from a stored agent message's `content`.
 *
 * Two structural shapes are common in this fork:
 *
 *  1. `codex` flavor:  content.type = 'codex',  content.data.type = 'message'
 *     -> assistant text at `content.data.message` (string).
 *
 *  2. `output` flavor (Claude SDK passthrough):  content.type = 'output',
 *     content.data.type = 'assistant'  -> text at
 *     `content.data.message.content[i].text` (array of `{type:'text', text}`).
 *
 * Returns `null` when the content does not look like assistant *text*
 * (tool calls, tool results, reasoning, token counts, etc.) so callers can
 * skip those messages and fall back to the previous one.
 */
export function extractAssistantPlainText(content: unknown): string | null {
    if (!isObject(content)) return null

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'message') return null
        return typeof data.message === 'string' && data.message.length > 0
            ? data.message
            : null
    }

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data) return null

        // AGY planner prose (cli wraps PLANNER_RESPONSE as agy_message).
        if (data.type === 'agy_message') {
            return typeof data.content === 'string' && data.content.trim().length > 0
                ? data.content
                : null
        }

        if (data.type !== 'assistant') return null
        const message = isObject(data.message) ? data.message : null
        const blocks = Array.isArray(message?.content) ? message.content : null
        if (!blocks) return null
        const textParts: string[] = []
        for (const block of blocks) {
            if (!isObject(block)) continue
            if (block.type === 'text' && typeof block.text === 'string') {
                textParts.push(block.text)
            }
        }
        if (textParts.length === 0) return null
        return textParts.join('\n')
    }

    return null
}

const NOTIFY_SUMMARY_PREFIX = 'AGENT_NOTIFY_SUMMARY '

export type NotifySummary = {
    version?: number
    agent?: string
    project?: string
    status?: string
    action?: string
    summary?: string
}

/**
 * Match a well-formed `AGENT_NOTIFY_SUMMARY {...}` footer on a single line.
 *
 * Allows an optional *glued* prose prefix on the same line (agents sometimes
 * omit the newline: `Done.AGENT_NOTIFY_SUMMARY {...}`). Whitespace-delimited
 * mentions (`Example: AGENT_NOTIFY_SUMMARY {...}`) are not treated as footers.
 * Scans left-to-right and returns the first token occurrence whose remainder
 * is valid JSON through end of line - so a literal `AGENT_NOTIFY_SUMMARY `
 * inside a JSON string value does not steal the match from the real footer.
 */
type NotifySummaryLineMatch = {
    jsonPart: string
    start: number
}

function matchNotifySummaryLine(line: string): NotifySummaryLineMatch | null {
    for (
        let idx = line.indexOf(NOTIFY_SUMMARY_PREFIX);
        idx >= 0;
        idx = line.indexOf(NOTIFY_SUMMARY_PREFIX, idx + NOTIFY_SUMMARY_PREFIX.length)
    ) {
        // Keep glued footers (`Done.AGENT_NOTIFY_SUMMARY ...`) and indented
        // standalone footers, but reject ordinary prose-delimited mentions
        // (`Example: AGENT_NOTIFY_SUMMARY ...`).
        const prefix = line.slice(0, idx)
        if (prefix.trim().length > 0 && /\s/.test(line[idx - 1]!)) continue
        const jsonPart = line.slice(idx + NOTIFY_SUMMARY_PREFIX.length).trim()
        if (!jsonPart.startsWith('{') || !jsonPart.endsWith('}')) continue
        try {
            if (isObject(JSON.parse(jsonPart))) return { jsonPart, start: idx }
        } catch {
            // Try the next occurrence (e.g. token mentioned inside a value).
        }
    }
    return null
}

function parseNotifySummaryJson(jsonPart: string): NotifySummary | null {
    try {
        const parsed: unknown = JSON.parse(jsonPart)
        if (!isObject(parsed)) return null
        const result: NotifySummary = {}
        if (typeof parsed.version === 'number') result.version = parsed.version
        if (typeof parsed.agent === 'string') result.agent = parsed.agent
        if (typeof parsed.project === 'string') result.project = parsed.project
        if (typeof parsed.status === 'string') result.status = parsed.status
        if (typeof parsed.action === 'string') result.action = parsed.action
        if (typeof parsed.summary === 'string') result.summary = parsed.summary
        return result
    } catch {
        return null
    }
}

type NotifySummaryMatch = {
    lines: string[]
    lastIdx: number
    line: string
    match: NotifySummaryLineMatch
    summary: NotifySummary
}

function findNotifySummary(text: string): NotifySummaryMatch | null {
    const lines = text.split('\n')
    let lastIdx = lines.length - 1
    while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1
    if (lastIdx < 0) return null

    const line = lines[lastIdx].trimEnd()
    const match = matchNotifySummaryLine(line)
    if (match === null) return null

    const summary = parseNotifySummaryJson(match.jsonPart)
    if (summary === null) return null

    return { lines, lastIdx, line, match, summary }
}

/**
 * Look for an `AGENT_NOTIFY_SUMMARY {...json...}` footer as the **last
 * non-empty line** of an agent's plain-text message.
 *
 * End-anchor: trailing blank lines are fine, but prose on a later
 * non-empty line is non-compliant and returns null. Mid-body quotes of
 * the token are ignored for the same reason. An optional *glued* prose prefix
 * on the last line itself is tolerated (`Done.AGENT_NOTIFY_SUMMARY {…}`);
 * whitespace-delimited examples on that line are not.
 *
 * Returns the parsed object on success, `null` on any deviation. The
 * shape is intentionally loose - we only trust `summary`, `action`, and
 * `status` for notification rendering, but the full object is forwarded
 * onto the meta-event bus when Phase 2 lands.
 */
export function extractNotifySummary(text: unknown): NotifySummary | null {
    if (typeof text !== 'string' || text.length === 0) return null

    return findNotifySummary(text)?.summary ?? null
}

export type NotifySummaryDisplay = {
    /** Agent prose with the machine-readable footer removed. */
    visibleText: string
    summary: NotifySummary
}

/**
 * Split a valid trailing summary footer into user-facing prose and metadata.
 *
 * The original message remains untouched; callers can use `visibleText` only
 * for presentation while retaining the raw text for copy/export/notifications.
 */
export function splitNotifySummary(text: unknown): NotifySummaryDisplay | null {
    if (typeof text !== 'string' || text.length === 0) return null

    const found = findNotifySummary(text)
    if (found === null) return null

    const prefix = found.line.slice(0, found.match.start).trimEnd()
    const visibleLines = found.lines.slice(0, found.lastIdx)
    if (prefix.length > 0) visibleLines.push(prefix)

    return {
        visibleText: visibleLines.join('\n').trimEnd(),
        summary: found.summary
    }
}

/**
 * Render/copy helper: remove a valid trailing AGENT_NOTIFY_SUMMARY footer.
 * Leaves malformed, mid-body, and non-final occurrences unchanged. Store and
 * parse/FCM paths must keep using the raw text.
 */
export function stripNotifySummaryFooter(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text
    return splitNotifySummary(text)?.visibleText ?? text
}

export type ExtractedToolCallEvent =
    | {
        kind: 'call'
        toolUseId: string
        toolName: string
        parentToolUseId: string | null
        isSidechain: boolean
        isSubagent: boolean
        state: ToolCallLifecycleState
    }
    | {
        kind: 'result'
        toolUseId: string
        state: 'completed' | 'error'
    }

function isSubagentToolCallName(name: string): boolean {
    return name === 'Task'
        || name === 'Agent'
        || name === 'CodexAgent'
        || name.startsWith('Agent:')
        || name.startsWith('Task:')
}

function asTrimmedNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function mapRawToolStatusToLifecycleState(status: unknown): ToolCallLifecycleState {
    if (typeof status !== 'string') return 'running'
    const normalized = status.trim().toLowerCase()
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'success' || normalized === 'succeeded' || normalized === 'done') {
        return 'completed'
    }
    if (normalized === 'failed' || normalized === 'fail' || normalized === 'error' || normalized === 'errored' || normalized === 'cancelled' || normalized === 'canceled') {
        return 'error'
    }
    if (normalized === 'aborted') {
        return 'aborted'
    }
    if (normalized === 'pending' || normalized === 'queued') {
        return 'pending'
    }
    return 'running'
}

export function extractMessageToolLifecycleEvents(content: unknown): ExtractedToolCallEvent[] {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (!record || record.role !== 'agent' || !isObject(record.content)) {
        return []
    }

    const events: ExtractedToolCallEvent[] = []
    const meta = isObject(record.meta) ? record.meta : null
    const hasChildScope = meta?.scope === 'child'
    const envelope = record.content

    if (envelope.type === 'output' && isObject(envelope.data)) {
        const data = envelope.data
        const isSidechain = Boolean(data.isSidechain) || Boolean(data.is_sidechain) || hasChildScope
        const parentToolUseId = asTrimmedNonEmptyString(data.parentToolUseId)
            ?? asTrimmedNonEmptyString(data.parent_tool_use_id)

        if (data.type === 'assistant' && isObject(data.message) && Array.isArray(data.message.content)) {
            for (const item of data.message.content) {
                if (!isObject(item) || item.type !== 'tool_use') continue
                const toolUseId = asTrimmedNonEmptyString(item.id)
                if (!toolUseId) continue
                const toolName = asTrimmedNonEmptyString(item.name) ?? 'Tool'
                events.push({
                    kind: 'call',
                    toolUseId,
                    toolName,
                    parentToolUseId,
                    isSidechain,
                    isSubagent: isSubagentToolCallName(toolName),
                    state: mapRawToolStatusToLifecycleState(item.status)
                })
            }
        } else if (data.type === 'user' && isObject(data.message) && Array.isArray(data.message.content)) {
            for (const item of data.message.content) {
                if (!isObject(item) || item.type !== 'tool_result') continue
                const toolUseId = asTrimmedNonEmptyString(item.tool_use_id)
                if (!toolUseId) continue
                events.push({
                    kind: 'result',
                    toolUseId,
                    state: Boolean(item.is_error) ? 'error' : 'completed'
                })
            }
        }
        return events
    }

    if ((envelope.type === AGENT_MESSAGE_PAYLOAD_TYPE || envelope.type === 'acp') && isObject(envelope.data)) {
        const data = envelope.data
        const isSidechain = Boolean(data.isSidechain)
            || Boolean(data.is_sidechain)
            || Boolean(data.subagent)
            || hasChildScope
        const parentToolUseId = asTrimmedNonEmptyString(data.parentToolUseId)
            ?? asTrimmedNonEmptyString(data.parent_tool_use_id)
            ?? asTrimmedNonEmptyString(data.subagent)

        if (data.type === 'tool-call') {
            const toolUseId = asTrimmedNonEmptyString(data.callId)
                ?? asTrimmedNonEmptyString(data.toolUseId)
                ?? asTrimmedNonEmptyString(data.id)
            if (toolUseId) {
                const toolName = asTrimmedNonEmptyString(data.name) ?? 'unknown'
                events.push({
                    kind: 'call',
                    toolUseId,
                    toolName,
                    parentToolUseId,
                    isSidechain,
                    isSubagent: isSubagentToolCallName(toolName),
                    state: mapRawToolStatusToLifecycleState(data.status)
                })
            }
        } else if (data.type === 'tool-call-result') {
            const toolUseId = asTrimmedNonEmptyString(data.callId)
                ?? asTrimmedNonEmptyString(data.toolUseId)
                ?? asTrimmedNonEmptyString(data.id)
            if (toolUseId) {
                events.push({
                    kind: 'result',
                    toolUseId,
                    state: Boolean(data.is_error) || Boolean(data.isError) ? 'error' : 'completed'
                })
            }
        }
    }

    return events
}

export type { RoleWrappedRecord }
