import { isInlineCompactionEvent, isLegacyCompactionStartEvent } from '@/chat/reducerEvents'
import { renderEventLabel } from '@/chat/presentation'
import type {
    AssistantContentPhase,
    CodexReview,
    RoundSummary,
    ToolCallBlock,
    UsageData,
} from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock, VisibleChatBlockRole } from '@/chat/toolGroups'
import { visibleBlockRole } from '@/chat/toolGroups'
export { filterVisibleBlocksForFlavor } from '@/fork-features/omp-product/eventVisibility'

/**
 * Aggregated metadata for a multi-turn response group, surfaced on the
 * group's first visible block so the `@assistant-ui/react` converter
 * preserves it after joining adjacent assistant messages.
 */
export type AggregatedAssistantMeta = {
    usage?: UsageData
    model: string | null
    invokedAt: number | null
    durationMs: undefined
    turnCount: number
    roundSummary?: RoundSummary
}

export type BlockWithThreadMessageId = {
    block: VisibleChatBlock
    threadMessageId: string
    timestamp?: number
    aggregate?: AggregatedAssistantMeta
}

export type TurnEntityContentPart = {
    readonly type: string
    readonly blockId?: string
    readonly text?: string
    readonly phase?: AssistantContentPhase
    readonly toolCallId?: string
    readonly toolName?: string
    readonly result?: unknown
    readonly isError?: boolean
    readonly artifact?: unknown
    readonly status?: { type?: string }
}

export type ThreadMessageTopology = {
    readonly id: string
    readonly kind: VisibleChatBlock['kind'] | 'assistant-turn'
    readonly role: VisibleChatBlockRole
}

/** The sole grouping rule shared by the list and the runtime adapter. */
export function threadMessageRuns(entries: readonly BlockWithThreadMessageId[]): readonly (readonly BlockWithThreadMessageId[])[] {
    const runs: BlockWithThreadMessageId[][] = []
    for (const entry of entries) {
        const previous = runs[runs.length - 1]
        if (visibleBlockRole(entry.block) === 'assistant' && previous && visibleBlockRole(previous[0]!.block) === 'assistant') {
            previous.push(entry)
        } else {
            runs.push([entry])
        }
    }
    return runs
}

export function buildThreadTopology(
    entries: readonly BlockWithThreadMessageId[],
    previous: readonly ThreadMessageTopology[]
): readonly ThreadMessageTopology[] {
    const next: ThreadMessageTopology[] = []
    let previousRole: VisibleChatBlockRole | null = null
    let unchanged = true
    for (const entry of entries) {
        const role = visibleBlockRole(entry.block)
        if (role === 'assistant' && previousRole === 'assistant') continue
        previousRole = role
        const kind = role === 'assistant' ? 'assistant-turn' : entry.block.kind
        const old = previous[next.length]
        if (old?.id === entry.threadMessageId && old.role === role && old.kind === kind) {
            next.push(old)
        } else {
            unchanged = false
            next.push(Object.freeze({ id: entry.threadMessageId, role, kind }))
        }
    }
    return unchanged && next.length === previous.length ? previous : Object.freeze(next)
}

export type TurnEntitySnapshot = {
    readonly id: string
    readonly blocks: readonly VisibleChatBlock[]
    readonly parts: readonly TurnEntityContentPart[]
    readonly timestamp: number
    readonly invokedAt?: number | null
    readonly durationMs?: number
    readonly usage?: UsageData
    readonly model?: string | null
    readonly roundSummary?: RoundSummary
    readonly turnCount?: number
}

export function formatCodexReviewText(review: CodexReview): string {
    const lines = ['Codex review']
    if (review.overallCorrectness) {
        lines.push(`Overall: ${review.overallCorrectness}`)
    }
    if (review.overallExplanation) {
        lines.push('', review.overallExplanation)
    }
    if (review.findings.length > 0) {
        lines.push('', 'Findings:')
        for (const finding of review.findings) {
            const priority = finding.priority === null ? '' : `[P${finding.priority}] `
            const location = finding.filePath
                ? ` (${finding.filePath}${finding.lineStart === null ? '' : `:${finding.lineStart}${finding.lineEnd !== null && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}`})`
                : ''
            lines.push(`- ${priority}${finding.title}${location}`)
            lines.push(`  ${finding.body}`)
        }
    }
    return lines.join('\n')
}

