// Pure domain session entity store (no React imports).
import { isCliOutputText } from '@/chat/reducerCliOutput'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { buildConversationOutline, type ConversationOutlineItem } from '@/chat/outline'
import {
    areSessionStatusDataEqual,
    buildSessionStatusData,
    buildSessionStatusPrefixSummary,
    type SessionStatusPrefixSummary,
    type SessionStatusData,
} from '@/chat/sessionStatus'
import { buildThreadGoalPrefixSummary, findLatestUsageInMessages, reduceChatBlocks, type LatestUsage, type ThreadGoalPrefixSummary } from '@/chat/reducer'
import {
    isLegacyCompactionEndEvent,
    isLegacyCompactionStartEvent,
    isSkippedOmpCompactionEvent,
    parseMessageAsEvent,
} from '@/chat/reducerEvents'
import { reconcileChatBlocks, type ChatBlocksById } from '@/chat/reconcile'
import { isSubagentToolName } from '@/chat/subagentTool'
import {
    buildVisibleChatBlocks,
    isToolGroupBlock,
    visibleBlockRole,
    type ToolGroupBlock,
    type VisibleChatBlock,
    type VisibleChatBlockRole,
} from '@/chat/toolGroups'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@/chat/types'
import {
    buildThreadTopology,
    buildTurnHeadersById,
    buildTurnLayoutsById,
    assignThreadMessageIdsWithStableWrappers,
    buildTurnEntitiesById,
    filterVisibleBlocksForFlavor,
    getTurnCopyableText,
    getBlockPresentationTimestamp,
    hoistMidTurnTitleEvents,
    visibleBlockToTurnContentPart,
    type BlockWithThreadMessageId,
    type TurnEntityContentPart,
    type TurnEntitySnapshot,
    type TurnHeaderSnapshot,
    type ThreadMessageTopology,
    type TurnLayoutSnapshot,
} from '@/lib/assistant-runtime-blocks'
import { isDisplayedInQueueBar } from '@/lib/messages'
import type { MessageWindowOperation } from '@/lib/message-window-store'
import { findRetainedTimelineSuffix } from '@/chat/replayBoundary'
import type { TimelineCheckpoint } from '@/chat/reducer'
import type { AgentState, DecryptedMessage, SessionMetadataSummary, ThreadGoal } from '@/types/api'

export type { TurnEntityContentPart, TurnEntitySnapshot, TurnHeaderSnapshot, TurnLayoutSnapshot }
export type TimelineEntryRef = ThreadMessageTopology

export type SessionEntityMetaSnapshot = {
    readonly latestUsage: LatestUsage | null
    readonly contextSize?: number
    readonly latestGoal: ThreadGoal | null
    readonly hasReadyEvent: boolean
    readonly hasRunningChildAgent: boolean
    readonly activityLabel: string | null
    readonly isSending: boolean
    readonly queuedMessages: readonly DecryptedMessage[]
    readonly outlineItems: readonly ConversationOutlineItem[]
    readonly sessionStatus: SessionStatusData | null
    readonly latestRefusalEvent: NormalizedMessage | null
}

export type SessionEntityStoreInput = {
    readonly sessionId: string | null
    readonly messages: readonly DecryptedMessage[]
    readonly goalSourceMessages?: readonly DecryptedMessage[]
    readonly agentState?: AgentState | null | undefined
    readonly metadata?: SessionMetadataSummary | null
    readonly backgroundTaskCount?: number
    readonly hasMoreMessages?: boolean
    readonly codexExplorationCollapsed?: boolean
    readonly activeTurnId?: string | null
    readonly sessionThinking?: boolean
    readonly windowOperation?: MessageWindowOperation | null
}

export type SessionEntityStoreSnapshot = {
    readonly sessionId: string | null
    readonly visibleMessages: readonly DecryptedMessage[]
    readonly normalizedMessages: readonly NormalizedMessage[]
    readonly timelineIndex: readonly TimelineEntryRef[]
    readonly timelineStructureKey: string
    readonly timelineVersion: number
    readonly runtimeTopologyVersion: number
    readonly blocks: readonly ChatBlock[]
    readonly byId: ChatBlocksById
    readonly visibleBlocks: readonly VisibleChatBlock[]
    readonly visibleById: ReadonlyMap<string, VisibleChatBlock>
    readonly blocksWithThreadIds: readonly BlockWithThreadMessageId[]
    readonly turnsById: ReadonlyMap<string, TurnEntitySnapshot>
    readonly turnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>
    readonly turnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>
    readonly outlineItems: readonly ConversationOutlineItem[]
    readonly sessionStatus: SessionStatusData | null
    readonly meta: SessionEntityMetaSnapshot
    readonly latestUsage: LatestUsage | null
    readonly latestGoal: ThreadGoal | null
    readonly hasReadyEvent: boolean
    readonly hasRunningChildAgent: boolean
    readonly activityLabel: string | null
    readonly hasLiveStreamingMessage: boolean
    readonly reductionMode: 'incremental-tail' | 'incremental-prepend' | 'full' | 'noop'
    readonly replay?: { readonly rows: number; readonly reason: string }
    readonly splitIndex: number
}

type SettledPrefixCache = {
    readonly prefixMessages: readonly NormalizedMessage[]
    readonly rawPrefix: readonly DecryptedMessage[]
    readonly prefixVisibleMessages: readonly DecryptedMessage[]
    readonly prefixSeenMessageIds: ReadonlySet<string>
    readonly boundaryMessageId: string
    readonly prefixGoalSummary: ThreadGoalPrefixSummary
    readonly prefixLatestRefusalEvent: NormalizedMessage | null
    readonly prefixStatusSummary: SessionStatusPrefixSummary
    readonly absorbedTailMessages: ReadonlySet<string>
    readonly prefixRunningToolIds: ReadonlySet<string>
    readonly splitIndex: number
    readonly splitCreatedAt: number
    readonly prefixBlocks: readonly ChatBlock[]
    readonly prefixById: ChatBlocksById
    readonly prefixTimeline: TimelineCheckpoint
    readonly prefixVisibleBlocks: readonly VisibleChatBlock[]
    readonly prefixToolGroups: readonly ToolGroupBlock[]
    readonly prefixHasMoreMessages: boolean
    readonly prefixCodexExplorationCollapsed: boolean
    readonly prefixFlavor: string | null | undefined
    readonly prefixMetadata: SessionMetadataSummary | null | undefined
    readonly prefixPermissionsSignature: string
    readonly prefixToolIds: ReadonlySet<string>
    readonly prefixUuids: ReadonlySet<string>
    readonly prefixPrompts: ReadonlySet<string>
    readonly prefixStreamIds: ReadonlySet<string>
    readonly prefixTitleChanges: ReadonlySet<string>
    readonly prefixWorkCardIds: ReadonlySet<string>
    readonly prefixLatestUsage: LatestUsage | null
    readonly prefixHasReadyEvent: boolean
    readonly prefixRawIdSeen: ReadonlyMap<string, number>
    readonly prefixUsedGroupIds: ReadonlySet<string>
    readonly prefixGroupByRawId: ReadonlyMap<string, string>
    readonly prefixBlocksWithThreadIds: readonly BlockWithThreadMessageId[]
    readonly prefixVisibleById: ReadonlyMap<string, VisibleChatBlock>
    readonly prefixTurnsById: ReadonlyMap<string, TurnEntitySnapshot>
    readonly prefixTurnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>
    readonly prefixTurnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>
    readonly prefixTimelineIndex: readonly TimelineEntryRef[]
    readonly prefixOutlineItems: readonly ConversationOutlineItem[]
}

// Prefix and tail keys are disjoint at a root user-turn boundary.
class DisjointOverlayMap<K, V> implements ReadonlyMap<K, V> {
    constructor(private readonly prefix: ReadonlyMap<K, V>, private readonly tail: ReadonlyMap<K, V>) {}
    get size(): number { return this.prefix.size + this.tail.size }
    get(key: K): V | undefined { return this.tail.get(key) ?? this.prefix.get(key) }
    has(key: K): boolean { return this.tail.has(key) || this.prefix.has(key) }
    *entries(): MapIterator<[K, V]> { yield* this.prefix; yield* this.tail }
    *keys(): MapIterator<K> { yield* this.prefix.keys(); yield* this.tail.keys() }
    *values(): MapIterator<V> { yield* this.prefix.values(); yield* this.tail.values() }
    [Symbol.iterator](): MapIterator<[K, V]> { return this.entries() }
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this) callback.call(thisArg, value, key, this)
    }
}

function findLatestRefusalEvent(messages: readonly NormalizedMessage[]): NormalizedMessage | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!
        if (message.role === 'event' && message.content.type === 'model-refusal-fallback') return message
    }
    return null
}

const EMPTY_TIMELINE_INDEX: readonly TimelineEntryRef[] = Object.freeze([])
const EMPTY_BLOCKS: readonly ChatBlock[] = Object.freeze([])
const EMPTY_BY_ID: ChatBlocksById = new Map()
const EMPTY_VISIBLE_BLOCKS: readonly VisibleChatBlock[] = Object.freeze([])
const EMPTY_VISIBLE_BY_ID: ReadonlyMap<string, VisibleChatBlock> = new Map()
const EMPTY_BLOCKS_WITH_THREAD_IDS: readonly BlockWithThreadMessageId[] = Object.freeze([])
const EMPTY_TURNS_BY_ID: ReadonlyMap<string, TurnEntitySnapshot> = new Map()
const EMPTY_TURN_LAYOUTS: ReadonlyMap<string, TurnLayoutSnapshot> = new Map()
const EMPTY_TURN_HEADERS: ReadonlyMap<string, TurnHeaderSnapshot> = new Map()
const EMPTY_VISIBLE_MESSAGES: readonly DecryptedMessage[] = Object.freeze([])
const EMPTY_NORMALIZED_MESSAGES: readonly NormalizedMessage[] = Object.freeze([])
const EMPTY_QUEUED_MESSAGES: readonly DecryptedMessage[] = Object.freeze([])
const EMPTY_OUTLINE_ITEMS: readonly ConversationOutlineItem[] = Object.freeze([])
const EMPTY_META: SessionEntityMetaSnapshot = Object.freeze({
    latestUsage: null,
    contextSize: undefined,
    latestGoal: null,
    hasReadyEvent: false,
    hasRunningChildAgent: false,
    activityLabel: null,
    isSending: false,
    queuedMessages: EMPTY_QUEUED_MESSAGES,
    outlineItems: EMPTY_OUTLINE_ITEMS,
    sessionStatus: null,
    latestRefusalEvent: null,
})

function isSilentGoalCommandText(text: string): boolean {
    return /^\/goal(?:\s|$)/i.test(text.trim())
}

function isRootUserTurnBoundaryMessage(msg: NormalizedMessage): boolean {
    if (msg.role !== 'user') return false
    if (msg.steered) return false
    if (msg.isSidechain || msg.parentToolUseId) return false
    if (isCliOutputText(msg.content.text, msg.meta)) return false
    if (isSilentGoalCommandText(msg.content.text)) return false
    return true
}

function findLatestUserTurnSplitIndex(
    normalized: readonly NormalizedMessage[],
    excludedMessageIds?: ReadonlySet<string>
): number {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
        const msg = normalized[i]!
        if (excludedMessageIds?.has(msg.id)) continue
        if (isRootUserTurnBoundaryMessage(msg)) {
            return i
        }
    }
    return -1
}

function hasOpenCompactionInBlocks(blocks: readonly ChatBlock[]): boolean {
    let openOmpCompaction = false
    let openLegacyCompaction = false
    for (const block of blocks) {
        if (block.kind !== 'agent-event' || !block.event) continue
        const event = block.event
        if (event.type === 'omp-compaction') {
            const record = event as Record<string, unknown>
            const frame = typeof record.frame === 'object' && record.frame !== null
                ? (record.frame as Record<string, unknown>)
                : null
            const phase = typeof record.phase === 'string'
                ? record.phase
                : frame?.type === 'auto_compaction_start'
                    ? 'started'
                    : frame?.type === 'auto_compaction_end'
                        ? 'finished'
                        : undefined
            if (phase === 'started') {
                openOmpCompaction = true
            } else if (phase === 'finished') {
                openOmpCompaction = false
            }
            continue
        }
        if (isLegacyCompactionStartEvent(event)) {
            openLegacyCompaction = true
            continue
        }
        if (isLegacyCompactionEndEvent(event)) {
            openLegacyCompaction = false
        }
    }
    return openOmpCompaction || openLegacyCompaction
}

function hasUnsettledPrefixBlocks(blocks: readonly ChatBlock[]): boolean {
    if (hasOpenCompactionInBlocks(blocks)) return true
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        if (
            (block.tool.state === 'running' && (!isSubagentToolName(block.tool.name) || block.children.length > 0))
            || block.tool.state === 'pending'
            || block.tool.permission?.status === 'pending'
        ) {
            return true
        }
    }
    return false
}

function hasUnsettledPrefixMessages(messages: readonly NormalizedMessage[]): boolean {
    for (const msg of messages) {
        if (msg.role === 'agent' && (msg.live === true || msg.streamSnapshot?.live === true)) {
            return true
        }
    }
    return false
}

