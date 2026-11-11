import type { AgentState } from '@/types/api'
import type { AgentEvent, ChatBlock, NormalizedMessage, UsageData } from '@/chat/types'
import type { ThreadGoal } from '@/types/api'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents, foldCompactionEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'
import { isRedundantGoalStatusMessageText } from '@hapi/protocol/messages'
import type { TurnState } from '@hapi/protocol'
import type { RetainedTimelineSuffix } from '@/chat/replayBoundary'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    if (typeof usage.context_tokens === 'number') {
        return usage.context_tokens
    }
    return (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens
}

/**
 * Whether a message's usage describes the *parent* thread's context.
 *
 * A Task subagent runs with its own, much smaller context, so letting its usage
 * through makes the status bar's numerator collapse mid-run and snap back when
 * the parent resumes. `scope_role` alone cannot catch this: Claude never stamps
 * it (see sdkToLogConverter.ts), and Codex drops child `token_count` events in
 * the CLI before they reach us — so the guard never actually fires on any path.
 * `isSidechain` is the signal that survives both.
 */
function isUsageVisibleInParentContext(msg: NormalizedMessage): boolean {
    if (msg.isSidechain) return false
    return msg.usage?.scope_role !== 'child'
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    contextWindow: number | null
    /**
     * Model reported by the usage-bearing message itself. Local-mode Claude
     * sessions often have session.model = null (the model is picked inside the
     * TUI), so this is the only model signal available for the context-window
     * heuristic when the usage carries no explicit context_window.
     */
    model: string | null
    timestamp: number
}

export type ThreadGoalPrefixSummary = {
    readonly rawGoal: ThreadGoal | null
    readonly sawNewerNonGoalUserMessage: boolean
}

export type TimelineCheckpoint = {
    readonly blocks: readonly ChatBlock[]
    readonly hasReadyEvent: boolean
}

export type ReduceChatBlocksOptions = {
    goalStateMessages?: NormalizedMessage[]
    prefixGoalSummary?: ThreadGoalPrefixSummary | null
    prefixToolIds?: ReadonlySet<string>
    oldestWindowMessageTime?: number | null
    retainedTimelineSuffix?: RetainedTimelineSuffix | null
}

export function buildThreadGoalPrefixSummary(
    normalized: readonly NormalizedMessage[]
): ThreadGoalPrefixSummary {
    let sawNewerNonGoalUserMessage = false
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.role === 'user') {
            if (!/^\s*\/goal(?:\s|$)/i.test(msg.content.text)) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        if (msg.role !== 'event') continue
        const event = msg.content as AgentEvent
        if (event.type === 'thread-goal-cleared') {
            return { rawGoal: null, sawNewerNonGoalUserMessage }
        }
        if (event.type === 'thread-goal-updated') {
            const record = event as { goal?: ThreadGoal }
            return { rawGoal: record.goal ?? null, sawNewerNonGoalUserMessage }
        }
    }
    return { rawGoal: null, sawNewerNonGoalUserMessage }
}

export function getLatestThreadGoal(
    normalized: readonly NormalizedMessage[],
    prefixGoalSummary?: ThreadGoalPrefixSummary | null
): ThreadGoal | null {
    let sawNewerNonGoalUserMessage = false
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.role === 'user') {
            if (!/^\s*\/goal(?:\s|$)/i.test(msg.content.text)) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        if (msg.role !== 'event') continue
        const event = msg.content as AgentEvent
        if (event.type === 'thread-goal-cleared') return null
        if (event.type === 'thread-goal-updated') {
            const record = event as { goal?: ThreadGoal }
            const goal = record.goal ?? null
            if (goal?.status === 'complete' && sawNewerNonGoalUserMessage) {
                return null
            }
            return goal
        }
    }
    const fallbackGoal = prefixGoalSummary?.rawGoal ?? null
    if (!fallbackGoal) return null
    if (
        fallbackGoal.status === 'complete'
        && (sawNewerNonGoalUserMessage || prefixGoalSummary?.sawNewerNonGoalUserMessage)
    ) {
        return null
    }
    return fallbackGoal
}

export function findLatestUsageInMessages(
    normalized: readonly NormalizedMessage[]
): LatestUsage | null {
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage && isUsageVisibleInParentContext(msg)) {
            return {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                contextSize: calculateContextSize(msg.usage),
                contextWindow: msg.usage.context_window ?? null,
                model: msg.model ?? null,
                timestamp: msg.createdAt
            }
        }
    }
    return null
}

function isRedundantGoalStatusMessage(event: AgentEvent): boolean {
    if (event.type !== 'message') return false
    return isRedundantGoalStatusMessageText(event.message)
}

function isSilentGoalEventBlock(block: ChatBlock): boolean {
    return block.kind === 'agent-event'
        && (
            block.event.type === 'thread-goal-updated'
            || block.event.type === 'thread-goal-cleared'
            || isRedundantGoalStatusMessage(block.event)
        )
}

function filterSilentGoalBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const filtered: ChatBlock[] = []

    for (const block of blocks) {
        if (isSilentGoalEventBlock(block)) continue
        if (block.kind === 'tool-call' && block.children.length > 0) {
            filtered.push({
                ...block,
                children: filterSilentGoalBlocks(block.children)
            })
            continue
        }
        filtered.push(block)
    }

    return filtered
}

function collectRenderedToolIds(blocks: ChatBlock[]): Set<string> {
    const ids = new Set<string>()

    const visit = (items: ChatBlock[]): void => {
        for (const block of items) {
            if (block.kind !== 'tool-call') continue
            ids.add(block.tool.id)
            visit(block.children)
        }
    }

    visit(blocks)
    return ids
}

function collapseAssistantSnapshots(messages: NormalizedMessage[]): NormalizedMessage[] {
    const positions = new Map<string, number>()
    const result: NormalizedMessage[] = []
    for (const message of messages) {
        const snapshot = message.role === 'agent' ? message.streamSnapshot : undefined
        if (!snapshot) {
            result.push(message)
            continue
        }
        const position = positions.get(snapshot.id)
        if (position === undefined) {
            positions.set(snapshot.id, result.length)
            result.push(message)
            continue
        }
        const previous = result[position]
        // A replayed live update must never resurrect content removed by a final.
        if (previous.role === 'agent' && previous.streamSnapshot?.live === false && snapshot.live) continue
        result[position] = { ...message, createdAt: previous.createdAt }
    }
    return result
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined,
    options: ReduceChatBlocksOptions = {}
): { blocks: ChatBlock[]; timeline: TimelineCheckpoint; hasReadyEvent: boolean; latestUsage: LatestUsage | null; latestGoal: ThreadGoal | null } {
    // Retain lifecycle authority even when a newer content snapshot replaces its message.
    const lifecycleMessages: readonly TracedMessage[] = normalized
    const turnStates = new Map<string, TurnState>()
    for (const msg of lifecycleMessages) {
        if (
            !msg.isSidechain
            && msg.sidechainId === undefined
            && msg.parentToolUseId == null
            && msg.turnId !== undefined
            && msg.turnState !== undefined
            && msg.turnState !== 'history'
            && (msg.turnState !== 'running' || !turnStates.has(msg.turnId))
        ) {
            // A replayed running snapshot cannot reopen a canonically closed turn.
            turnStates.set(msg.turnId, msg.turnState)
        }
    }

    normalized = collapseAssistantSnapshots(normalized)
    const permissionsById = getPermissions(agentState)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = {
        permissionsById,
        groups,
        consumedGroupIds,
        titleChangesByToolUseId,
        emittedTitleChangeToolUseIds,
        turnStates
    }
    const retained = options.retainedTimelineSuffix
    const suffixStart = retained ? root.findIndex((msg) => msg.id === retained.startMessageId) : -1
    const rootResult = reduceTimeline(suffixStart >= 0 ? root.slice(0, suffixStart) : root, reducerContext)
    if (retained && suffixStart >= 0) rootResult.blocks.push(...retained.blocks)
    const hasReadyEvent = rootResult.hasReadyEvent || Boolean(suffixStart >= 0 && retained?.hasReadyEvent)
    // Permission synthesis mutates rootResult.blocks; the checkpoint owns the earlier stage.
    const timeline: TimelineCheckpoint = { blocks: rootResult.blocks, hasReadyEvent }
    const renderedToolIds = collectRenderedToolIds(rootResult.blocks)

    // Synthesize a tool card only for a *pending* permission that has no tool
    // call/result in the transcript — so the user can still answer it when its
    // tool_use message hasn't loaded. A resolved request (approved/denied/
    // canceled) is history: agentState keeps it in completedRequests, but
    // synthesizing it here appends a card to the end of the timeline (there is
    // no chronological re-sort), pinning a stale "answered" card above the
    // composer forever. Resolved requests render only via their own message,
    // when it is in the window.
    // Also skip if the permission is older than the oldest message in the
    // current view, to avoid mixing old tool cards with newer messages when
    // paginating.
    const oldestMessageTime = options.oldestWindowMessageTime !== undefined
        ? options.oldestWindowMessageTime
        : normalized.length > 0
            ? Math.min(...normalized.map(m => m.createdAt))
            : null

    for (const [id, entry] of permissionsById) {
        if (entry.permission.status !== 'pending') continue
        if (renderedToolIds.has(id) || options.prefixToolIds?.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()

        // Skip permissions that are older than the oldest message in the current view.
        // These will be shown when the user loads older messages.
        if (oldestMessageTime !== null && createdAt < oldestMessageTime) {
            continue
        }
        if (rootResult.blocks === timeline.blocks) rootResult.blocks = [...rootResult.blocks]

        ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })
    }

    const latestUsage = findLatestUsageInMessages(normalized)

    return {
        blocks: filterSilentGoalBlocks(foldCompactionEvents(dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks)))),
        timeline,
        hasReadyEvent,
        latestUsage,
        latestGoal: getLatestThreadGoal(options.goalStateMessages ?? normalized, options.prefixGoalSummary)
    }
}