export function getBlockPresentationTimestamp(block: VisibleChatBlock): number {
    if (visibleBlockRole(block) === 'user') {
        return block.invokedAt ?? block.createdAt
    }
    if (block.kind === 'tool-group') {
        return block.tools.reduce(
            (latest, tool) => Math.max(latest, tool.tool.completedAt ?? tool.createdAt),
            block.createdAt
        )
    }
    if (block.kind === 'tool-call') {
        return Math.max(block.createdAt, block.tool.completedAt ?? block.createdAt)
    }
    return block.createdAt
}

/**
 * `@assistant-ui/react` joins adjacent assistant-role blocks into one card and
 * takes its timestamp from the first block. Use the response's final activity
 * time so prepending an older page cannot change an existing card's timestamp.
 */
export function getResponseGroupTimestamps(
    blocks: readonly VisibleChatBlock[]
): Map<VisibleChatBlock, number> {
    const timestamps = new Map<VisibleChatBlock, number>()
    let first: VisibleChatBlock | null = null
    let latestTimestamp = 0

    const flush = () => {
        if (first) timestamps.set(first, latestTimestamp)
        first = null
    }

    for (const block of blocks) {
        if (visibleBlockRole(block) !== 'assistant') {
            flush()
            continue
        }
        const timestamp = getBlockPresentationTimestamp(block)
        if (!first) {
            first = block
            latestTimestamp = timestamp
        } else {
            latestTimestamp = Math.max(latestTimestamp, timestamp)
        }
    }
    flush()
    return timestamps
}

function isMidTurnHoistableEventBlock(block: VisibleChatBlock): boolean {
    return block.kind === 'agent-event' && block.event.type === 'title-changed'
}

export function toCompactionToolCallBlock(
    block: Extract<VisibleChatBlock, { kind: 'agent-event' }>
): ToolCallBlock {
    const event = block.event
    const record = event as Record<string, unknown>
    const frame = typeof record.frame === 'object' && record.frame !== null
        ? (record.frame as Record<string, unknown>)
        : null
    const isStarted = (event.type === 'omp-compaction' && (record.phase === 'started' || frame?.type === 'auto_compaction_start'))
        || isLegacyCompactionStartEvent(event)
    const isFailed = event.type === 'omp-compaction'
        && !isStarted
        && (
            record.outcome === 'failed'
            || (
                record.outcome === undefined
                && frame?.aborted !== true
                && frame?.skipped !== true
                && typeof (record.errorMessage ?? frame?.errorMessage) === 'string'
            )
        )
    const state: ToolCallBlock['tool']['state'] = isStarted
        ? 'running'
        : isFailed
            ? 'error'
            : 'completed'
    return {
        kind: 'tool-call',
        id: block.id,
        localId: null,
        createdAt: block.createdAt,
        invokedAt: block.invokedAt,
        model: block.model,
        children: [],
        tool: {
            id: block.id,
            name: 'ContextCompaction',
            state,
            input: event,
            createdAt: block.createdAt,
            startedAt: block.createdAt,
            completedAt: isStarted ? null : block.createdAt,
            execStartedAt: block.createdAt,
            execCompletedAt: isStarted ? null : block.createdAt,
            description: renderEventLabel(event),
            result: isStarted ? undefined : event,
        },
    }
}

/**
 * A title change emitted mid-turn would end the assistant run that
 * assistant-ui joins into one card, splitting a single turn into two.
 * Move each such event to the start of its run, so the "Title changed"
 * line sits between the prompt and the turn it belongs to.
 */