function collectPrefixLookupSets(
    prefixMessages: readonly NormalizedMessage[],
    prefixBlocks: readonly ChatBlock[]
): {
    prefixToolIds: Set<string>
    prefixUuids: Set<string>
    prefixPrompts: Set<string>
    prefixStreamIds: Set<string>
    prefixTitleChanges: Set<string>
    prefixWorkCardIds: Set<string>
} {
    const prefixToolIds = new Set<string>()
    const prefixUuids = new Set<string>()
    const prefixPrompts = new Set<string>()
    const prefixStreamIds = new Set<string>()
    const prefixTitleChanges = new Set<string>()
    const prefixWorkCardIds = new Set<string>()

    for (const block of prefixBlocks) {
        prefixUuids.add(block.id)
        if (block.kind === 'tool-call') {
            prefixToolIds.add(block.id)
            if (block.tool.id) prefixToolIds.add(block.tool.id)
        }
    }

    for (const msg of prefixMessages) {
        prefixUuids.add(msg.id)
        if (msg.parentToolUseId) prefixToolIds.add(msg.parentToolUseId)
        if (msg.role === 'agent' && msg.streamSnapshot?.id) {
            prefixStreamIds.add(msg.streamSnapshot.id)
        }

        const parsedEvent = parseMessageAsEvent(msg)
        if (parsedEvent?.type === 'title-changed' && typeof parsedEvent.title === 'string') {
            const title = parsedEvent.title.trim()
            if (title) prefixTitleChanges.add(title)
        }

        if (msg.role === 'event') {
            const content = msg.content as { type: string; [key: string]: unknown }
            if (content.type === 'agent_run_status' || content.type === 'agent_run_trace') {
                const agentId = typeof content.agentId === 'string' ? content.agentId.trim() : ''
                if (agentId) prefixWorkCardIds.add(`agent:${agentId}`)
            } else if (content.type === 'file-mutation') {
                const id = typeof content.id === 'string' ? content.id.trim() : ''
                if (id) prefixWorkCardIds.add(`mutation:${id}`)
            } else if (content.type === 'permission-request') {
                const requestId = typeof content.requestId === 'string' ? content.requestId.trim() : ''
                const toolUseId = typeof content.toolUseId === 'string' ? content.toolUseId.trim() : ''
                const id = requestId || toolUseId || msg.id
                if (id) {
                    prefixWorkCardIds.add(`permission:${id}`)
                    prefixToolIds.add(id)
                }
            }
            continue
        }

        if (msg.role === 'agent') {
            for (const c of msg.content) {
                if ('uuid' in c && typeof c.uuid === 'string' && c.uuid) {
                    prefixUuids.add(c.uuid)
                }
                if ((c.type === 'text' || c.type === 'reasoning') && c.streamId) {
                    prefixStreamIds.add(c.streamId)
                } else if (c.type === 'tool-call') {
                    prefixToolIds.add(c.id)
                    if (isSubagentToolName(c.name) && typeof c.input === 'object' && c.input !== null && 'prompt' in c.input) {
                        const prompt = (c.input as { prompt?: unknown }).prompt
                        if (typeof prompt === 'string' && prompt.trim()) {
                            prefixPrompts.add(prompt)
                        }
                    }
                } else if (c.type === 'tool-result') {
                    prefixToolIds.add(c.tool_use_id)
                }
            }
        }
    }

    return {
        prefixToolIds,
        prefixUuids,
        prefixPrompts,
        prefixStreamIds,
        prefixTitleChanges,
        prefixWorkCardIds,
    }
}

function computePrefixPermissionsSignature(
    agentState: AgentState | null | undefined,
    prefixToolIds: ReadonlySet<string>,
    splitCreatedAt: number
): string {
    if (!agentState) return ''
    const parts: string[] = []
    if (agentState.requests) {
        for (const [id, req] of Object.entries(agentState.requests)) {
            const createdAt = req.createdAt ?? 0
            if (prefixToolIds.has(id) || createdAt <= splitCreatedAt) {
                parts.push(`req:${id}:${req.tool}:${createdAt}`)
            }
        }
    }
    if (agentState.completedRequests) {
        for (const [id, completed] of Object.entries(agentState.completedRequests)) {
            if (prefixToolIds.has(id)) {
                parts.push(
                    `done:${id}:${completed.status}:${completed.completedAt ?? 0}:${completed.reason ?? ''}`
                )
            }
        }
    }
    parts.sort()
    return parts.join('|')
}

function tailMessageReferencesPrefix(
    msg: NormalizedMessage,
    cache: SettledPrefixCache
): boolean {
    if (msg.role === 'user' && isCliOutputText(msg.content.text, msg.meta)) {
        return true
    }
    if (msg.role === 'agent') {
        if (msg.streamSnapshot?.id && cache.prefixStreamIds.has(msg.streamSnapshot.id)) {
            return true
        }
        for (const c of msg.content) {
            if (msg.isSidechain && 'parentUUID' in c && typeof c.parentUUID === 'string' && cache.prefixUuids.has(c.parentUUID)) {
                return true
            }
        }
    }
    if (msg.isSidechain && msg.parentToolUseId && cache.prefixToolIds.has(msg.parentToolUseId)) {
        return true
    }
    if (msg.role === 'event') {
        const content = msg.content as { type: string; [key: string]: unknown }
        if (content.type === 'turn-duration') {
            const targetMessageId = typeof content.targetMessageId === 'string' ? content.targetMessageId : null
            if (!targetMessageId || cache.prefixUuids.has(targetMessageId) || cache.prefixToolIds.has(targetMessageId)) {
                return true
            }
        }
        if (content.type === 'omp-compaction') {
            const phase = typeof content.phase === 'string' ? content.phase : undefined
            if (phase === 'finished' && isSkippedOmpCompactionEvent(content as { type: string })) {
                return true
            }
        }
        if (content.type === 'agent_run_status' || content.type === 'agent_run_trace') {
            const agentId = typeof content.agentId === 'string' ? content.agentId.trim() : ''
            if (agentId && cache.prefixWorkCardIds.has(`agent:${agentId}`)) {
                return true
            }
        }
        if (content.type === 'file-mutation') {
            const id = typeof content.id === 'string' ? content.id.trim() : ''
            if (id && cache.prefixWorkCardIds.has(`mutation:${id}`)) {
                return true
            }
        }
        if (content.type === 'permission-request') {
            const requestId = typeof content.requestId === 'string' ? content.requestId.trim() : ''
            const toolUseId = typeof content.toolUseId === 'string' ? content.toolUseId.trim() : ''
            const id = requestId || toolUseId || msg.id
            if (cache.prefixWorkCardIds.has(`permission:${id}`) || cache.prefixToolIds.has(id)) {
                return true
            }
        }
        return false
    }

    if (msg.role === 'agent') {
        if (msg.isSidechain && msg.content[0]?.type === 'text') {
            const promptText = msg.content[0].text
            if (cache.prefixPrompts.has(promptText)) {
                return true
            }
        }
        for (const c of msg.content) {
            if ((c.type === 'text' || c.type === 'reasoning') && c.streamId && cache.prefixStreamIds.has(c.streamId)) {
                return true
            }
            if (c.type === 'tool-call' && cache.prefixToolIds.has(c.id)) {
                return true
            }
            if (c.type === 'tool-result' && cache.prefixToolIds.has(c.tool_use_id)) {
                return true
            }
            if (c.type === 'summary' && cache.prefixTitleChanges.has(c.summary.trim())) {
                return true
            }
        }
    }

    return false
}

function canSliceRawTailFromPrefixCache(input: SessionEntityStoreInput, cache: SettledPrefixCache | null): cache is SettledPrefixCache {
    if (!cache || input.messages.length < cache.rawPrefix.length) return false
    if (input.hasMoreMessages !== undefined && input.hasMoreMessages !== cache.prefixHasMoreMessages) return false
    if (Boolean(input.codexExplorationCollapsed) !== cache.prefixCodexExplorationCollapsed) return false
    if (input.metadata?.flavor !== cache.prefixFlavor) return false
    if ((input.metadata ?? null) !== (cache.prefixMetadata ?? null)) return false
    if (computePrefixPermissionsSignature(input.agentState, cache.prefixToolIds, cache.splitCreatedAt) !== cache.prefixPermissionsSignature) return false
    const operation = input.windowOperation
    if (operation?.kind === 'prepend-history') return false
    if (
        operation?.kind === 'replace-window'
        && (operation.reason === 'session-switch' || operation.reason === 'epoch-reset')
    ) {
        return false
    }
    if (operation) {
        if (operation.removedIds.some((id) => cache.prefixSeenMessageIds.has(id))) {
            return false
        }
        if (operation.kind === 'append-tail' || operation.kind === 'upsert-live-stream') {
            if (input.messages[0] !== cache.rawPrefix[0] || input.messages[cache.rawPrefix.length - 1] !== cache.rawPrefix.at(-1)) return false
            const changed = operation.kind === 'append-tail' ? operation.messages : [operation.message]
            return changed.every((message) => !cache.prefixSeenMessageIds.has(message.id))
        }
    }
    return cache.rawPrefix.every((message, index) => input.messages[index] === message)
}


function isSameLatestUsage(a: LatestUsage | null, b: LatestUsage | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.inputTokens === b.inputTokens
        && a.outputTokens === b.outputTokens
        && a.cacheCreation === b.cacheCreation
        && a.cacheRead === b.cacheRead
        && a.contextSize === b.contextSize
        && a.contextWindow === b.contextWindow
        && a.model === b.model
        && a.timestamp === b.timestamp
}

function isSameThreadGoal(a: ThreadGoal | null, b: ThreadGoal | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.threadId === b.threadId
        && a.objective === b.objective
        && a.status === b.status
        && a.tokenBudget === b.tokenBudget
        && a.tokensUsed === b.tokensUsed
        && a.timeUsedSeconds === b.timeUsedSeconds
        && a.updatedAt === b.updatedAt
}

function isSameArrayElements<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = a.length - 1; i >= 0; i -= 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

function isPurePrefixToolResultMessage(
    msg: NormalizedMessage,
    cache: SettledPrefixCache
): boolean {
    if (msg.role !== 'agent' || msg.isSidechain || msg.content.length === 0) return false
    if (cache.prefixUuids.has(msg.id)) return false
    if (msg.streamSnapshot && cache.prefixStreamIds.has(msg.streamSnapshot.id)) return false
    for (const item of msg.content) {
        if (item.type !== 'tool-result') return false
        if (item.uuid && cache.prefixUuids.has(item.uuid)) return false
        if (!cache.prefixRunningToolIds.has(item.tool_use_id)) return false
        if (cache.prefixTitleChanges.has(item.tool_use_id)) return false
    }
    return true
}

function isPureAlreadyAppliedPrefixToolResultMessage(
    msg: NormalizedMessage,
    cache: SettledPrefixCache
): boolean {
    if (msg.role !== 'agent' || msg.isSidechain || msg.content.length === 0) return false
    if (cache.prefixUuids.has(msg.id)) return false
    if (msg.streamSnapshot && cache.prefixStreamIds.has(msg.streamSnapshot.id)) return false
    for (const item of msg.content) {
        if (item.type !== 'tool-result') return false
        if (item.uuid && cache.prefixUuids.has(item.uuid)) return false
        if (cache.prefixTitleChanges.has(item.tool_use_id)) return false
        const block = cache.prefixById.get(item.tool_use_id)
        if (!block || block.kind !== 'tool-call' || block.children.length > 0 || !isSubagentToolName(block.tool.name)) {
            return false
        }
    }
    return true
}

function resolvePrefixRunningToolState(
    prefixRunningToolIds: ReadonlySet<string>,
    prefixById: ReadonlyMap<string, ChatBlock>
): { hasRunningChildAgent: boolean; activityLabel: string | null } {
    let hasRunningChildAgent = false
    let activityLabel: string | null = null
    for (const id of prefixRunningToolIds) {
        const block = prefixById.get(id)
        if (block?.kind === 'tool-call' && (block.tool.state === 'running' || block.tool.state === 'pending')) {
            activityLabel = block.tool.name
            if (block.tool.name === 'CodexAgent') {
                hasRunningChildAgent = true
            }
        }
    }
    return { hasRunningChildAgent, activityLabel }
}

function isSameMeta(a: SessionEntityMetaSnapshot, b: SessionEntityMetaSnapshot): boolean {
    if (a === b) return true
    return a.contextSize === b.contextSize
        && isSameThreadGoal(a.latestGoal, b.latestGoal)
        && a.hasReadyEvent === b.hasReadyEvent
        && a.hasRunningChildAgent === b.hasRunningChildAgent
        && a.activityLabel === b.activityLabel
        && a.isSending === b.isSending
        && isSameLatestUsage(a.latestUsage, b.latestUsage)
        && isSameArrayElements(a.queuedMessages, b.queuedMessages)
        && isSameArrayElements(a.outlineItems, b.outlineItems)
        && a.sessionStatus === b.sessionStatus
        && a.latestRefusalEvent === b.latestRefusalEvent
}

function isUninvokedScheduledMessage(message: DecryptedMessage): boolean {
    return message.invokedAt == null && message.scheduledAt != null
}

export function buildGoalStateMessages(
    messages: readonly DecryptedMessage[]
): DecryptedMessage[] {
    return messages.filter((message) => !isUninvokedScheduledMessage(message))
}

export function hasAbortableAgentRun(blocks: readonly ChatBlock[]): boolean {
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            if (
                block.tool.name === 'CodexAgent'
                && (block.tool.state === 'running' || block.tool.state === 'pending')
            ) {
                return true
            }
            if (hasAbortableAgentRun(block.children)) {
                return true
            }
        }
    }
    return false
}

export function findActiveToolActivityLabel(blocks: readonly ChatBlock[]): string | null {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index]
        if (block?.kind === 'tool-call' && (block.tool.state === 'running' || block.tool.state === 'pending')) {
            return block.tool.name
        }
    }
    return null
}

export class SessionEntityStore {
    private normalizedCache = new WeakMap<DecryptedMessage, NormalizedMessage | null>()
    private threadIdWrapperCache = new WeakMap<VisibleChatBlock, BlockWithThreadMessageId>()
    private turnPartCache = new WeakMap<VisibleChatBlock, TurnEntityContentPart>()
    private reductionCache: { prefix: SettledPrefixCache | null; timeline: TimelineCheckpoint | null } = { prefix: null, timeline: null }
    private prevTailById: ChatBlocksById = new Map()
    private prevTailToolGroups: ToolGroupBlock[] = []
    private prevTailTurnsById: ReadonlyMap<string, TurnEntitySnapshot> = EMPTY_TURNS_BY_ID
    private prevTailTurnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot> = EMPTY_TURN_LAYOUTS
    private prevTailTimelineIndex: readonly TimelineEntryRef[] = EMPTY_TIMELINE_INDEX
    private prevTailTurnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot> = EMPTY_TURN_HEADERS
    private prevTailBlocks: readonly ChatBlock[] = EMPTY_BLOCKS
    private prevTailVisibleBlocks: readonly VisibleChatBlock[] = EMPTY_VISIBLE_BLOCKS
    private prevTailVisibleById: ReadonlyMap<string, VisibleChatBlock> = EMPTY_VISIBLE_BY_ID
    private prevTailOutlineItems: ConversationOutlineItem[] = []
    private dirtyEntityIds: Set<string> | null = null
    private pendingDirtyEntityIds: Set<string> | null = new Set()
    private prevFullToolGroups: ToolGroupBlock[] = []
    private prevOutlineItems: ConversationOutlineItem[] = []
    private prevSessionStatus: SessionStatusData | null = null
    private lastInput: SessionEntityStoreInput | null = null
    private pendingNotificationBaseline: SessionEntityStoreSnapshot | null = null

    private snapshot: SessionEntityStoreSnapshot = {
        sessionId: null,
        visibleMessages: EMPTY_VISIBLE_MESSAGES,
        normalizedMessages: EMPTY_NORMALIZED_MESSAGES,
        timelineIndex: EMPTY_TIMELINE_INDEX,
        timelineStructureKey: '',
        timelineVersion: 0,
        runtimeTopologyVersion: 0,
        blocks: EMPTY_BLOCKS,
        byId: EMPTY_BY_ID,
        visibleBlocks: EMPTY_VISIBLE_BLOCKS,
        visibleById: EMPTY_VISIBLE_BY_ID,
        blocksWithThreadIds: EMPTY_BLOCKS_WITH_THREAD_IDS,
        turnsById: EMPTY_TURNS_BY_ID,
        turnLayoutsById: EMPTY_TURN_LAYOUTS,
        turnHeadersById: EMPTY_TURN_HEADERS,
        outlineItems: EMPTY_OUTLINE_ITEMS,
        sessionStatus: null,
        meta: EMPTY_META,
        latestUsage: null,
        latestGoal: null,
        hasReadyEvent: false,
        hasRunningChildAgent: false,
        activityLabel: null,
        hasLiveStreamingMessage: false,
        reductionMode: 'noop',
        splitIndex: -1,
    }

    private storeListeners = new Set<() => void>()
    private timelineListeners = new Set<() => void>()
    private runtimeTopologyListeners = new Set<() => void>()
    private metaListeners = new Set<() => void>()
    private entityListeners = new Map<string, Set<() => void>>()
    getSnapshot = (): SessionEntityStoreSnapshot => {
        return this.snapshot
    }

    getTimelineIndex = (): readonly TimelineEntryRef[] => {
        return this.snapshot.timelineIndex
    }

    getVisibleEntity = (id: string): VisibleChatBlock | undefined => {
        return this.snapshot.visibleById.get(id)
    }

    getBlockEntity = (id: string): ChatBlock | undefined => {
        return this.snapshot.byId.get(id)
    }
    getTurnEntity = (id: string): TurnEntitySnapshot | undefined => {
        return this.snapshot.turnsById.get(id)
    }

    getTurnLayout = (id: string): TurnLayoutSnapshot | undefined => {
        return this.snapshot.turnLayoutsById.get(id)
    }

    getTurnHeader = (id: string): TurnHeaderSnapshot | undefined => {
        return this.snapshot.turnHeadersById.get(id)
    }

    getCopyableText = (id: string): string => {
        const turn = this.snapshot.turnsById.get(id)
        if (turn) {
            return getTurnCopyableText(turn)
        }
        const visible = this.snapshot.visibleById.get(id)
        if (visible?.kind === 'user-text') {
            return visible.text
        }
        return ''
    }

    getRuntimeTopologyVersion = (): number => {
        return this.snapshot.runtimeTopologyVersion
    }