export function hoistMidTurnTitleEvents(blocks: readonly VisibleChatBlock[]): readonly VisibleChatBlock[] {
    if (!blocks.some(isMidTurnHoistableEventBlock)) return blocks
    const result: VisibleChatBlock[] = []
    let runStart = -1
    for (const block of blocks) {
        if (visibleBlockRole(block) === 'assistant') {
            if (runStart < 0) runStart = result.length
            result.push(block)
            continue
        }
        if (runStart >= 0 && isMidTurnHoistableEventBlock(block)) {
            result.splice(runStart, 0, block)
            runStart += 1
            continue
        }
        runStart = -1
        result.push(block)
    }
    return result
}

type TurnSource = {
    localId: string | null
    turnId?: string
    invokedAt: number | null
    durationMs: number | undefined
    model: string | null
    usage: UsageData | undefined
    createdAt: number
}

function turnSourcesFromBlock(block: VisibleChatBlock): TurnSource[] {
    if (block.kind === 'tool-group') {
        return block.tools.map((tool) => ({
            localId: tool.localId,
            turnId: tool.turnId,
            invokedAt: tool.invokedAt ?? null,
            durationMs: tool.durationMs,
            model: tool.model ?? null,
            usage: tool.usage,
            createdAt: tool.createdAt
        }))
    }
    if (
        block.kind === 'agent-text'
        || block.kind === 'agent-reasoning'
        || block.kind === 'cli-output'
        || block.kind === 'tool-call'
    ) {
        return [{
            localId: block.localId,
            turnId: 'turnId' in block ? block.turnId : undefined,
            invokedAt: block.invokedAt ?? null,
            durationMs: block.durationMs,
            model: block.model ?? null,
            usage: block.usage,
            createdAt: block.createdAt
        }]
    }
    return []
}

function turnFingerprint(
    model: string | null,
    usage: UsageData | undefined,
    createdAt: number
): string {
    if (!usage) return `m=${model ?? ''}|u=|c=${createdAt}`
    return [
        `m=${model ?? ''}`,
        `i=${usage.input_tokens}`,
        `o=${usage.output_tokens}`,
        `r=${usage.reasoning_output_tokens ?? ''}`,
        `cc=${usage.cache_creation_input_tokens ?? ''}`,
        `cr=${usage.cache_read_input_tokens ?? ''}`,
        `t=${usage.service_tier ?? ''}`,
        `c=${createdAt}`
    ].join('|')
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined && b === undefined) return undefined
    return (a ?? 0) + (b ?? 0)
}

function addUsage(target: UsageData, addend: UsageData): UsageData {
    return {
        input_tokens: target.input_tokens + addend.input_tokens,
        output_tokens: target.output_tokens + addend.output_tokens,
        reasoning_output_tokens: sumOptional(
            target.reasoning_output_tokens,
            addend.reasoning_output_tokens
        ),
        cache_creation_input_tokens: sumOptional(
            target.cache_creation_input_tokens,
            addend.cache_creation_input_tokens
        ),
        cache_read_input_tokens: sumOptional(
            target.cache_read_input_tokens,
            addend.cache_read_input_tokens
        ),
        cost_usd: sumOptional(target.cost_usd, addend.cost_usd),
        ...(target.generation_duration_ms !== undefined && addend.generation_duration_ms !== undefined
            ? { generation_duration_ms: target.generation_duration_ms + addend.generation_duration_ms }
            : {}),
        service_tier: target.service_tier
    }
}

export function aggregateResponseGroups(
    blocks: readonly VisibleChatBlock[]
): Map<string, AggregatedAssistantMeta> {
    const aggregates = new Map<string, AggregatedAssistantMeta>()
    let groupFirstBlockId: string | null = null
    let prevTurnKey: string | null = null
    const seenModels: string[] = []
    let groupInvokedAt: number | null = null
    let groupUsage: UsageData | undefined
    let groupTurnCount = 0
    let groupRoundSummary: RoundSummary | undefined

    const flush = () => {
        if (groupFirstBlockId !== null && (groupTurnCount >= 2 || groupRoundSummary)) {
            const joinedModel = seenModels.length > 0 ? seenModels.join(', ') : null
            aggregates.set(groupFirstBlockId, {
                usage: groupUsage,
                model: joinedModel,
                invokedAt: groupInvokedAt,
                durationMs: undefined,
                turnCount: groupTurnCount,
                roundSummary: groupRoundSummary
            })
        }
        groupFirstBlockId = null
        prevTurnKey = null
        seenModels.length = 0
        groupInvokedAt = null
        groupUsage = undefined
        groupTurnCount = 0
        groupRoundSummary = undefined
    }

    for (const block of blocks) {
        const role = visibleBlockRole(block)
        if (role !== 'assistant') {
            flush()
            continue
        }

        if (groupFirstBlockId === null) {
            groupFirstBlockId = block.id
        }

        const roundSummary = block.kind === 'tool-group'
            ? block.roundSummary
            : block.kind === 'user-text' || block.kind === 'agent-event'
                ? undefined
                : block.roundSummary
        groupRoundSummary ??= roundSummary

        for (const turn of turnSourcesFromBlock(block)) {
            const turnKey = turn.localId !== null
                ? `id:${turn.localId}`
                : `fp:${turnFingerprint(turn.model, turn.usage, turn.createdAt)}`

            if (turn.localId === null && !turn.usage && !turn.model) continue

            if (turnKey === prevTurnKey) continue
            prevTurnKey = turnKey

            groupTurnCount += 1
            if (turn.invokedAt != null && (groupInvokedAt === null || turn.invokedAt < groupInvokedAt)) {
                groupInvokedAt = turn.invokedAt
            }
            if (turn.model && !seenModels.includes(turn.model)) {
                seenModels.push(turn.model)
            }
            if (turn.usage) {
                groupUsage = groupUsage ? addUsage(groupUsage, turn.usage) : { ...turn.usage }
            }
        }
    }

    flush()
    return aggregates
}

export function isSameUsage(a: UsageData | undefined, b: UsageData | undefined): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.input_tokens === b.input_tokens
        && a.output_tokens === b.output_tokens
        && a.reasoning_output_tokens === b.reasoning_output_tokens
        && a.cache_creation_input_tokens === b.cache_creation_input_tokens
        && a.cache_read_input_tokens === b.cache_read_input_tokens
        && a.context_tokens === b.context_tokens
        && a.context_window === b.context_window
        && a.thread_id === b.thread_id
        && a.scope_role === b.scope_role
        && a.service_tier === b.service_tier
        && a.cost_usd === b.cost_usd
        && a.generation_duration_ms === b.generation_duration_ms
}

function isSameAggregate(
    a: AggregatedAssistantMeta | undefined,
    b: AggregatedAssistantMeta | undefined
): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.model === b.model
        && a.invokedAt === b.invokedAt
        && a.durationMs === b.durationMs
        && a.turnCount === b.turnCount
        && a.roundSummary === b.roundSummary
        && isSameUsage(a.usage, b.usage)
}

const assistantGroupIdCache = new WeakMap<
    WeakMap<VisibleChatBlock, BlockWithThreadMessageId>,
    Map<string, string>
>()

export type ThreadMessageIdAssignmentOptions = {
    initialSeen?: ReadonlyMap<string, number>
    initialUsedGroupIds?: ReadonlySet<string>
    preserveGroupByRawId?: ReadonlyMap<string, string>
}