    getLiveTurnParts = (turnId: string): readonly TurnEntityContentPart[] | undefined => {
        const turn = this.snapshot.turnsById.get(turnId)
        if (!turn) return undefined
        return turn.parts
    }
    getPrecedingUserText = (threadMessageId: string): string => {
        const entries = this.snapshot.blocksWithThreadIds
        let currentIndex = -1
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            if (entries[i]!.threadMessageId === threadMessageId) {
                currentIndex = i
                break
            }
        }
        if (currentIndex < 0) return ''
        for (let i = currentIndex; i >= 0; i -= 1) {
            const candidate = entries[i]!.block
            if (candidate.kind === 'user-text') {
                return candidate.text.trim()
            }
        }
        return ''
    }

    getMeta = (): SessionEntityMetaSnapshot => {
        return this.snapshot.meta
    }
    subscribe = (listener: () => void): (() => void) => {
        this.storeListeners.add(listener)
        return () => {
            this.storeListeners.delete(listener)
        }
    }

    subscribeTimeline = (listener: () => void): (() => void) => {
        this.timelineListeners.add(listener)
        return () => {
            this.timelineListeners.delete(listener)
        }
    }

    subscribeRuntimeTopology = (listener: () => void): (() => void) => {
        this.runtimeTopologyListeners.add(listener)
        return () => {
            this.runtimeTopologyListeners.delete(listener)
        }
    }
    subscribeMeta = (listener: () => void): (() => void) => {
        this.metaListeners.add(listener)
        return () => {
            this.metaListeners.delete(listener)
        }
    }

    subscribeEntity = (id: string, listener: () => void): (() => void) => {
        let bucket = this.entityListeners.get(id)
        if (!bucket) {
            bucket = new Set()
            this.entityListeners.set(id, bucket)
        }
        bucket.add(listener)
        return () => {
            const current = this.entityListeners.get(id)
            if (!current) return
            current.delete(listener)
            if (current.size === 0) {
                this.entityListeners.delete(id)
            }
        }
    }

    reset(sessionId: string | null = null): void {
        const prevSnapshot = this.snapshot
        this.reductionCache = { prefix: null, timeline: null }
        this.threadIdWrapperCache = new WeakMap()
        this.turnPartCache = new WeakMap()
        this.prevTailById = new Map()
        this.prevTailToolGroups = []
        this.prevTailTurnsById = EMPTY_TURNS_BY_ID
        this.prevTailTurnLayoutsById = EMPTY_TURN_LAYOUTS
        this.prevTailTimelineIndex = EMPTY_TIMELINE_INDEX
        this.prevTailTurnHeadersById = EMPTY_TURN_HEADERS
        this.prevTailBlocks = EMPTY_BLOCKS
        this.prevTailVisibleBlocks = EMPTY_VISIBLE_BLOCKS
        this.prevTailVisibleById = EMPTY_VISIBLE_BY_ID
        this.prevTailOutlineItems = []
        this.dirtyEntityIds = null
        this.pendingDirtyEntityIds = new Set()
        this.prevFullToolGroups = []
        this.prevOutlineItems = []
        this.prevSessionStatus = null
        this.lastInput = null
        this.pendingNotificationBaseline = null
        this.snapshot = {
            sessionId,
            visibleMessages: EMPTY_VISIBLE_MESSAGES,
            normalizedMessages: EMPTY_NORMALIZED_MESSAGES,
            timelineIndex: EMPTY_TIMELINE_INDEX,
            timelineStructureKey: '',
            timelineVersion: 0,
            runtimeTopologyVersion: 0,
            blocks: EMPTY_BLOCKS,
            byId: EMPTY_BY_ID,
            visibleBlocks: EMPTY_VISIBLE_BLOCKS,
            visibleById: EMPTY_VISIBLE_BY_ID,
            blocksWithThreadIds: EMPTY_BLOCKS_WITH_THREAD_IDS,
            turnsById: EMPTY_TURNS_BY_ID,
            turnLayoutsById: EMPTY_TURN_LAYOUTS,
            turnHeadersById: EMPTY_TURN_HEADERS,
            outlineItems: EMPTY_OUTLINE_ITEMS,
            sessionStatus: null,
            meta: EMPTY_META,
            latestUsage: null,
            latestGoal: null,
            hasReadyEvent: false,
            hasRunningChildAgent: false,
            activityLabel: null,
            hasLiveStreamingMessage: false,
            reductionMode: 'noop',
            splitIndex: -1,
        }
        this.notifyChangedListeners(prevSnapshot, this.snapshot)
    }

    private normalizeMessageList(messages: readonly DecryptedMessage[], prefixSeen?: ReadonlySet<string>): NormalizedMessage[] {
        const result: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const msg of messages) {
            if (seen.has(msg.id) || prefixSeen?.has(msg.id)) {
                continue
            }
            seen.add(msg.id)
            let normalized = this.normalizedCache.get(msg)
            if (normalized === undefined) {
                normalized = normalizeDecryptedMessage(msg)
                this.normalizedCache.set(msg, normalized)
            }
            if (normalized) {
                result.push(normalized)
            }
        }
        return result
    }

    private applyPrefixToolResultMessage(
        msg: NormalizedMessage,
        cache: SettledPrefixCache,
        sessionThinking: boolean,
        metadata: SessionMetadataSummary | null | undefined
    ): { cache: SettledPrefixCache; dirtyIds: Set<string> } | null {
        if (msg.role !== 'agent') return null
        const dirtyIds = new Set<string>()
        const nextPrefixById = new Map<string, ChatBlock>(cache.prefixById)
        const nextPrefixRunningToolIds = new Set<string>(cache.prefixRunningToolIds)
        const updatedToolsByBlockId = new Map<string, ToolCallBlock>()

        for (const item of msg.content) {
            if (item.type !== 'tool-result') return null
            const existing = nextPrefixById.get(item.tool_use_id)
            if (!existing || existing.kind !== 'tool-call' || existing.children.length > 0) {
                return null
            }
            const prevPermission = existing.tool.permission
            let nextPermission = prevPermission
            let nextState: ToolCallBlock['tool']['state']
            let nextCompletedAt: number | null
            let nextExecCompletedAt = existing.tool.execCompletedAt ?? null

            if (prevPermission?.status === 'pending') {
                nextPermission = {
                    ...prevPermission,
                    status: 'approved',
                    completedAt: prevPermission.completedAt ?? msg.createdAt,
                }
            }

            if (nextPermission && nextPermission.status !== 'approved') {
                nextState = 'error'
                nextCompletedAt = nextPermission.completedAt ?? msg.createdAt
                if (item.permissions) {
                    nextPermission = {
                        ...nextPermission,
                        decision: item.permissions.decision,
                        date: item.permissions.date,
                    }
                }
            } else {
                nextState = item.is_error ? 'error' : 'completed'
                nextCompletedAt = msg.createdAt
                nextExecCompletedAt = msg.agentTimestamp ?? null
                if (item.permissions) {
                    nextPermission = nextPermission
                        ? {
                            ...nextPermission,
                            decision: item.permissions.decision,
                            date: item.permissions.date,
                        }
                        : {
                            id: item.tool_use_id,
                            status: (
                                item.permissions.decision === 'approved'
                                || item.permissions.decision === 'approved_for_session'
                            )
                                ? 'approved'
                                : 'denied',
                            decision: item.permissions.decision,
                            date: item.permissions.date,
                        }
                }
            }

            const updatedBlock: ToolCallBlock = {
                ...existing,
                tool: {
                    ...existing.tool,
                    state: nextState,
                    result: item.content,
                    completionSource: undefined,
                    completedAt: nextCompletedAt,
                    execCompletedAt: nextExecCompletedAt,
                    ...(nextPermission ? { permission: nextPermission } : {}),
                },
            }
            nextPrefixById.set(updatedBlock.id, updatedBlock)
            updatedToolsByBlockId.set(updatedBlock.id, updatedBlock)
            nextPrefixRunningToolIds.delete(item.tool_use_id)
            dirtyIds.add(updatedBlock.id)
        }

        const nextPrefixBlocks = cache.prefixBlocks.map((block) => updatedToolsByBlockId.get(block.id) ?? block)
        const nextPrefixVisibleById = new Map<string, VisibleChatBlock>(cache.prefixVisibleById)
        const updatedVisibleByBlockId = new Map<string, VisibleChatBlock>()
        const nextPrefixVisibleBlocks = cache.prefixVisibleBlocks.map((visibleBlock) => {
            const direct = updatedToolsByBlockId.get(visibleBlock.id)
            if (direct) {
                nextPrefixVisibleById.set(direct.id, direct)
                updatedVisibleByBlockId.set(direct.id, direct)
                dirtyIds.add(direct.id)
                return direct
            }
            if (visibleBlock.kind === 'tool-group' && visibleBlock.tools.some((t) => updatedToolsByBlockId.has(t.id))) {
                const updatedGroup: ToolGroupBlock = {
                    ...visibleBlock,
                    tools: visibleBlock.tools.map((t) => updatedToolsByBlockId.get(t.id) ?? t),
                }
                nextPrefixVisibleById.set(updatedGroup.id, updatedGroup)
                updatedVisibleByBlockId.set(updatedGroup.id, updatedGroup)
                dirtyIds.add(updatedGroup.id)
                return updatedGroup
            }
            return visibleBlock
        })
        const nextPrefixToolGroups = nextPrefixVisibleBlocks.filter(isToolGroupBlock)

        const affectedTurnIds = new Set<string>()
        for (const visibleId of updatedVisibleByBlockId.keys()) {
            const turnId = cache.prefixGroupByRawId.get(`block:${visibleId}`)
            if (turnId) affectedTurnIds.add(turnId)
        }

        const nextPrefixBlocksWithThreadIds = [...cache.prefixBlocksWithThreadIds]
        const nextPrefixTurnsById = new Map<string, TurnEntitySnapshot>(cache.prefixTurnsById)
        const nextPrefixTurnLayoutsById = new Map<string, TurnLayoutSnapshot>(cache.prefixTurnLayoutsById)
        const nextPrefixTurnHeadersById = new Map<string, TurnHeaderSnapshot>(cache.prefixTurnHeadersById)

        for (const turnId of affectedTurnIds) {
            let runStart = -1
            for (let i = 0; i < nextPrefixBlocksWithThreadIds.length; i += 1) {
                const entry = nextPrefixBlocksWithThreadIds[i]!
                if (visibleBlockRole(entry.block) === 'assistant' && entry.threadMessageId === turnId) {
                    runStart = i
                    break
                }
            }
            if (runStart < 0) continue
            let runEnd = runStart
            while (
                runEnd + 1 < nextPrefixBlocksWithThreadIds.length
                && visibleBlockRole(nextPrefixBlocksWithThreadIds[runEnd + 1]!.block) === 'assistant'
            ) {
                runEnd += 1
            }
            let maxTimestamp = 0
            for (let idx = runStart; idx <= runEnd; idx += 1) {
                const entry = nextPrefixBlocksWithThreadIds[idx]!
                const candidateBlock = updatedVisibleByBlockId.get(entry.block.id) ?? entry.block
                const ts = getBlockPresentationTimestamp(candidateBlock)
                if (ts > maxTimestamp) maxTimestamp = ts
            }
            const turnEntries: BlockWithThreadMessageId[] = []
            for (let idx = runStart; idx <= runEnd; idx += 1) {
                const prevEntry = nextPrefixBlocksWithThreadIds[idx]!
                const nextBlock = updatedVisibleByBlockId.get(prevEntry.block.id) ?? prevEntry.block
                const nextTimestamp = idx === runStart ? maxTimestamp : getBlockPresentationTimestamp(nextBlock)
                const nextEntry: BlockWithThreadMessageId = (
                    nextBlock === prevEntry.block && nextTimestamp === prevEntry.timestamp
                )
                    ? prevEntry
                    : {
                        ...prevEntry,
                        block: nextBlock,
                        timestamp: nextTimestamp,
                    }
                if (nextEntry !== prevEntry) {
                    this.threadIdWrapperCache.set(nextBlock, nextEntry)
                    nextPrefixBlocksWithThreadIds[idx] = nextEntry
                }
                turnEntries.push(nextEntry)
            }
            const rebuiltTurns = buildTurnEntitiesById(turnEntries, cache.prefixTurnsById, this.turnPartCache)
            const updatedTurn = rebuiltTurns.get(turnId)
            if (updatedTurn) {
                nextPrefixTurnsById.set(turnId, updatedTurn)
                const rebuiltLayouts = buildTurnLayoutsById(rebuiltTurns, cache.prefixTurnLayoutsById, metadata ?? null)
                const updatedLayout = rebuiltLayouts.get(turnId)
                if (updatedLayout) {
                    nextPrefixTurnLayoutsById.set(turnId, updatedLayout)
                }
                const rebuiltHeaders = buildTurnHeadersById(
                    rebuiltTurns,
                    cache.prefixTimelineIndex,
                    sessionThinking,
                    cache.prefixTurnHeadersById
                )
                const updatedHeader = rebuiltHeaders.get(turnId)
                if (updatedHeader) {
                    nextPrefixTurnHeadersById.set(turnId, updatedHeader)
                }
            }
            dirtyIds.add(turnId)
            dirtyIds.add(`layout:${turnId}`)
            dirtyIds.add(`header:${turnId}`)
        }

        const nextAbsorbedTailMessages = new Set<string>(cache.absorbedTailMessages)
        nextAbsorbedTailMessages.add(msg.id)
        const nextPrefixLatestUsage = findLatestUsageInMessages([msg]) ?? cache.prefixLatestUsage
        const nextPrefixTimeline: TimelineCheckpoint = {
            ...cache.prefixTimeline,
            blocks: cache.prefixTimeline.blocks.map((block) => updatedToolsByBlockId.get(block.id) ?? block),
        }

        return {
            cache: {
                ...cache,
                prefixBlocks: nextPrefixBlocks,
                prefixTimeline: nextPrefixTimeline,
                prefixById: nextPrefixById,
                prefixVisibleBlocks: nextPrefixVisibleBlocks,
                prefixToolGroups: nextPrefixToolGroups,
                prefixLatestUsage: nextPrefixLatestUsage,
                prefixStatusSummary: buildSessionStatusPrefixSummary(nextPrefixBlocks, cache.prefixMessages),
                absorbedTailMessages: nextAbsorbedTailMessages,
                prefixRunningToolIds: nextPrefixRunningToolIds,
                prefixBlocksWithThreadIds: nextPrefixBlocksWithThreadIds,
                prefixVisibleById: nextPrefixVisibleById,
                prefixTurnsById: nextPrefixTurnsById,
                prefixTurnLayoutsById: nextPrefixTurnLayoutsById,
                prefixTurnHeadersById: nextPrefixTurnHeadersById,
            },
            dirtyIds,
        }
    }

    reconcileMessages(
        sessionId: string | null,
        messages: readonly DecryptedMessage[],
        hasMoreMessages?: boolean,
        options?: { deferNotifications?: boolean }
    ): SessionEntityStoreSnapshot {
        const prev = this.lastInput
        const sameSession = prev?.sessionId === sessionId
        return this.reconcileInput(
            {
                sessionId,
                messages,
                agentState: sameSession ? prev?.agentState : undefined,
                metadata: sameSession ? prev?.metadata : undefined,
                backgroundTaskCount: sameSession ? prev?.backgroundTaskCount : undefined,
                hasMoreMessages: hasMoreMessages ?? (sameSession ? prev?.hasMoreMessages : false),
                codexExplorationCollapsed: sameSession ? prev?.codexExplorationCollapsed : undefined,
                activeTurnId: sameSession ? prev?.activeTurnId : undefined,
                sessionThinking: sameSession ? prev?.sessionThinking : undefined,
            },
            options
        )
    }

    reconcileInput(
        input: SessionEntityStoreInput,
        options?: { deferNotifications?: boolean }
    ): SessionEntityStoreSnapshot {
        const sessionChanged = this.snapshot.sessionId !== input.sessionId
        if (sessionChanged) {
            this.reductionCache = { prefix: null, timeline: null }
            this.threadIdWrapperCache = new WeakMap()
            this.turnPartCache = new WeakMap()
            this.prevTailById = new Map()
            this.prevTailToolGroups = []
            this.prevTailTurnsById = EMPTY_TURNS_BY_ID
            this.prevTailTurnLayoutsById = EMPTY_TURN_LAYOUTS
            this.prevTailTimelineIndex = EMPTY_TIMELINE_INDEX
            this.prevTailTurnHeadersById = EMPTY_TURN_HEADERS
            this.prevTailBlocks = EMPTY_BLOCKS
            this.prevTailVisibleBlocks = EMPTY_VISIBLE_BLOCKS
            this.prevTailVisibleById = EMPTY_VISIBLE_BY_ID
            this.prevTailOutlineItems = []
            this.dirtyEntityIds = null
            this.pendingDirtyEntityIds = new Set()
            this.prevFullToolGroups = []
            this.prevOutlineItems = []
            this.prevSessionStatus = null
            this.lastInput = null
            this.pendingNotificationBaseline = null
        }

        const prevInput = this.lastInput
        if (
            prevInput
            && prevInput.sessionId === input.sessionId
            && prevInput.messages === input.messages
            && prevInput.goalSourceMessages === input.goalSourceMessages
            && prevInput.agentState === input.agentState
            && prevInput.metadata === input.metadata
            && prevInput.backgroundTaskCount === input.backgroundTaskCount
            && prevInput.hasMoreMessages === input.hasMoreMessages
            && prevInput.codexExplorationCollapsed === input.codexExplorationCollapsed
        ) {
            const nextThinking = Boolean(input.sessionThinking)
            this.lastInput = {
                ...input,
                windowOperation: input.windowOperation ?? prevInput.windowOperation,
            }
            if (Boolean(prevInput.sessionThinking) === nextThinking) {
                return this.snapshot
            }
            return this.reconcileSessionThinkingOnly(nextThinking, options)
        }
        const operation = input.windowOperation
        const previousOperation = prevInput?.windowOperation
        this.lastInput = {
            ...input,
            windowOperation: operation ?? previousOperation,
        }

        const prevSnapshot = this.snapshot
        const hasMoreMessages = input.hasMoreMessages ?? false
        const codexExplorationCollapsed = input.codexExplorationCollapsed ?? false
        const flavor = input.metadata?.flavor
        const sessionThinking = Boolean(input.sessionThinking)

        let visibleMessages: DecryptedMessage[] = []
        let queuedMessages: DecryptedMessage[] = []
        let isSending = false
        const sendingOrQueuedMessageIds = new Set<string>()
        let normalized: NormalizedMessage[] = []
        let tailNormalized: NormalizedMessage[] = []
        let tailMessagesForReducer: NormalizedMessage[] = []
        let tailVisibleMessages: DecryptedMessage[] = []
        let canUseIncrementalTail = false
        let prefixPatched = false
        const incrementalDirtyIds = new Set<string>()
        const continuousOperation = !sessionChanged && Boolean(
            operation
            && operation.nextRevision > operation.baseRevision
            && (
                !previousOperation
                || (
                    operation.generation >= previousOperation.generation
                    && operation.baseRevision === previousOperation.nextRevision
                )
            )
        )
        const forceFullReplay = Boolean(
            operation
            && prevInput?.messages !== input.messages
            && (
                !continuousOperation
                || (
                    operation.kind === 'replace-window'
                    && (operation.reason === 'session-switch' || operation.reason === 'epoch-reset')
                )
            )
        )
        const fastPathSnapshot = !sessionChanged && !forceFullReplay && prevInput
            ? this.tryReconcileLiveStreamDelta(input, prevInput, operation, continuousOperation, options)
            : null
        if (fastPathSnapshot) {
            return fastPathSnapshot
        }
        let replayReason = forceFullReplay ? 'window-revision-or-generation-reset' : 'dependency-fallback'
        let replayedRows = 0

        if (!forceFullReplay
            && canSliceRawTailFromPrefixCache(input, this.reductionCache.prefix)) {
            let workingPrefixCache = this.reductionCache.prefix
            const rawTail = input.messages.slice(workingPrefixCache.rawPrefix.length)
            for (const msg of rawTail) {
                if (msg.status === 'sending') {
                    isSending = true
                    sendingOrQueuedMessageIds.add(msg.id)
                }
                if (isDisplayedInQueueBar(msg)) {
                    queuedMessages.push(msg)
                    sendingOrQueuedMessageIds.add(msg.id)
                } else {
                    tailVisibleMessages.push(msg)
                }
            }
            tailNormalized = this.normalizeMessageList(
                tailVisibleMessages,
                workingPrefixCache.prefixSeenMessageIds
            )
            const tailHasBashOrWaitToolCall = tailNormalized.some((m) =>
                m.role === 'agent'
                && m.content.some((c) => c.type === 'tool-call' && (c.name === 'bash' || c.name === 'wait'))
            )
            canUseIncrementalTail = true
            for (const msg of tailNormalized) {
                if (workingPrefixCache.absorbedTailMessages.has(msg.id)) {
                    continue
                }
                if (!tailHasBashOrWaitToolCall && isPurePrefixToolResultMessage(msg, workingPrefixCache)) {
                    const patched = this.applyPrefixToolResultMessage(msg, workingPrefixCache, sessionThinking, input.metadata)
                    if (!patched) {
                        canUseIncrementalTail = false
                        break
                    }
                    workingPrefixCache = patched.cache
                    prefixPatched = true
                    for (const id of patched.dirtyIds) {
                        incrementalDirtyIds.add(id)
                    }
                    continue
                }
                if (tailMessageReferencesPrefix(msg, workingPrefixCache)) {
                    canUseIncrementalTail = false
                    break
                }
                tailMessagesForReducer.push(msg)
            }
            if (canUseIncrementalTail) {
                this.reductionCache.prefix = workingPrefixCache
                visibleMessages = workingPrefixCache.prefixVisibleMessages.length === 0
                    ? tailVisibleMessages
                    : tailVisibleMessages.length === 0
                        ? [...workingPrefixCache.prefixVisibleMessages]
                        : [...workingPrefixCache.prefixVisibleMessages, ...tailVisibleMessages]
                normalized = workingPrefixCache.prefixMessages.length === 0
                    ? tailNormalized
                    : tailNormalized.length === 0
                        ? [...workingPrefixCache.prefixMessages]
                        : [...workingPrefixCache.prefixMessages, ...tailNormalized]
            }
        }

        let reconciledBlocks: readonly ChatBlock[]
        let reconciledById: ChatBlocksById
        let visibleBlocks: readonly VisibleChatBlock[]
        let latestUsage: LatestUsage | null
        let latestGoal: ThreadGoal | null
        let hasReadyEvent: boolean
        let reductionMode: 'incremental-tail' | 'incremental-prepend' | 'full'
        let splitIndex: number
        let tailReconciledBlocks: readonly ChatBlock[] | null = null
        let tailVisibleBlocks: readonly VisibleChatBlock[] | null = null
        let fullVisibleGroups: readonly ToolGroupBlock[] = []

        if (canUseIncrementalTail && this.reductionCache.prefix) {
            const prefixCache = this.reductionCache.prefix
            reductionMode = 'incremental-tail'
            splitIndex = prefixCache.splitIndex
            replayReason = 'settled-prefix-dependency-closure'
            replayedRows = tailMessagesForReducer.length

            let tailGoalNormalized: NormalizedMessage[]
            if (!input.goalSourceMessages) {
                const tailGoalSource = buildGoalStateMessages(tailVisibleMessages)
                tailGoalNormalized = (
                    tailGoalSource.length === tailVisibleMessages.length
                    && isSameArrayElements(tailGoalSource, tailVisibleMessages)
                )
                    ? tailNormalized
                    : this.normalizeMessageList(tailGoalSource, prefixCache.prefixSeenMessageIds)
            } else {
                const tailGoalSource = input.goalSourceMessages.slice(prefixCache.rawPrefix.length)
                tailGoalNormalized = this.normalizeMessageList(tailGoalSource, prefixCache.prefixSeenMessageIds)
            }

            const tailReduced = reduceChatBlocks(tailMessagesForReducer, input.agentState, {
                goalStateMessages: tailGoalNormalized,
                prefixGoalSummary: prefixCache.prefixGoalSummary,
                prefixToolIds: prefixCache.prefixToolIds,
                oldestWindowMessageTime: prefixCache.prefixMessages[0]?.createdAt ?? null,
            })
            for (const id of this.prevTailById.keys()) {
                incrementalDirtyIds.add(id)
            }
            const tailReconciled = reconcileChatBlocks(tailReduced.blocks, this.prevTailById)
            for (const id of tailReconciled.byId.keys()) {
                incrementalDirtyIds.add(id)
            }
            this.prevTailById = tailReconciled.byId
            tailReconciledBlocks = tailReconciled.blocks

            for (const block of this.prevTailVisibleBlocks) {
                incrementalDirtyIds.add(block.id)
            }
            const tailVisible = buildVisibleChatBlocks(tailReconciled.blocks, {
                hasMoreMessages: false,
                previousGroups: this.prevTailToolGroups,
                codexExplorationCollapsed,
            })
            for (const block of tailVisible) {
                incrementalDirtyIds.add(block.id)
            }
            this.prevTailToolGroups = tailVisible.filter(isToolGroupBlock)
            tailVisibleBlocks = tailVisible

            const sameSplit = !sessionChanged && prevSnapshot.splitIndex === splitIndex
            const tailBlocksUnchanged = sameSplit && !prefixPatched && isSameArrayElements(tailReconciled.blocks, this.prevTailBlocks)
            this.prevTailBlocks = tailReconciled.blocks
            reconciledBlocks = tailBlocksUnchanged
                ? prevSnapshot.blocks
                : prefixCache.prefixBlocks.length === 0
                    ? tailReconciled.blocks
                    : tailReconciled.blocks.length === 0
                        ? prefixCache.prefixBlocks
                        : [...prefixCache.prefixBlocks, ...tailReconciled.blocks]

            reconciledById = tailBlocksUnchanged
                ? prevSnapshot.byId
                : new DisjointOverlayMap(prefixCache.prefixById, tailReconciled.byId)

            const tailVisibleUnchanged = sameSplit && !prefixPatched && isSameArrayElements(tailVisible, this.prevTailVisibleBlocks)
            this.prevTailVisibleBlocks = tailVisible
            visibleBlocks = tailVisibleUnchanged
                ? prevSnapshot.visibleBlocks
                : prefixCache.prefixVisibleBlocks.length === 0
                    ? tailVisible
                    : tailVisible.length === 0
                        ? prefixCache.prefixVisibleBlocks
                        : [...prefixCache.prefixVisibleBlocks, ...tailVisible]

            this.prevFullToolGroups = prefixCache.prefixToolGroups.length === 0
                ? this.prevTailToolGroups
                : this.prevTailToolGroups.length === 0
                    ? [...prefixCache.prefixToolGroups]
                    : [...prefixCache.prefixToolGroups, ...this.prevTailToolGroups]
            latestUsage = findLatestUsageInMessages(tailNormalized) ?? prefixCache.prefixLatestUsage
            latestGoal = tailReduced.latestGoal
            hasReadyEvent = prefixCache.prefixHasReadyEvent || tailReduced.hasReadyEvent
            this.reductionCache.timeline = {
                blocks: prefixCache.prefixTimeline.blocks.length === 0
                    ? tailReduced.timeline.blocks
                    : tailReduced.timeline.blocks.length === 0
                        ? prefixCache.prefixTimeline.blocks
                        : [...prefixCache.prefixTimeline.blocks, ...tailReduced.timeline.blocks],
                hasReadyEvent,
            }
        } else {
            reductionMode = 'full'
            visibleMessages = []
            queuedMessages = []
            isSending = false
            for (const msg of input.messages) {
                if (msg.status === 'sending') {
                    isSending = true
                    sendingOrQueuedMessageIds.add(msg.id)
                }
                if (isDisplayedInQueueBar(msg)) {
                    queuedMessages.push(msg)
                    sendingOrQueuedMessageIds.add(msg.id)
                } else {
                    visibleMessages.push(msg)
                }
            }
            normalized = this.normalizeMessageList(visibleMessages)
            const goalSource = input.goalSourceMessages ?? buildGoalStateMessages(input.messages)
            const goalNormalized = (
                goalSource.length === visibleMessages.length
                && isSameArrayElements(goalSource, visibleMessages)
            )
                ? normalized
                : this.normalizeMessageList(goalSource)
            const retainedTimelineSuffix = !forceFullReplay && continuousOperation
                && operation?.kind === 'prepend-history'
                && this.reductionCache.timeline !== null
                && prevInput?.agentState === input.agentState
                && !Object.keys(input.agentState?.requests ?? {}).length
                ? findRetainedTimelineSuffix(normalized, prevSnapshot.normalizedMessages, this.reductionCache.timeline)
                : null
            replayedRows = retainedTimelineSuffix?.replayedMessages ?? normalized.length
            if (retainedTimelineSuffix) {
                reductionMode = 'incremental-prepend'
                replayReason = 'prepend-dependency-closed-prefix'
            }

            const fullReduced = reduceChatBlocks(normalized, input.agentState, {
                goalStateMessages: goalNormalized,
                retainedTimelineSuffix,
            })
            this.reductionCache.timeline = fullReduced.timeline
            const fullReconciled = reconcileChatBlocks(fullReduced.blocks, prevSnapshot.byId)
            reconciledBlocks = fullReconciled.blocks
            reconciledById = fullReconciled.byId

            const fullVisible = buildVisibleChatBlocks(reconciledBlocks, {
                hasMoreMessages,
                previousGroups: this.prevFullToolGroups,
                codexExplorationCollapsed,
            })
            const allGroups = fullVisible.filter(isToolGroupBlock)
            this.prevFullToolGroups = allGroups
            fullVisibleGroups = allGroups
            visibleBlocks = fullVisible

            latestUsage = fullReduced.latestUsage
            latestGoal = fullReduced.latestGoal
            hasReadyEvent = fullReduced.hasReadyEvent

            splitIndex = findLatestUserTurnSplitIndex(normalized, sendingOrQueuedMessageIds)
        }

        const stableVisibleMessages = isSameArrayElements(visibleMessages, prevSnapshot.visibleMessages)
            ? prevSnapshot.visibleMessages
            : visibleMessages
        const stableNormalizedMessages = isSameArrayElements(normalized, prevSnapshot.normalizedMessages)
            ? prevSnapshot.normalizedMessages
            : normalized
        const stableBlocks = isSameArrayElements(reconciledBlocks, prevSnapshot.blocks)
            ? prevSnapshot.blocks
            : reconciledBlocks
        const stableVisibleBlocks = isSameArrayElements(visibleBlocks, prevSnapshot.visibleBlocks)
            ? prevSnapshot.visibleBlocks
            : visibleBlocks

        const hasLiveStreamingMessage = reductionMode === 'incremental-tail' && this.reductionCache.prefix
            ? hasUnsettledPrefixMessages(tailNormalized)
            : hasUnsettledPrefixMessages(stableNormalizedMessages)
        const canReuseBlocksWithThreadIds = !sessionChanged
            && !prefixPatched
            && stableVisibleBlocks === prevSnapshot.visibleBlocks
            && flavor === prevInput?.metadata?.flavor
            && (input.metadata ?? null) === (prevInput?.metadata ?? null)

        let visibleById: ReadonlyMap<string, VisibleChatBlock>
        let blocksWithThreadIds: readonly BlockWithThreadMessageId[]
        let turnsById: ReadonlyMap<string, TurnEntitySnapshot>
        let turnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>
        let turnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>
        let timelineIndex: readonly TimelineEntryRef[]
        let outlineItems: readonly ConversationOutlineItem[]
        let nonAssistantEntryChanged = false

        if (reductionMode === 'incremental-tail' && this.reductionCache.prefix && tailVisibleBlocks && tailReconciledBlocks) {
            const prefixCache = this.reductionCache.prefix
            const sameSplit = !sessionChanged && prevSnapshot.splitIndex === splitIndex
            for (const entry of this.prevTailTimelineIndex) {
                if (entry.role !== 'assistant') {
                    incrementalDirtyIds.add(entry.id)
                }
            }
            const tailEntries = assignThreadMessageIdsWithStableWrappers(
                hoistMidTurnTitleEvents(filterVisibleBlocksForFlavor(tailVisibleBlocks, flavor)),
                this.threadIdWrapperCache,
                {
                    initialSeen: prefixCache.prefixRawIdSeen,
                    initialUsedGroupIds: prefixCache.prefixUsedGroupIds,
                    preserveGroupByRawId: prefixCache.prefixGroupByRawId,
                }
            )
            blocksWithThreadIds = canReuseBlocksWithThreadIds
                ? prevSnapshot.blocksWithThreadIds
                : prefixCache.prefixBlocksWithThreadIds.length === 0
                    ? tailEntries
                    : tailEntries.length === 0
                        ? prefixCache.prefixBlocksWithThreadIds
                        : [...prefixCache.prefixBlocksWithThreadIds, ...tailEntries]

            const tailVisibleById = new Map<string, VisibleChatBlock>()
            for (const block of tailVisibleBlocks) {
                tailVisibleById.set(block.id, block)
            }
            for (const entry of tailEntries) {
                if (visibleBlockRole(entry.block) !== 'assistant') {
                    tailVisibleById.set(entry.threadMessageId, entry.block)
                    incrementalDirtyIds.add(entry.threadMessageId)
                }
            }
            this.prevTailVisibleById = tailVisibleById
            visibleById = canReuseBlocksWithThreadIds
                ? prevSnapshot.visibleById
                : new DisjointOverlayMap(prefixCache.prefixVisibleById, tailVisibleById)

            const tailTimeline = buildThreadTopology(tailEntries, sameSplit ? this.prevTailTimelineIndex : EMPTY_TIMELINE_INDEX)
            const tailTimelineUnchanged = sameSplit && tailTimeline === this.prevTailTimelineIndex
            this.prevTailTimelineIndex = tailTimeline
            if (tailTimelineUnchanged && !prefixPatched) {
                timelineIndex = prevSnapshot.timelineIndex
            } else {
                const candidateTimeline = prefixCache.prefixTimelineIndex.length === 0
                    ? tailTimeline
                    : tailTimeline.length === 0
                        ? prefixCache.prefixTimelineIndex
                        : Object.freeze([...prefixCache.prefixTimelineIndex, ...tailTimeline])
                timelineIndex = !sessionChanged && isSameArrayElements(candidateTimeline, prevSnapshot.timelineIndex)
                    ? prevSnapshot.timelineIndex
                    : candidateTimeline
            }

            for (const id of this.prevTailTurnsById.keys()) {
                incrementalDirtyIds.add(id)
                incrementalDirtyIds.add(`layout:${id}`)
                incrementalDirtyIds.add(`header:${id}`)
            }

            if (canReuseBlocksWithThreadIds) {
                turnsById = prevSnapshot.turnsById
                turnLayoutsById = prevSnapshot.turnLayoutsById
            } else {
                const tailTurnsById = buildTurnEntitiesById(tailEntries, sameSplit ? this.prevTailTurnsById : EMPTY_TURNS_BY_ID, this.turnPartCache)
                for (const id of tailTurnsById.keys()) {
                    incrementalDirtyIds.add(id)
                    incrementalDirtyIds.add(`layout:${id}`)
                    incrementalDirtyIds.add(`header:${id}`)
                }
                const tailTurnsUnchanged = sameSplit && !prefixPatched && tailTurnsById === this.prevTailTurnsById && (input.metadata ?? null) === (prevInput?.metadata ?? null)
                this.prevTailTurnsById = tailTurnsById
                if (tailTurnsUnchanged) {
                    turnsById = prevSnapshot.turnsById
                    turnLayoutsById = prevSnapshot.turnLayoutsById
                } else {
                    turnsById = new DisjointOverlayMap(prefixCache.prefixTurnsById, tailTurnsById)
                    const tailLayoutsById = buildTurnLayoutsById(tailTurnsById, sameSplit ? this.prevTailTurnLayoutsById : EMPTY_TURN_LAYOUTS, input.metadata ?? null)
                    const tailLayoutsUnchanged = sameSplit && !prefixPatched && tailLayoutsById === this.prevTailTurnLayoutsById
                    this.prevTailTurnLayoutsById = tailLayoutsById
                    turnLayoutsById = tailLayoutsUnchanged
                        ? prevSnapshot.turnLayoutsById
                        : new DisjointOverlayMap(prefixCache.prefixTurnLayoutsById, tailLayoutsById)
                }
            }

            const tailTurnHeadersById = buildTurnHeadersById(
                this.prevTailTurnsById,
                timelineIndex,
                sessionThinking,
                sameSplit ? this.prevTailTurnHeadersById : EMPTY_TURN_HEADERS
            )
            const tailHeadersUnchanged = sameSplit && !prefixPatched && tailTurnHeadersById === this.prevTailTurnHeadersById
            this.prevTailTurnHeadersById = tailTurnHeadersById
            turnHeadersById = tailHeadersUnchanged
                ? prevSnapshot.turnHeadersById
                : new DisjointOverlayMap(prefixCache.prefixTurnHeadersById, tailTurnHeadersById)

            if (!sessionChanged && timelineIndex === prevSnapshot.timelineIndex) {
                for (const entry of tailTimeline) {
                    if (entry.role !== 'assistant' && prevSnapshot.visibleById.get(entry.id) !== visibleById.get(entry.id)) {
                        nonAssistantEntryChanged = true
                        break
                    }
                }
            }

            const tailHasUserBlock = tailReconciledBlocks.some((block) => block.kind === 'user-text')
            if (!tailHasUserBlock) {
                outlineItems = isSameArrayElements(prefixCache.prefixOutlineItems, prevSnapshot.outlineItems)
                    ? prevSnapshot.outlineItems
                    : prefixCache.prefixOutlineItems
            } else {
                const tailOutline = buildConversationOutline(tailReconciledBlocks, this.prevTailOutlineItems)
                this.prevTailOutlineItems = [...tailOutline]
                const candidateOutline = prefixCache.prefixOutlineItems.length === 0
                    ? tailOutline
                    : [...prefixCache.prefixOutlineItems, ...tailOutline]
                outlineItems = isSameArrayElements(candidateOutline, prevSnapshot.outlineItems)
                    ? prevSnapshot.outlineItems
                    : candidateOutline
            }
            this.dirtyEntityIds = incrementalDirtyIds
            if (this.pendingDirtyEntityIds !== null) {
                for (const id of incrementalDirtyIds) {
                    this.pendingDirtyEntityIds.add(id)
                }
            }

            const latestCommittedSplitIndex = findLatestUserTurnSplitIndex(normalized, sendingOrQueuedMessageIds)
            if (latestCommittedSplitIndex > splitIndex && this.reductionCache.timeline) {
                const advancedCache = this.tryBuildSettledPrefixCache(
                    input.messages,
                    normalized,
                    latestCommittedSplitIndex,
                    reconciledBlocks,
                    visibleBlocks,
                    this.reductionCache.timeline,
                    input.agentState,
                    hasMoreMessages,
                    codexExplorationCollapsed,
                    flavor,
                    input.metadata,
                    this.prevFullToolGroups,
                    blocksWithThreadIds,
                    turnsById,
                    turnLayoutsById,
                    turnHeadersById,
                    timelineIndex,
                    outlineItems
                )
                if (advancedCache) {
                    this.reductionCache.prefix = advancedCache
                    splitIndex = latestCommittedSplitIndex
                    this.syncPrevTailStateFromPrefix(
                        advancedCache,
                        reconciledById,
                        reconciledBlocks,
                        visibleBlocks,
                        blocksWithThreadIds,
                        this.prevFullToolGroups,
                        turnsById,
                        turnLayoutsById,
                        turnHeadersById,
                        timelineIndex,
                        outlineItems
                    )
                }
            }
        } else {
            const fullVisibleById = new Map<string, VisibleChatBlock>()
            for (const block of stableVisibleBlocks) {
                fullVisibleById.set(block.id, block)
            }
            blocksWithThreadIds = canReuseBlocksWithThreadIds
                ? prevSnapshot.blocksWithThreadIds
                : assignThreadMessageIdsWithStableWrappers(
                    hoistMidTurnTitleEvents(filterVisibleBlocksForFlavor(stableVisibleBlocks, flavor)),
                    this.threadIdWrapperCache
                )
            for (const entry of blocksWithThreadIds) {
                if (visibleBlockRole(entry.block) !== 'assistant') {
                    fullVisibleById.set(entry.threadMessageId, entry.block)
                }
            }
            visibleById = fullVisibleById
            turnsById = canReuseBlocksWithThreadIds
                ? prevSnapshot.turnsById
                : buildTurnEntitiesById(blocksWithThreadIds, sessionChanged ? EMPTY_TURNS_BY_ID : prevSnapshot.turnsById, this.turnPartCache)
            turnLayoutsById = (turnsById === prevSnapshot.turnsById && (input.metadata ?? null) === (prevInput?.metadata ?? null))
                ? prevSnapshot.turnLayoutsById
                : buildTurnLayoutsById(turnsById, sessionChanged ? EMPTY_TURN_LAYOUTS : prevSnapshot.turnLayoutsById, input.metadata ?? null)
            outlineItems = (!sessionChanged && stableBlocks === prevSnapshot.blocks)
                ? prevSnapshot.outlineItems
                : buildConversationOutline([...stableBlocks], this.prevOutlineItems)
            this.prevOutlineItems = [...outlineItems]
            timelineIndex = buildThreadTopology(blocksWithThreadIds, sessionChanged ? EMPTY_TIMELINE_INDEX : prevSnapshot.timelineIndex)
            turnHeadersById = buildTurnHeadersById(
                turnsById,
                timelineIndex,
                sessionThinking,
                sessionChanged ? EMPTY_TURN_HEADERS : prevSnapshot.turnHeadersById
            )
            if (!sessionChanged && timelineIndex === prevSnapshot.timelineIndex) {
                for (const entry of timelineIndex) {
                    if (entry.role !== 'assistant' && prevSnapshot.visibleById.get(entry.id) !== visibleById.get(entry.id)) {
                        nonAssistantEntryChanged = true
                        break
                    }
                }
            }

            this.reductionCache.prefix = this.reductionCache.timeline
                ? this.tryBuildSettledPrefixCache(
                    input.messages,
                    normalized,
                    splitIndex,
                    reconciledBlocks,
                    stableVisibleBlocks,
                    this.reductionCache.timeline,
                    input.agentState,
                    hasMoreMessages,
                    codexExplorationCollapsed,
                    flavor,
                    input.metadata,
                    fullVisibleGroups,
                    blocksWithThreadIds,
                    turnsById,
                    turnLayoutsById,
                    turnHeadersById,
                    timelineIndex,
                    outlineItems
                )
                : null
            if (this.reductionCache.prefix) {
                this.syncPrevTailStateFromPrefix(
                    this.reductionCache.prefix,
                    reconciledById,
                    reconciledBlocks,
                    stableVisibleBlocks,
                    blocksWithThreadIds,
                    fullVisibleGroups,
                    turnsById,
                    turnLayoutsById,
                    turnHeadersById,
                    timelineIndex,
                    outlineItems
                )
            } else {
                this.prevTailById = new Map()
                this.prevTailBlocks = EMPTY_BLOCKS
                this.prevTailVisibleBlocks = EMPTY_VISIBLE_BLOCKS
                this.prevTailVisibleById = EMPTY_VISIBLE_BY_ID
                this.prevTailToolGroups = []
                this.prevTailTurnsById = EMPTY_TURNS_BY_ID
                this.prevTailTurnLayoutsById = EMPTY_TURN_LAYOUTS
                this.prevTailTurnHeadersById = EMPTY_TURN_HEADERS
                this.prevTailTimelineIndex = EMPTY_TIMELINE_INDEX
                this.prevTailOutlineItems = []
            }
            this.dirtyEntityIds = null
            this.pendingDirtyEntityIds = null
        }

        const timelineStructureKey = timelineIndex === prevSnapshot.timelineIndex && !sessionChanged
            ? prevSnapshot.timelineStructureKey
            : timelineIndex.map((entry) => `${entry.role}:${entry.kind}:${entry.id}`).join('|')
        const timelineVersion = (sessionChanged ? 0 : prevSnapshot.timelineVersion)
            + (timelineIndex === (sessionChanged ? EMPTY_TIMELINE_INDEX : prevSnapshot.timelineIndex) ? 0 : 1)
        const stableQueuedMessages = isSameArrayElements(queuedMessages, prevSnapshot.meta.queuedMessages)
            ? prevSnapshot.meta.queuedMessages
            : Object.freeze(queuedMessages)
        const runtimeTopologyChanged = sessionChanged
            || timelineIndex !== prevSnapshot.timelineIndex
            || turnHeadersById !== prevSnapshot.turnHeadersById
            || nonAssistantEntryChanged
        const runtimeTopologyVersion = (sessionChanged ? 0 : prevSnapshot.runtimeTopologyVersion)
            + (runtimeTopologyChanged ? 1 : 0)
        const stableLatestUsage = isSameLatestUsage(latestUsage, prevSnapshot.meta.latestUsage)
            ? prevSnapshot.meta.latestUsage
            : latestUsage
        const stableLatestGoal = isSameThreadGoal(latestGoal, prevSnapshot.meta.latestGoal)
            ? prevSnapshot.meta.latestGoal
            : latestGoal
        const contextSize = stableLatestUsage?.contextSize
        let hasRunningChildAgent: boolean
        let activityLabel: string | null
        if (reductionMode === 'incremental-tail' && this.reductionCache.prefix && tailReconciledBlocks) {
            const prefixRunning = this.reductionCache.prefix.prefixRunningToolIds.size > 0
                ? resolvePrefixRunningToolState(
                    this.reductionCache.prefix.prefixRunningToolIds,
                    this.reductionCache.prefix.prefixById
                )
                : { hasRunningChildAgent: false, activityLabel: null }
            hasRunningChildAgent = hasAbortableAgentRun(tailReconciledBlocks) || prefixRunning.hasRunningChildAgent
            activityLabel = findActiveToolActivityLabel(tailReconciledBlocks) ?? prefixRunning.activityLabel
        } else {
            hasRunningChildAgent = hasAbortableAgentRun(stableBlocks)
            activityLabel = findActiveToolActivityLabel(stableBlocks)
        }
        const rawSessionStatus = reductionMode === 'incremental-tail' && this.reductionCache.prefix && tailReconciledBlocks
            ? buildSessionStatusData({
                goal: stableLatestGoal,
                blocks: tailReconciledBlocks,
                messages: tailNormalized,
                prefixSummary: this.reductionCache.prefix.prefixStatusSummary,
                backgroundTaskCount: input.backgroundTaskCount,
                includeSubagents: false,
            })
            : buildSessionStatusData({
                goal: stableLatestGoal,
                blocks: stableBlocks,
                messages: stableNormalizedMessages,
                backgroundTaskCount: input.backgroundTaskCount,
                includeSubagents: false,
            })
        const sessionStatus = (
            this.prevSessionStatus && areSessionStatusDataEqual(this.prevSessionStatus, rawSessionStatus)
        )
            ? this.prevSessionStatus
            : rawSessionStatus
        this.prevSessionStatus = sessionStatus
        const latestRefusalEvent = reductionMode === 'incremental-tail' && this.reductionCache.prefix
            ? (findLatestRefusalEvent(tailNormalized) ?? this.reductionCache.prefix.prefixLatestRefusalEvent)
            : findLatestRefusalEvent(stableNormalizedMessages)

        const candidateMeta: SessionEntityMetaSnapshot = {
            latestUsage: stableLatestUsage,
            contextSize,
            latestGoal: stableLatestGoal,
            hasReadyEvent,
            hasRunningChildAgent,
            activityLabel,
            isSending,
            queuedMessages: stableQueuedMessages,
            outlineItems,
            sessionStatus,
            latestRefusalEvent,
        }
        const meta = isSameMeta(candidateMeta, prevSnapshot.meta)
            ? prevSnapshot.meta
            : Object.freeze(candidateMeta)

        const nextSnapshot: SessionEntityStoreSnapshot = {
            sessionId: input.sessionId,
            visibleMessages: stableVisibleMessages,
            normalizedMessages: stableNormalizedMessages,
            timelineIndex,
            timelineStructureKey,
            timelineVersion,
            runtimeTopologyVersion,
            blocks: stableBlocks,
            byId: reconciledById,
            visibleBlocks: stableVisibleBlocks,
            visibleById,
            blocksWithThreadIds,
            turnsById,
            turnLayoutsById,
            turnHeadersById,
            outlineItems: meta.outlineItems,
            sessionStatus: meta.sessionStatus,
            meta,
            latestUsage: meta.latestUsage,
            latestGoal: meta.latestGoal,
            hasReadyEvent: meta.hasReadyEvent,
            hasRunningChildAgent: meta.hasRunningChildAgent,
            activityLabel: meta.activityLabel,
            hasLiveStreamingMessage,
            reductionMode,
            replay: { rows: replayedRows, reason: replayReason },
            splitIndex,
        }
        this.snapshot = nextSnapshot
        if (options?.deferNotifications) {
            if (!this.pendingNotificationBaseline) {
                this.pendingNotificationBaseline = prevSnapshot
            }
        } else {
            const baseline = this.pendingNotificationBaseline ?? prevSnapshot
            if (this.pendingNotificationBaseline && this.dirtyEntityIds !== null) {
                if (this.pendingDirtyEntityIds === null) {
                    this.dirtyEntityIds = null
                } else {
                    this.dirtyEntityIds = new Set(this.pendingDirtyEntityIds)
                }
            }
            this.pendingNotificationBaseline = null
            this.pendingDirtyEntityIds = new Set()
            this.notifyChangedListeners(baseline, nextSnapshot)
        }
        return nextSnapshot
    }

    private tryReconcileLiveStreamDelta(
        input: SessionEntityStoreInput,
        prevInput: SessionEntityStoreInput,
        operation: WindowOperation | null | undefined,
        continuousOperation: boolean,
        options?: { deferNotifications?: boolean }
    ): SessionEntityStoreSnapshot | null {
        if (
            prevInput.agentState !== input.agentState
            || prevInput.metadata !== input.metadata
            || Boolean(prevInput.sessionThinking) !== Boolean(input.sessionThinking)
            || prevInput.backgroundTaskCount !== input.backgroundTaskCount
            || prevInput.hasMoreMessages !== input.hasMoreMessages
            || prevInput.codexExplorationCollapsed !== input.codexExplorationCollapsed
            || prevInput.goalSourceMessages !== input.goalSourceMessages
            || input.goalSourceMessages !== undefined
        ) {
            return null
        }
        if (operation && (operation.kind !== 'upsert-live-stream' || !continuousOperation)) {
            return null
        }
        const prevMessages = prevInput.messages
        const nextMessages = input.messages
        if (prevMessages.length === 0 || prevMessages.length !== nextMessages.length) {
            return null
        }
        const lastIdx = nextMessages.length - 1
        for (let i = 0; i < lastIdx; i += 1) {
            if (prevMessages[i] !== nextMessages[i]) {
                return null
            }
        }
        const prevRaw = prevMessages[lastIdx]!
        const nextRaw = nextMessages[lastIdx]!
        if (
            prevRaw.status === 'sending'
            || nextRaw.status === 'sending'
            || isDisplayedInQueueBar(prevRaw)
            || isDisplayedInQueueBar(nextRaw)
        ) {
            return null
        }
        const prevSnapshot = this.snapshot
        if (
            prevSnapshot.visibleMessages.length === 0
            || prevSnapshot.visibleMessages[prevSnapshot.visibleMessages.length - 1] !== prevRaw
            || prevSnapshot.normalizedMessages.length === 0
            || prevSnapshot.blocks.length === 0
            || prevSnapshot.visibleBlocks.length === 0
            || prevSnapshot.blocksWithThreadIds.length === 0
        ) {
            return null
        }
        const prevNorm = prevSnapshot.normalizedMessages[prevSnapshot.normalizedMessages.length - 1]!
        let nextNorm = this.normalizedCache.get(nextRaw)
        if (nextNorm === undefined) {
            nextNorm = normalizeDecryptedMessage(nextRaw)
            this.normalizedCache.set(nextRaw, nextNorm)
        }
        if (!nextNorm || nextNorm.role !== 'agent' || prevNorm.role !== 'agent') {
            return null
        }
        if (
            nextNorm.isSidechain
            || prevNorm.isSidechain
            || nextNorm.parentToolUseId
            || prevNorm.parentToolUseId
            || nextNorm.localId !== prevNorm.localId
            || nextNorm.usage !== undefined
            || prevNorm.usage !== undefined
            || nextNorm.model !== prevNorm.model
        ) {
            return null
        }
        const prevStreamId = prevNorm.streamSnapshot?.id ?? null
        const nextStreamId = nextNorm.streamSnapshot?.id ?? null
        const prevLive = Boolean(prevNorm.streamSnapshot?.live ?? prevNorm.live)
        const nextLive = Boolean(nextNorm.streamSnapshot?.live ?? nextNorm.live)
        if (!prevLive || !nextLive) {
            return null
        }
        if (prevStreamId !== nextStreamId) {
            return null
        }
        if (prevStreamId === null && prevRaw.id !== nextRaw.id) {
            return null
        }
        if (prevNorm.content.length !== 1 || nextNorm.content.length !== 1) {
            return null
        }
        const prevContent = prevNorm.content[0]!
        const nextContent = nextNorm.content[0]!
        if (prevContent.type !== nextContent.type) {
            return null
        }
        const isText = nextContent.type === 'text' && prevContent.type === 'text'
        const isReasoning = nextContent.type === 'reasoning' && prevContent.type === 'reasoning'
        if (!isText && !isReasoning) {
            return null
        }
        const prevPhase = prevContent.phase
        const nextPhase = nextContent.phase
        if (prevPhase !== nextPhase) {
            return null
        }
        const nextText = nextContent.text
        if (isText && (nextText.includes('<notify_summary>') || prevContent.text.includes('<notify_summary>'))) {
            return null
        }

        const prevBlock = prevSnapshot.blocks[prevSnapshot.blocks.length - 1]!
        const expectedKind = isText ? 'agent-text' : 'agent-reasoning'
        const expectedBlockId = `${nextStreamId ?? nextRaw.id}:0`
        const prevExpectedBlockId = `${prevStreamId ?? prevRaw.id}:0`
        if (
            prevBlock.kind !== expectedKind
            || prevBlock.id !== expectedBlockId
            || prevBlock.id !== prevExpectedBlockId
            || prevBlock.createdAt !== prevNorm.createdAt
        ) {
            return null
        }
        if (Boolean(prevBlock.text.trim()) !== Boolean(nextText.trim())) {
            return null
        }
        if (prevSnapshot.visibleBlocks[prevSnapshot.visibleBlocks.length - 1] !== prevBlock) {
            return null
        }
        const lastEntryIdx = prevSnapshot.blocksWithThreadIds.length - 1
        const prevEntry = prevSnapshot.blocksWithThreadIds[lastEntryIdx]!
        if (prevEntry.block !== prevBlock) {
            return null
        }
        let firstTurnEntryIdx = lastEntryIdx
        while (
            firstTurnEntryIdx > 0
            && visibleBlockRole(prevSnapshot.blocksWithThreadIds[firstTurnEntryIdx - 1]!.block) === 'assistant'
        ) {
            firstTurnEntryIdx -= 1
        }
        const turnId = prevSnapshot.blocksWithThreadIds[firstTurnEntryIdx]!.threadMessageId
        const prevTurn = prevSnapshot.turnsById.get(turnId)
        if (
            !prevTurn
            || prevTurn.blocks.length === 0
            || prevTurn.blocks.length !== lastEntryIdx - firstTurnEntryIdx + 1
            || prevTurn.blocks[prevTurn.blocks.length - 1] !== prevBlock
            || prevTurn.blocks[0] !== prevSnapshot.blocksWithThreadIds[firstTurnEntryIdx]?.block
            || prevTurn.parts.length !== prevTurn.blocks.length
        ) {
            return null
        }
        if (
            this.reductionCache.timeline !== null
            && (
                this.reductionCache.timeline.blocks.length === 0
                || this.reductionCache.timeline.blocks[this.reductionCache.timeline.blocks.length - 1]?.id !== prevBlock.id
            )
        ) {
            return null
        }
        const prefixCache = this.reductionCache.prefix
        if (prefixCache) {
            if (
                prefixCache.prefixSeenMessageIds.has(nextRaw.id)
                || (nextStreamId !== null && prefixCache.prefixStreamIds.has(nextStreamId))
                || this.prevTailBlocks.length === 0
                || this.prevTailBlocks[this.prevTailBlocks.length - 1] !== prevBlock
                || this.prevTailVisibleBlocks.length === 0
                || this.prevTailVisibleBlocks[this.prevTailVisibleBlocks.length - 1] !== prevBlock
                || this.prevTailTurnsById.get(turnId) !== prevTurn
            ) {
                return null
            }
        }

        const singleReduced = reduceChatBlocks([nextNorm], input.agentState)
        if (singleReduced.blocks.length !== 1 || singleReduced.timeline.blocks.length !== 1) {
            return null
        }
        const reducedBlock = singleReduced.blocks[0]!
        if (
            reducedBlock.id !== prevBlock.id
            || reducedBlock.kind !== prevBlock.kind
            || (reducedBlock.kind !== 'agent-text' && reducedBlock.kind !== 'agent-reasoning')
        ) {
            return null
        }
        const singleReconciled = reconcileChatBlocks(
            singleReduced.blocks,
            new Map<string, ChatBlock>([[prevBlock.id, prevBlock]])
        )
        const nextBlock = singleReconciled.blocks[0]!

        if (this.reductionCache.timeline) {
            const nextTimelineBlocks = this.reductionCache.timeline.blocks.slice()
            nextTimelineBlocks[nextTimelineBlocks.length - 1] = singleReduced.timeline.blocks[0]!
            this.reductionCache.timeline = {
                blocks: nextTimelineBlocks,
                hasReadyEvent: this.reductionCache.timeline.hasReadyEvent,
            }
        }

        const nextVisibleMessages = prevRaw === nextRaw
            ? prevSnapshot.visibleMessages
            : (() => {
                const copy = prevSnapshot.visibleMessages.slice()
                copy[copy.length - 1] = nextRaw
                return copy
            })()
        const nextNormalizedMessages = prevNorm === nextNorm
            ? prevSnapshot.normalizedMessages
            : (() => {
                const copy = prevSnapshot.normalizedMessages.slice()
                copy[copy.length - 1] = nextNorm
                return copy
            })()

        if (nextBlock === prevBlock) {
            const unchangedSnapshot: SessionEntityStoreSnapshot = {
                ...prevSnapshot,
                visibleMessages: nextVisibleMessages,
                normalizedMessages: nextNormalizedMessages,
                hasLiveStreamingMessage: true,
                reductionMode: 'incremental-tail',
                replay: { rows: 1, reason: 'live-stream-fast-path' },
            }
            this.snapshot = unchangedSnapshot
            return unchangedSnapshot
        }

        const nextBlocks = prevSnapshot.blocks.slice()
        nextBlocks[nextBlocks.length - 1] = nextBlock
        const nextVisibleBlocks = prevSnapshot.visibleBlocks.slice()
        nextVisibleBlocks[nextVisibleBlocks.length - 1] = nextBlock

        const nextTurnBlocks = prevTurn.blocks.slice()
        nextTurnBlocks[nextTurnBlocks.length - 1] = nextBlock
        const nextTurnTimestamp = nextBlock.createdAt === prevBlock.createdAt
            ? prevTurn.timestamp
            : nextTurnBlocks.reduce(
                (latest, block) => Math.max(latest, getBlockPresentationTimestamp(block)),
                0
            )
        const nextPart = visibleBlockToTurnContentPart(nextBlock, this.turnPartCache)
        const nextTurnParts = prevTurn.parts.slice()
        nextTurnParts[nextTurnParts.length - 1] = nextPart
        const nextTurn: TurnEntitySnapshot = {
            ...prevTurn,
            timestamp: nextTurnTimestamp,
            blocks: nextTurnBlocks,
            parts: nextTurnParts,
        }

        const nextBlocksWithThreadIds = prevSnapshot.blocksWithThreadIds.slice()
        const nextEntry: BlockWithThreadMessageId = {
            ...prevEntry,
            block: nextBlock,
            timestamp: firstTurnEntryIdx === lastEntryIdx ? nextTurnTimestamp : getBlockPresentationTimestamp(nextBlock),
        }
        this.threadIdWrapperCache.set(nextBlock, nextEntry)
        nextBlocksWithThreadIds[lastEntryIdx] = nextEntry
        if (firstTurnEntryIdx !== lastEntryIdx && nextTurnTimestamp !== prevTurn.timestamp) {
            const firstEntry = nextBlocksWithThreadIds[firstTurnEntryIdx]!
            const updatedFirstEntry: BlockWithThreadMessageId = {
                ...firstEntry,
                timestamp: nextTurnTimestamp,
            }
            this.threadIdWrapperCache.set(firstEntry.block, updatedFirstEntry)
            nextBlocksWithThreadIds[firstTurnEntryIdx] = updatedFirstEntry
        }

        const prevHeader = prevSnapshot.turnHeadersById.get(turnId)
        const headerChanged = Boolean(prevHeader && prevHeader.timestamp !== nextTurnTimestamp)
        const nextHeader = prevHeader && headerChanged
            ? { ...prevHeader, timestamp: nextTurnTimestamp }
            : prevHeader

        let nextById: ChatBlocksById
        let nextVisibleById: ReadonlyMap<string, VisibleChatBlock>
        let nextTurnsById: ReadonlyMap<string, TurnEntitySnapshot>
        let nextTurnHeadersById = prevSnapshot.turnHeadersById

        if (prefixCache) {
            const nextTailBlocks = this.prevTailBlocks.slice()
            nextTailBlocks[nextTailBlocks.length - 1] = nextBlock
            this.prevTailBlocks = nextTailBlocks

            const nextTailVisibleBlocks = this.prevTailVisibleBlocks.slice()
            nextTailVisibleBlocks[nextTailVisibleBlocks.length - 1] = nextBlock
            this.prevTailVisibleBlocks = nextTailVisibleBlocks

            const nextTailById = new Map(this.prevTailById)
            nextTailById.set(nextBlock.id, nextBlock)
            this.prevTailById = nextTailById
            nextById = new DisjointOverlayMap(prefixCache.prefixById, nextTailById)

            const nextTailVisibleById = new Map(this.prevTailVisibleById)
            nextTailVisibleById.set(nextBlock.id, nextBlock)
            this.prevTailVisibleById = nextTailVisibleById
            nextVisibleById = new DisjointOverlayMap(prefixCache.prefixVisibleById, nextTailVisibleById)

            const nextTailTurnsById = new Map(this.prevTailTurnsById)
            nextTailTurnsById.set(turnId, nextTurn)
            this.prevTailTurnsById = nextTailTurnsById
            nextTurnsById = new DisjointOverlayMap(prefixCache.prefixTurnsById, nextTailTurnsById)

            if (headerChanged && nextHeader) {
                const nextTailHeadersById = new Map(this.prevTailTurnHeadersById)
                nextTailHeadersById.set(turnId, nextHeader)
                this.prevTailTurnHeadersById = nextTailHeadersById
                nextTurnHeadersById = new DisjointOverlayMap(prefixCache.prefixTurnHeadersById, nextTailHeadersById)
            }
        } else {
            const byIdCopy = new Map(prevSnapshot.byId)
            byIdCopy.set(nextBlock.id, nextBlock)
            nextById = byIdCopy

            const visibleByIdCopy = new Map(prevSnapshot.visibleById)
            visibleByIdCopy.set(nextBlock.id, nextBlock)
            nextVisibleById = visibleByIdCopy

            const turnsByIdCopy = new Map(prevSnapshot.turnsById)
            turnsByIdCopy.set(turnId, nextTurn)
            nextTurnsById = turnsByIdCopy

            if (headerChanged && nextHeader) {
                const headersCopy = new Map(prevSnapshot.turnHeadersById)
                headersCopy.set(turnId, nextHeader)
                nextTurnHeadersById = headersCopy
            }
        }

        const fastDirtyIds = new Set<string>([nextBlock.id, turnId])
        if (headerChanged) {
            fastDirtyIds.add(`header:${turnId}`)
        }
        this.dirtyEntityIds = fastDirtyIds
        if (this.pendingDirtyEntityIds !== null) {
            for (const id of fastDirtyIds) {
                this.pendingDirtyEntityIds.add(id)
            }
        }

        const nextSnapshot: SessionEntityStoreSnapshot = {
            ...prevSnapshot,
            visibleMessages: nextVisibleMessages,
            normalizedMessages: nextNormalizedMessages,
            runtimeTopologyVersion: prevSnapshot.runtimeTopologyVersion + (headerChanged ? 1 : 0),
            blocks: nextBlocks,
            byId: nextById,
            visibleBlocks: nextVisibleBlocks,
            visibleById: nextVisibleById,
            blocksWithThreadIds: nextBlocksWithThreadIds,
            turnsById: nextTurnsById,
            turnHeadersById: nextTurnHeadersById,
            hasLiveStreamingMessage: true,
            reductionMode: 'incremental-tail',
            replay: { rows: 1, reason: 'live-stream-fast-path' },
        }
        this.snapshot = nextSnapshot
        if (options?.deferNotifications) {
            if (!this.pendingNotificationBaseline) {
                this.pendingNotificationBaseline = prevSnapshot
            }
        } else {
            const baseline = this.pendingNotificationBaseline ?? prevSnapshot
            if (this.pendingNotificationBaseline && this.dirtyEntityIds !== null) {
                if (this.pendingDirtyEntityIds === null) {
                    this.dirtyEntityIds = null
                } else {
                    this.dirtyEntityIds = new Set(this.pendingDirtyEntityIds)
                }
            }
            this.pendingNotificationBaseline = null
            this.pendingDirtyEntityIds = new Set()
            this.notifyChangedListeners(baseline, nextSnapshot)
        }
        return nextSnapshot
    }

    private reconcileSessionThinkingOnly(
        sessionThinking: boolean,
        options?: { deferNotifications?: boolean }
    ): SessionEntityStoreSnapshot {
        const prevSnapshot = this.snapshot
        const lastEntryId = prevSnapshot.timelineIndex[prevSnapshot.timelineIndex.length - 1]?.id ?? null
        if (!lastEntryId) {
            return prevSnapshot
        }
        const lastTurn = prevSnapshot.turnsById.get(lastEntryId)
        const prevHeader = prevSnapshot.turnHeadersById.get(lastEntryId)
        if (!lastTurn || !prevHeader) {
            return prevSnapshot
        }
        const hasLiveProse = lastTurn.blocks.some(
            (block) => (block.kind === 'agent-text' || block.kind === 'agent-reasoning') && 'live' in block && block.live === true
        )
        const nextIsRunning = sessionThinking || prevHeader.hasRunningTool || hasLiveProse
        if (nextIsRunning === prevHeader.isRunning) {
            return prevSnapshot
        }
        const nextHeader: TurnHeaderSnapshot = {
            ...prevHeader,
            isRunning: nextIsRunning,
        }
        let turnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>
        if (this.reductionCache.prefix && this.prevTailTurnHeadersById.has(lastEntryId)) {
            const nextTailHeaders = new Map(this.prevTailTurnHeadersById)
            nextTailHeaders.set(lastEntryId, nextHeader)
            this.prevTailTurnHeadersById = nextTailHeaders
            turnHeadersById = new DisjointOverlayMap(this.reductionCache.prefix.prefixTurnHeadersById, nextTailHeaders)
        } else {
            const nextHeaders = new Map(prevSnapshot.turnHeadersById)
            nextHeaders.set(lastEntryId, nextHeader)
            turnHeadersById = nextHeaders
        }
        const headerEntityId = `header:${lastEntryId}`
        this.dirtyEntityIds = new Set([headerEntityId])
        if (this.pendingDirtyEntityIds !== null) {
            this.pendingDirtyEntityIds.add(headerEntityId)
        }
        const nextSnapshot: SessionEntityStoreSnapshot = {
            ...prevSnapshot,
            turnHeadersById,
            runtimeTopologyVersion: prevSnapshot.runtimeTopologyVersion + 1,
            reductionMode: 'noop',
            replay: { rows: 0, reason: 'session-thinking-only' },
        }
        this.snapshot = nextSnapshot
        if (options?.deferNotifications) {
            if (!this.pendingNotificationBaseline) {
                this.pendingNotificationBaseline = prevSnapshot
            }
        } else {
            const baseline = this.pendingNotificationBaseline ?? prevSnapshot
            if (this.pendingNotificationBaseline && this.dirtyEntityIds !== null) {
                if (this.pendingDirtyEntityIds === null) {
                    this.dirtyEntityIds = null
                } else {
                    this.dirtyEntityIds = new Set(this.pendingDirtyEntityIds)
                }
            }
            this.pendingNotificationBaseline = null
            this.pendingDirtyEntityIds = new Set()
            this.notifyChangedListeners(baseline, nextSnapshot)
        }
        return nextSnapshot
    }

    flushNotifications(): void {
        const baseline = this.pendingNotificationBaseline
        if (!baseline) return
        this.dirtyEntityIds = this.pendingDirtyEntityIds ? new Set(this.pendingDirtyEntityIds) : null
        this.pendingNotificationBaseline = null
        this.pendingDirtyEntityIds = new Set()
        this.notifyChangedListeners(baseline, this.snapshot)
    }

    private syncPrevTailStateFromPrefix(
        prefixCache: SettledPrefixCache,
        reconciledById: ChatBlocksById,
        reconciledBlocks: readonly ChatBlock[],
        visibleBlocks: readonly VisibleChatBlock[],
        blocksWithThreadIds: readonly BlockWithThreadMessageId[],
        allToolGroups: readonly ToolGroupBlock[],
        turnsById: ReadonlyMap<string, TurnEntitySnapshot>,
        turnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>,
        turnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>,
        timelineIndex: readonly TimelineEntryRef[],
        outlineItems: readonly ConversationOutlineItem[]
    ): void {
        const prefixIds = new Set(prefixCache.prefixById.keys())
        const nextTailById = new Map<string, ChatBlock>()
        for (const [id, block] of reconciledById.entries()) {
            if (!prefixIds.has(id)) {
                nextTailById.set(id, block)
            }
        }
        this.prevTailById = nextTailById
        this.prevTailBlocks = reconciledBlocks.slice(prefixCache.prefixBlocks.length)
        this.prevTailVisibleBlocks = visibleBlocks.slice(prefixCache.prefixVisibleBlocks.length)
        const nextTailVisibleById = new Map<string, VisibleChatBlock>()
        for (const block of this.prevTailVisibleBlocks) {
            nextTailVisibleById.set(block.id, block)
        }
        for (let i = prefixCache.prefixBlocksWithThreadIds.length; i < blocksWithThreadIds.length; i += 1) {
            const entry = blocksWithThreadIds[i]!
            if (visibleBlockRole(entry.block) !== 'assistant') {
                nextTailVisibleById.set(entry.threadMessageId, entry.block)
            }
        }
        this.prevTailVisibleById = nextTailVisibleById
        const prefixGroupIds = new Set(prefixCache.prefixToolGroups.map((g) => g.id))
        this.prevTailToolGroups = allToolGroups.filter((g) => !prefixGroupIds.has(g.id))
        const prefixTurnIds = new Set(prefixCache.prefixTurnsById.keys())
        const nextTailTurns = new Map<string, TurnEntitySnapshot>()
        const nextTailLayouts = new Map<string, TurnLayoutSnapshot>()
        const nextTailHeaders = new Map<string, TurnHeaderSnapshot>()
        for (const [id, turn] of turnsById) {
            if (!prefixTurnIds.has(id)) {
                nextTailTurns.set(id, turn)
                const layout = turnLayoutsById.get(id)
                if (layout) nextTailLayouts.set(id, layout)
                const header = turnHeadersById.get(id)
                if (header) nextTailHeaders.set(id, header)
            }
        }
        this.prevTailTurnsById = nextTailTurns
        this.prevTailTurnLayoutsById = nextTailLayouts
        this.prevTailTurnHeadersById = nextTailHeaders
        this.prevTailTimelineIndex = timelineIndex.slice(prefixCache.prefixTimelineIndex.length)
        this.prevTailOutlineItems = outlineItems.slice(prefixCache.prefixOutlineItems.length)
    }

    private tryBuildSettledPrefixCache(
        rawMessages: readonly DecryptedMessage[],
        normalized: readonly NormalizedMessage[],
        splitIndex: number,
        reconciledBlocks: readonly ChatBlock[],
        fullVisibleBlocks: readonly VisibleChatBlock[],
        fullTimeline: TimelineCheckpoint,
        agentState: AgentState | null | undefined,
        hasMoreMessages: boolean,
        codexExplorationCollapsed: boolean,
        flavor: string | null | undefined,
        metadata: SessionMetadataSummary | null | undefined,
        _previousGroups: readonly ToolGroupBlock[],
        fullBlocksWithThreadIds: readonly BlockWithThreadMessageId[],
        fullTurnsById: ReadonlyMap<string, TurnEntitySnapshot>,
        fullTurnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>,
        fullTurnHeadersById: ReadonlyMap<string, TurnHeaderSnapshot>,
        fullTimelineIndex: readonly TimelineEntryRef[],
        fullOutlineItems: readonly ConversationOutlineItem[]
    ): SettledPrefixCache | null {
        if (splitIndex < 0) return null
        const boundaryMsg = normalized[splitIndex]
        if (!boundaryMsg) return null

        let rawBoundaryIndex = -1
        for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
            if (rawMessages[i]!.id === boundaryMsg.id) {
                rawBoundaryIndex = i
                break
            }
        }
        if (rawBoundaryIndex < 0) return null
        const rawPrefix = rawMessages.slice(0, rawBoundaryIndex + 1)
        const prefixSeenMessageIds = new Set<string>()
        const prefixVisibleMessages: DecryptedMessage[] = []
        for (const msg of rawPrefix) {
            if (msg.status === 'sending' || isDisplayedInQueueBar(msg)) {
                return null
            }
            prefixSeenMessageIds.add(msg.id)
            prefixVisibleMessages.push(msg)
        }

        let userBlockIndex = -1
        for (let i = reconciledBlocks.length - 1; i >= 0; i -= 1) {
            const block = reconciledBlocks[i]!
            if (block.kind === 'user-text' && block.id === boundaryMsg.id) {
                userBlockIndex = i
                break
            }
        }
        if (userBlockIndex < 0) return null

        const prefixBlocks = reconciledBlocks.slice(0, userBlockIndex + 1)
        if (hasUnsettledPrefixBlocks(prefixBlocks)) {
            return null
        }

        const prefixMessages = normalized.slice(0, splitIndex + 1)
        if (hasUnsettledPrefixMessages(prefixMessages)) {
            return null
        }

        const prefixById = new Map<string, ChatBlock>()
        const prefixRunningToolIds = new Set<string>()
        for (const block of prefixBlocks) {
            prefixById.set(block.id, block)
            if (block.kind === 'tool-call' && (block.tool.state === 'running' || block.tool.state === 'pending')) {
                prefixRunningToolIds.add(block.id)
                if (block.tool.id) prefixRunningToolIds.add(block.tool.id)
            }
        }

        let visibleUserBlockIndex = -1
        for (let i = fullVisibleBlocks.length - 1; i >= 0; i -= 1) {
            const block = fullVisibleBlocks[i]!
            if (block.kind === 'user-text' && block.id === boundaryMsg.id) {
                visibleUserBlockIndex = i
                break
            }
        }
        if (visibleUserBlockIndex < 0) return null
        const prefixVisibleBlocks = fullVisibleBlocks.slice(0, visibleUserBlockIndex + 1)
        const prefixToolGroups = prefixVisibleBlocks.filter(isToolGroupBlock)

        let timelineUserBlockIndex = -1
        for (let i = fullTimeline.blocks.length - 1; i >= 0; i -= 1) {
            const block = fullTimeline.blocks[i]!
            if (block.kind === 'user-text' && block.id === boundaryMsg.id) {
                timelineUserBlockIndex = i
                break
            }
        }
        if (timelineUserBlockIndex < 0) return null

        const {
            prefixToolIds,
            prefixUuids,
            prefixPrompts,
            prefixStreamIds,
            prefixTitleChanges,
            prefixWorkCardIds,
        } = collectPrefixLookupSets(prefixMessages, prefixBlocks)

        const prefixPermissionsSignature = computePrefixPermissionsSignature(
            agentState,
            prefixToolIds,
            boundaryMsg.createdAt
        )

        let prefixEntryEnd = -1
        for (let i = fullBlocksWithThreadIds.length - 1; i >= 0; i -= 1) {
            const entry = fullBlocksWithThreadIds[i]!
            if (entry.block.kind === 'user-text' && entry.block.id === boundaryMsg.id) {
                prefixEntryEnd = i
                break
            }
        }
        if (prefixEntryEnd < 0) return null

        const boundaryThreadMessageId = fullBlocksWithThreadIds[prefixEntryEnd]!.threadMessageId
        let prefixTimelineEnd = -1
        for (let i = fullTimelineIndex.length - 1; i >= 0; i -= 1) {
            if (fullTimelineIndex[i]!.id === boundaryThreadMessageId) {
                prefixTimelineEnd = i
                break
            }
        }
        if (prefixTimelineEnd < 0) return null

        const prefixBlocksWithThreadIds = fullBlocksWithThreadIds.slice(0, prefixEntryEnd + 1)
        const prefixTimelineIndex = fullTimelineIndex.slice(0, prefixTimelineEnd + 1)

        const prefixRawIdSeen = new Map<string, number>()
        const prefixUsedGroupIds = new Set<string>()
        const prefixGroupByRawId = new Map<string, string>()
        const prefixVisibleById = new Map<string, VisibleChatBlock>()
        const prefixTurnsById = new Map<string, TurnEntitySnapshot>()
        const prefixTurnLayoutsById = new Map<string, TurnLayoutSnapshot>()
        const prefixTurnHeadersById = new Map<string, TurnHeaderSnapshot>()

        for (const block of prefixVisibleBlocks) {
            prefixVisibleById.set(block.id, block)
        }
        let currentAssistantGroupId: string | null = null
        for (const entry of prefixBlocksWithThreadIds) {
            const block = entry.block
            const id = block.kind === 'user-text' ? block.localId || block.id : block.id
            const base = `${block.kind}:${id}`
            const occ = prefixRawIdSeen.get(base) ?? 0
            prefixRawIdSeen.set(base, occ + 1)
            const rawId = occ === 0 ? base : `${base}~${occ}`
            if (visibleBlockRole(block) !== 'assistant') {
                currentAssistantGroupId = null
                prefixUsedGroupIds.add(entry.threadMessageId)
                prefixUsedGroupIds.add(rawId)
                prefixVisibleById.set(entry.threadMessageId, block)
            } else {
                if (currentAssistantGroupId === null) {
                    currentAssistantGroupId = entry.threadMessageId
                    prefixUsedGroupIds.add(currentAssistantGroupId)
                }
                prefixGroupByRawId.set(rawId, currentAssistantGroupId)
                prefixGroupByRawId.set(`block:${block.id}`, currentAssistantGroupId)
                if (block.kind === 'tool-group') {
                    for (const tool of block.tools) {
                        prefixGroupByRawId.set(`tool-call:${tool.id}`, currentAssistantGroupId)
                        prefixGroupByRawId.set(`block:${tool.id}`, currentAssistantGroupId)
                    }
                }
                const turn = fullTurnsById.get(currentAssistantGroupId)
                if (turn && !prefixTurnsById.has(currentAssistantGroupId)) {
                    prefixTurnsById.set(currentAssistantGroupId, turn)
                    const layout = fullTurnLayoutsById.get(currentAssistantGroupId)
                    if (layout) prefixTurnLayoutsById.set(currentAssistantGroupId, layout)
                    const header = fullTurnHeadersById.get(currentAssistantGroupId)
                    if (header) prefixTurnHeadersById.set(currentAssistantGroupId, header)
                }
            }
        }

        const tailHasUserBlock = reconciledBlocks.slice(userBlockIndex + 1).some((b) => b.kind === 'user-text')
        const prefixOutlineItems = tailHasUserBlock
            ? buildConversationOutline([...prefixBlocks], this.prevOutlineItems)
            : fullOutlineItems
        const absorbedTailMessages = new Set<string>()

        const prefixLatestUsage = findLatestUsageInMessages(prefixMessages)
        const prefixHasReadyEvent = prefixMessages.some((m) => m.role === 'event' && m.content.type === 'ready')
        const prefixTimeline: TimelineCheckpoint = {
            blocks: fullTimeline.blocks.slice(0, timelineUserBlockIndex + 1),
            hasReadyEvent: prefixHasReadyEvent,
        }

        const candidateCache: SettledPrefixCache = {
            rawPrefix,
            prefixVisibleMessages,
            prefixSeenMessageIds,
            prefixMessages,
            splitIndex,
            splitCreatedAt: boundaryMsg.createdAt,
            boundaryMessageId: boundaryMsg.id,
            prefixBlocks,
            prefixTimeline,
            prefixById,
            prefixVisibleBlocks,
            prefixToolGroups,
            prefixHasMoreMessages: hasMoreMessages,
            prefixCodexExplorationCollapsed: codexExplorationCollapsed,
            prefixFlavor: flavor,
            prefixMetadata: metadata,
            prefixPermissionsSignature,
            prefixToolIds,
            prefixUuids,
            prefixPrompts,
            prefixStreamIds,
            prefixTitleChanges,
            prefixWorkCardIds,
            prefixLatestUsage,
            prefixHasReadyEvent,
            prefixGoalSummary: buildThreadGoalPrefixSummary(prefixMessages),
            prefixLatestRefusalEvent: findLatestRefusalEvent(prefixMessages),
            prefixStatusSummary: buildSessionStatusPrefixSummary(prefixBlocks, prefixMessages),
            absorbedTailMessages,
            prefixRunningToolIds,
            prefixRawIdSeen,
            prefixUsedGroupIds,
            prefixGroupByRawId,
            prefixBlocksWithThreadIds,
            prefixVisibleById,
            prefixTurnsById,
            prefixTurnLayoutsById,
            prefixTurnHeadersById,
            prefixTimelineIndex,
            prefixOutlineItems,
        }

        for (let i = splitIndex + 1; i < normalized.length; i += 1) {
            const tailMsg = normalized[i]!
            if (isPureAlreadyAppliedPrefixToolResultMessage(tailMsg, candidateCache)) {
                absorbedTailMessages.add(tailMsg.id)
                continue
            }
            if (tailMessageReferencesPrefix(tailMsg, candidateCache)) {
                return null
            }
        }

        return candidateCache
    }

    private notifyChangedListeners(
        prev: SessionEntityStoreSnapshot,
        next: SessionEntityStoreSnapshot
    ): void {
        const timelineChanged = prev.timelineIndex !== next.timelineIndex
        const runtimeTopologyChanged = prev.runtimeTopologyVersion !== next.runtimeTopologyVersion
        const metaChanged = prev.meta !== next.meta

        const changedEntityIds = new Set<string>()
        if (this.entityListeners.size > 0) {
            const candidateIds: Iterable<string> = this.dirtyEntityIds ?? this.entityListeners.keys()
            for (const id of candidateIds) {
                if (!this.entityListeners.has(id)) continue
                const prevVisible = prev.visibleById.get(id)
                const nextVisible = next.visibleById.get(id)
                const prevBlock = prev.byId.get(id)
                const nextBlock = next.byId.get(id)
                const prevTurn = prev.turnsById.get(id)
                const nextTurn = next.turnsById.get(id)
                const layoutId = id.startsWith('layout:') ? id.slice('layout:'.length) : null
                const layoutChanged = layoutId !== null && prev.turnLayoutsById.get(layoutId) !== next.turnLayoutsById.get(layoutId)
                const headerId = id.startsWith('header:') ? id.slice('header:'.length) : null
                const headerChanged = headerId !== null && prev.turnHeadersById.get(headerId) !== next.turnHeadersById.get(headerId)
                if (
                    prevVisible !== nextVisible
                    || prevBlock !== nextBlock
                    || prevTurn !== nextTurn
                    || layoutChanged
                    || headerChanged
                ) {
                    changedEntityIds.add(id)
                }
            }
        }
        this.dirtyEntityIds = null

        const anySnapshotChanged =
            timelineChanged
            || runtimeTopologyChanged
            || metaChanged
            || prev.sessionId !== next.sessionId
            || prev.visibleBlocks !== next.visibleBlocks
            || prev.blocks !== next.blocks

        if (anySnapshotChanged) {
            for (const listener of [...this.storeListeners]) {
                listener()
            }
        }

        if (timelineChanged) {
            for (const listener of [...this.timelineListeners]) {
                listener()
            }
        }

        if (runtimeTopologyChanged) {
            for (const listener of [...this.runtimeTopologyListeners]) {
                listener()
            }
        }

        if (metaChanged) {
            for (const listener of [...this.metaListeners]) {
                listener()
            }
        }
        for (const id of changedEntityIds) {
            const bucket = this.entityListeners.get(id)
            if (!bucket) continue
            for (const listener of [...bucket]) {
                listener()
            }
        }
    }
}

export function createSessionEntityStore(): SessionEntityStore {
    return new SessionEntityStore()
}