export function assignThreadMessageIdsWithStableWrappers(
    blocks: readonly VisibleChatBlock[],
    wrapperCache: WeakMap<VisibleChatBlock, BlockWithThreadMessageId>,
    options?: ThreadMessageIdAssignmentOptions
): BlockWithThreadMessageId[] {
    const seen = new Map<string, number>(options?.initialSeen)
    const rawIds = blocks.map((block) => {
        const id = block.kind === 'user-text' ? block.localId || block.id : block.id
        const base = `${block.kind}:${id}`
        const occurrence = seen.get(base) ?? 0
        seen.set(base, occurrence + 1)
        return occurrence === 0 ? base : `${base}~${occurrence}`
    })

    const previousGroupByRawId = assistantGroupIdCache.get(wrapperCache)
    const previousGroupForBlock = (cursor: number): string | undefined => {
        const block = blocks[cursor]!
        const direct = previousGroupByRawId?.get(rawIds[cursor]!) ?? previousGroupByRawId?.get(`block:${block.id}`)
        if (direct) return direct
        return block.kind === 'tool-group'
            ? block.tools.map((tool) => previousGroupByRawId?.get(`tool-call:${tool.id}`) ?? previousGroupByRawId?.get(`block:${tool.id}`)).find((id) => id !== undefined)
            : undefined
    }
    const nextGroupByRawId = new Map<string, string>(options?.preserveGroupByRawId)
    const assignedIds = [...rawIds]
    const usedGroupIds = new Set<string>(options?.initialUsedGroupIds)
    for (let index = 0; index < blocks.length; index += 1) {
        if (visibleBlockRole(blocks[index]!) !== 'assistant') {
            usedGroupIds.add(rawIds[index]!)
        }
    }

    let index = 0
    while (index < blocks.length) {
        if (visibleBlockRole(blocks[index]!) !== 'assistant') {
            index += 1
            continue
        }
        const runStart = index
        while (index < blocks.length && visibleBlockRole(blocks[index]!) === 'assistant') {
            index += 1
        }
        const runEnd = index - 1

        let groupId: string | undefined
        if (previousGroupByRawId) {
            const startCandidate = previousGroupForBlock(runStart)
            const endCandidate = previousGroupForBlock(runEnd)
            if (startCandidate && !usedGroupIds.has(startCandidate)) {
                groupId = startCandidate
            } else if (endCandidate && !usedGroupIds.has(endCandidate)) {
                groupId = endCandidate
            } else {
                for (let cursor = runStart; cursor <= runEnd; cursor += 1) {
                    const candidate = previousGroupForBlock(cursor)
                    if (candidate && !usedGroupIds.has(candidate)) {
                        groupId = candidate
                        break
                    }
                }
            }
        }

        const resolvedGroupId = groupId ?? rawIds[runStart]!
        usedGroupIds.add(resolvedGroupId)
        if (resolvedGroupId !== assignedIds[runStart]!) {
            const existingHolder = assignedIds.findIndex(
                (id, cursor) => cursor !== runStart && id === resolvedGroupId
            )
            const displacedId = assignedIds[runStart]!
            assignedIds[runStart] = resolvedGroupId
            if (existingHolder >= 0) {
                assignedIds[existingHolder] = displacedId
            }
        }
        for (let cursor = runStart; cursor <= runEnd; cursor += 1) {
            const block = blocks[cursor]!
            nextGroupByRawId.set(rawIds[cursor]!, resolvedGroupId)
            nextGroupByRawId.set(`block:${block.id}`, resolvedGroupId)
            if (block.kind === 'tool-group') {
                for (const tool of block.tools) {
                    nextGroupByRawId.set(`tool-call:${tool.id}`, resolvedGroupId)
                    nextGroupByRawId.set(`block:${tool.id}`, resolvedGroupId)
                }
            }
        }
    }
    assistantGroupIdCache.set(wrapperCache, nextGroupByRawId)
    const responseGroupTimestamps = getResponseGroupTimestamps(blocks)
    const aggregates = aggregateResponseGroups(blocks)

    return blocks.map((block, blockIndex) => {
        const threadMessageId = assignedIds[blockIndex]!
        const timestamp = responseGroupTimestamps.get(block) ?? getBlockPresentationTimestamp(block)
        const aggregate = aggregates.get(block.id)
        const cached = wrapperCache.get(block)
        if (
            cached?.threadMessageId === threadMessageId
            && cached.timestamp === timestamp
            && isSameAggregate(cached.aggregate, aggregate)
        ) {
            return cached
        }
        const stableAggregate = cached && isSameAggregate(cached.aggregate, aggregate)
            ? cached.aggregate
            : aggregate
        const next: BlockWithThreadMessageId = {
            block,
            threadMessageId,
            timestamp,
            aggregate: stableAggregate,
        }
        wrapperCache.set(block, next)
        return next
    })
}

export function assignThreadMessageIds(
    blocks: readonly VisibleChatBlock[]
): BlockWithThreadMessageId[] {
    return assignThreadMessageIdsWithStableWrappers(blocks, new WeakMap())
}

/**
 * Finds the latest conversation-history boundary that is safe to fork.
 * While the main agent is running, every block from the latest invoked user
 * message onward belongs to the active turn and must not become a transient
 * "completed" boundary as streaming events reshape the visible block list.
 */
export function findLatestCompletedBoundaryId(
    blocks: readonly VisibleChatBlock[],
    isRunning: boolean,
    activeTurnStartedAt: number | null,
    assignedEntries?: readonly BlockWithThreadMessageId[]
): string | null {
    const assigned = assignedEntries ?? assignThreadMessageIds(blocks)
    let limit = assigned.length
    if (isRunning) {
        const activeTurnStart = activeTurnStartedAt === null
            ? assigned.findLastIndex(({ block }) => (
                visibleBlockRole(block) === 'user' && block.invokedAt != null
            ))
            : assigned.findIndex(({ block }) => (
                visibleBlockRole(block) === 'user'
                && (block.invokedAt ?? block.createdAt) >= activeTurnStartedAt
            ))
        if (activeTurnStart >= 0) {
            limit = activeTurnStart
        } else if (activeTurnStartedAt === null) {
            return null
        } else {
            const lastBlock = assigned[assigned.length - 1]?.block
            const activeTurnId = lastBlock && 'turnId' in lastBlock ? lastBlock.turnId : undefined
            const firstActiveBlock = activeTurnId
                ? assigned.findIndex(({ block }) => 'turnId' in block && block.turnId === activeTurnId)
                : assigned.findIndex(({ block }) => (
                    (block.invokedAt ?? block.createdAt) >= activeTurnStartedAt
                ))
            if (firstActiveBlock >= 0) {
                limit = firstActiveBlock
            }
        }
    }

    let candidate: string | null = null
    let previousRole: VisibleChatBlockRole | null = null
    for (let index = 0; index < limit; index += 1) {
        const { block, threadMessageId } = assigned[index]!
        const role = visibleBlockRole(block)
        if (
            (role === 'user' && block.invokedAt != null)
            || (role === 'assistant' && previousRole !== 'assistant')
        ) {
            candidate = threadMessageId
        }
        previousRole = role
    }
    return candidate
}

export function visibleBlockToTurnContentPart(
    block: VisibleChatBlock,
    partCache?: WeakMap<VisibleChatBlock, TurnEntityContentPart>
): TurnEntityContentPart {
    const cached = partCache?.get(block)
    if (cached) {
        return cached
    }

    let part: TurnEntityContentPart
    if (block.kind === 'agent-text') {
        part = block.phase !== undefined
            ? { type: 'text', blockId: block.id, text: block.text, phase: block.phase }
            : { type: 'text', blockId: block.id, text: block.text }
    } else if (block.kind === 'agent-reasoning') {
        part = { type: 'reasoning', blockId: block.id, text: block.text }
    } else if (block.kind === 'codex-review') {
        part = { type: 'text', blockId: block.id, text: formatCodexReviewText(block.review) }
    } else if (block.kind === 'generated-image') {
        part = {
            type: 'tool-call',
            blockId: block.id,
            toolCallId: block.id,
            toolName: 'GeneratedImage',
            artifact: block,
        }
    } else if (block.kind === 'generated-file') {
        part = {
            type: 'tool-call',
            blockId: block.id,
            toolCallId: block.id,
            toolName: 'GeneratedFile',
            artifact: block,
        }
    } else if (block.kind === 'agent-event' && isInlineCompactionEvent(block.event)) {
        const compactionTool = toCompactionToolCallBlock(block)
        const running = compactionTool.tool.state === 'running'
        part = {
            type: 'tool-call',
            blockId: block.id,
            toolCallId: block.id,
            toolName: 'ContextCompaction',
            result: running ? undefined : block.event,
            isError: compactionTool.tool.state === 'error',
            artifact: compactionTool,
        }
    } else if (block.kind === 'cli-output') {
        part = { type: 'text', blockId: block.id, text: block.text }
    } else if (block.kind === 'tool-group') {
        const groupBlock: ToolGroupBlock = block
        part = {
            type: 'tool-call',
            blockId: groupBlock.id,
            toolCallId: groupBlock.id,
            toolName: 'ToolGroup',
            artifact: groupBlock,
        }
    } else if (block.kind === 'tool-call') {
        const toolBlock: ToolCallBlock = block
        part = {
            type: 'tool-call',
            blockId: toolBlock.id,
            toolCallId: toolBlock.id,
            toolName: toolBlock.tool.name,
            result: toolBlock.tool.result,
            isError: toolBlock.tool.state === 'error',
            artifact: toolBlock,
        }
    } else {
        part = { type: 'text', blockId: block.id, text: '' }
    }

    partCache?.set(block, part)
    return part
}

function isSameBlockArray(
    a: readonly VisibleChatBlock[],
    b: readonly VisibleChatBlock[]
): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

/** Layout descriptors contain only data that changes row membership or placement.
 * Mutable prose and ordinary tool payloads remain in the complete turn entities. */
export type TurnLayoutBlock = {
    readonly id: string
    readonly kind: VisibleChatBlock['kind']
    readonly nonEmpty?: boolean
    readonly phase?: AssistantContentPhase
    readonly toolName?: string
    readonly state?: string
    readonly permissionId?: string
    readonly permissionStatus?: string
    readonly agentMessage?: boolean
    readonly tasksCount?: number
    readonly projectionInput?: unknown
    readonly projectionResult?: unknown
    readonly members?: readonly TurnLayoutBlock[]
}

export type TurnLayoutSnapshot = {
    readonly id: string
    readonly blocks: readonly TurnLayoutBlock[]
}

function describeLayoutBlock(block: VisibleChatBlock): TurnLayoutBlock {
    if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'cli-output') {
        return { id: block.id, kind: block.kind, nonEmpty: Boolean(block.text.trim()), phase: 'phase' in block ? block.phase : undefined }
    }
    if (block.kind === 'tool-group') {
        return { id: block.id, kind: block.kind, members: block.tools.map(describeLayoutBlock) }
    }
    if (block.kind === 'tool-call') {
        const tool = block.tool
        const name = tool.name.toLowerCase().replaceAll('_', '')
        // These tools project row counts, Todo cards or an activity title from
        // payloads. Ordinary tool args/results belong only to the row leaves.
        const projectsPayload = name === 'todowrite' || name === 'todo' || name === 'updateplan' || name === 'exitplanmode' || name === 'codexreasoning'
        const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : null
        const path = input?.file_path ?? input?.path
        return {
            id: block.id, kind: block.kind, toolName: tool.name, state: tool.state,
            permissionId: tool.permission?.id, permissionStatus: tool.permission?.status,
            agentMessage: typeof path === 'string' && path.trim().startsWith('agent://'),
            tasksCount: Array.isArray(input?.tasks) ? input.tasks.length : undefined,
            projectionInput: projectsPayload ? tool.input : undefined,
            projectionResult: projectsPayload ? tool.result : undefined,
        }
    }
    return { id: block.id, kind: block.kind, projectionInput: block }
}

function sameLayoutBlock(a: TurnLayoutBlock, b: TurnLayoutBlock): boolean {
    return a.id === b.id && a.kind === b.kind && a.nonEmpty === b.nonEmpty && a.phase === b.phase
        && a.toolName === b.toolName && a.state === b.state
        && a.permissionId === b.permissionId && a.permissionStatus === b.permissionStatus
        && a.agentMessage === b.agentMessage && a.tasksCount === b.tasksCount && a.projectionInput === b.projectionInput && a.projectionResult === b.projectionResult
        && ((!a.members && !b.members) || Boolean(a.members && b.members && a.members.length === b.members.length && a.members.every((member, i) => sameLayoutBlock(member, b.members![i]!))))
}

export function buildTurnLayoutsById(
    turns: ReadonlyMap<string, TurnEntitySnapshot>,
    previous: ReadonlyMap<string, TurnLayoutSnapshot>
): ReadonlyMap<string, TurnLayoutSnapshot> {
    const next = new Map<string, TurnLayoutSnapshot>()
    let unchanged = turns.size === previous.size
    for (const [id, turn] of turns) {
        const blocks = turn.blocks.map(describeLayoutBlock)
        const old = previous.get(id)
        if (old && old.blocks.length === blocks.length && blocks.every((block, i) => sameLayoutBlock(block, old.blocks[i]!))) {
            next.set(id, old)
        } else {
            unchanged = false
            next.set(id, { id, blocks })
        }
    }
    return unchanged ? previous : next
}

export function buildTurnEntitiesById(
    entries: readonly BlockWithThreadMessageId[],
    previousTurnsById: ReadonlyMap<string, TurnEntitySnapshot>,
    partCache: WeakMap<VisibleChatBlock, TurnEntityContentPart>
): Map<string, TurnEntitySnapshot> {
    const nextTurnsById = new Map<string, TurnEntitySnapshot>()
    let reusedCount = 0
    let index = 0
    while (index < entries.length) {
        const current = entries[index]!
        if (visibleBlockRole(current.block) !== 'assistant') {
            index += 1
            continue
        }
        const runStart = index
        const runBlocks: VisibleChatBlock[] = []
        while (index < entries.length && visibleBlockRole(entries[index]!.block) === 'assistant') {
            runBlocks.push(entries[index]!.block)
            index += 1
        }
        const firstEntry = entries[runStart]!
        const firstBlock = firstEntry.block
        const turnId = firstEntry.threadMessageId
        const aggregate = firstEntry.aggregate
        const timestamp = firstEntry.timestamp ?? getBlockPresentationTimestamp(firstBlock)
        const invokedAt = aggregate
            ? aggregate.invokedAt
            : ('invokedAt' in firstBlock ? firstBlock.invokedAt : undefined)
        const durationMs = aggregate
            ? aggregate.durationMs
            : ('durationMs' in firstBlock ? firstBlock.durationMs : undefined)
        const usage = aggregate
            ? aggregate.usage
            : ('usage' in firstBlock ? firstBlock.usage : undefined)
        const model = aggregate
            ? aggregate.model
            : ('model' in firstBlock ? firstBlock.model : undefined)
        const roundSummary = aggregate
            ? aggregate.roundSummary
            : ('roundSummary' in firstBlock ? firstBlock.roundSummary : undefined)
        const turnCount = aggregate?.turnCount

        const prevTurn = previousTurnsById.get(turnId)
        if (
            prevTurn
            && isSameBlockArray(prevTurn.blocks, runBlocks)
            && prevTurn.timestamp === timestamp
            && prevTurn.invokedAt === invokedAt
            && prevTurn.durationMs === durationMs
            && isSameUsage(prevTurn.usage, usage)
            && prevTurn.model === model
            && prevTurn.roundSummary === roundSummary
            && prevTurn.turnCount === turnCount
        ) {
            nextTurnsById.set(turnId, prevTurn)
            reusedCount += 1
            continue
        }
        const parts = runBlocks.map((block) => visibleBlockToTurnContentPart(block, partCache))
        nextTurnsById.set(turnId, {
            id: turnId,
            blocks: runBlocks,
            parts,
            timestamp,
            invokedAt,
            durationMs,
            usage,
            model,
            roundSummary,
            turnCount,
        })
    }
    if (reusedCount === nextTurnsById.size && nextTurnsById.size === previousTurnsById.size) {
        return previousTurnsById as Map<string, TurnEntitySnapshot>
    }
    return nextTurnsById
}
