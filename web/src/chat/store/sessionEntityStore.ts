// Pure domain session entity store (no React imports).
import { isCliOutputText } from '@/chat/reducerCliOutput'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { buildConversationOutline, type ConversationOutlineItem } from '@/chat/outline'
import {
    areSessionStatusDataEqual,
    buildSessionStatusData,
    type SessionStatusData,
} from '@/chat/sessionStatus'
import { reduceChatBlocks, type LatestUsage } from '@/chat/reducer'
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
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import {
    buildThreadTopology,
    buildTurnLayoutsById,
    assignThreadMessageIdsWithStableWrappers,
    buildTurnEntitiesById,
    filterVisibleBlocksForFlavor,
    hoistMidTurnTitleEvents,
    visibleBlockToTurnContentPart,
    type BlockWithThreadMessageId,
    type TurnEntityContentPart,
    type TurnEntitySnapshot,
    type ThreadMessageTopology,
    type TurnLayoutSnapshot,
} from '@/lib/assistant-runtime-blocks'
import { isDisplayedInQueueBar } from '@/lib/messages'
import type { AgentState, DecryptedMessage, SessionMetadataSummary, ThreadGoal } from '@/types/api'

export type { TurnEntityContentPart, TurnEntitySnapshot, TurnLayoutSnapshot }
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
}

export type SessionEntityStoreSnapshot = {
    readonly sessionId: string | null
    readonly visibleMessages: readonly DecryptedMessage[]
    readonly normalizedMessages: readonly NormalizedMessage[]
    readonly timelineIndex: readonly TimelineEntryRef[]
    readonly timelineStructureKey: string
    readonly timelineVersion: number
    readonly blocks: readonly ChatBlock[]
    readonly byId: ChatBlocksById
    readonly visibleBlocks: readonly VisibleChatBlock[]
    readonly visibleById: ReadonlyMap<string, VisibleChatBlock>
    readonly blocksWithThreadIds: readonly BlockWithThreadMessageId[]
    readonly turnsById: ReadonlyMap<string, TurnEntitySnapshot>
    readonly turnLayoutsById: ReadonlyMap<string, TurnLayoutSnapshot>
    readonly outlineItems: readonly ConversationOutlineItem[]
    readonly sessionStatus: SessionStatusData | null
    readonly meta: SessionEntityMetaSnapshot
    readonly latestUsage: LatestUsage | null
    readonly latestGoal: ThreadGoal | null
    readonly hasReadyEvent: boolean
    readonly hasRunningChildAgent: boolean
    readonly activityLabel: string | null
    readonly hasLiveStreamingMessage: boolean
    readonly reductionMode: 'incremental-tail' | 'full' | 'noop'
    readonly splitIndex: number
}

type SettledPrefixCache = {
    readonly prefixMessages: readonly NormalizedMessage[]
    readonly splitIndex: number
    readonly splitCreatedAt: number
    readonly prefixBlocks: readonly ChatBlock[]
    readonly prefixById: ChatBlocksById
    readonly prefixVisibleBlocks: readonly VisibleChatBlock[]
    readonly prefixToolGroups: readonly ToolGroupBlock[]
    readonly prefixHasMoreMessages: boolean
    readonly prefixCodexExplorationCollapsed: boolean
    readonly prefixPermissionsSignature: string
    readonly prefixToolIds: ReadonlySet<string>
    readonly prefixUuids: ReadonlySet<string>
    readonly prefixPrompts: ReadonlySet<string>
    readonly prefixStreamIds: ReadonlySet<string>
    readonly prefixTitleChanges: ReadonlySet<string>
    readonly prefixWorkCardIds: ReadonlySet<string>
    readonly prefixLatestUsage: LatestUsage | null
    readonly prefixHasReadyEvent: boolean
}

const EMPTY_TIMELINE_INDEX: readonly TimelineEntryRef[] = Object.freeze([])
const EMPTY_BLOCKS: readonly ChatBlock[] = Object.freeze([])
const EMPTY_BY_ID: ChatBlocksById = new Map()
const EMPTY_VISIBLE_BLOCKS: readonly VisibleChatBlock[] = Object.freeze([])
const EMPTY_VISIBLE_BY_ID: ReadonlyMap<string, VisibleChatBlock> = new Map()
const EMPTY_BLOCKS_WITH_THREAD_IDS: readonly BlockWithThreadMessageId[] = Object.freeze([])
const EMPTY_TURNS_BY_ID: ReadonlyMap<string, TurnEntitySnapshot> = new Map()
const EMPTY_TURN_LAYOUTS: ReadonlyMap<string, TurnLayoutSnapshot> = new Map()
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

function findLatestUserTurnSplitIndex(normalized: readonly NormalizedMessage[]): number {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
        if (isRootUserTurnBoundaryMessage(normalized[i]!)) {
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
            block.tool.state === 'running'
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
    if (msg.role === 'user' && !msg.steered) {
        // A new non-steered user message starts a new turn; run one full reduction
        // so the previous turn is sealed into the settled prefix.
        return true
    }
    if (msg.role === 'agent') {
        if (msg.streamSnapshot?.id && cache.prefixStreamIds.has(msg.streamSnapshot.id)) {
            return true
        }
        for (const c of msg.content) {
            if ('parentUUID' in c && typeof c.parentUUID === 'string' && cache.prefixUuids.has(c.parentUUID)) {
                return true
            }
        }
    }
    if (msg.parentToolUseId && cache.prefixToolIds.has(msg.parentToolUseId)) {
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

function canReuseSettledPrefix(
    normalized: readonly NormalizedMessage[],
    agentState: AgentState | null | undefined,
    hasMoreMessages: boolean,
    codexExplorationCollapsed: boolean,
    cache: SettledPrefixCache | null
): cache is SettledPrefixCache {
    if (!cache) return false
    if (cache.prefixHasMoreMessages !== hasMoreMessages) return false
    if (cache.prefixCodexExplorationCollapsed !== codexExplorationCollapsed) return false
    const prefixLen = cache.prefixMessages.length
    if (normalized.length < prefixLen) return false

    for (let i = 0; i < prefixLen; i += 1) {
        if (normalized[i] !== cache.prefixMessages[i]) {
            return false
        }
    }

    const permSig = computePrefixPermissionsSignature(
        agentState,
        cache.prefixToolIds,
        cache.splitCreatedAt
    )
    if (permSig !== cache.prefixPermissionsSignature) {
        return false
    }

    for (let i = prefixLen; i < normalized.length; i += 1) {
        if (tailMessageReferencesPrefix(normalized[i]!, cache)) {
            return false
        }
    }

    return true
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
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
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
    private settledPrefixCache: SettledPrefixCache | null = null
    private prevTailById: ChatBlocksById = new Map()
    private prevTailToolGroups: ToolGroupBlock[] = []
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
        blocks: EMPTY_BLOCKS,
        byId: EMPTY_BY_ID,
        visibleBlocks: EMPTY_VISIBLE_BLOCKS,
        visibleById: EMPTY_VISIBLE_BY_ID,
        blocksWithThreadIds: EMPTY_BLOCKS_WITH_THREAD_IDS,
        turnsById: EMPTY_TURNS_BY_ID,
        turnLayoutsById: EMPTY_TURN_LAYOUTS,
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
        this.settledPrefixCache = null
        this.threadIdWrapperCache = new WeakMap()
        this.turnPartCache = new WeakMap()
        this.prevTailById = new Map()
        this.prevTailToolGroups = []
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
            blocks: EMPTY_BLOCKS,
            byId: EMPTY_BY_ID,
            visibleBlocks: EMPTY_VISIBLE_BLOCKS,
            visibleById: EMPTY_VISIBLE_BY_ID,
            blocksWithThreadIds: EMPTY_BLOCKS_WITH_THREAD_IDS,
            turnsById: EMPTY_TURNS_BY_ID,
            turnLayoutsById: EMPTY_TURN_LAYOUTS,
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

    private normalizeMessageList(messages: readonly DecryptedMessage[]): NormalizedMessage[] {
        const result: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const msg of messages) {
            if (seen.has(msg.id)) {
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
            this.settledPrefixCache = null
            this.threadIdWrapperCache = new WeakMap()
            this.turnPartCache = new WeakMap()
            this.prevTailById = new Map()
            this.prevTailToolGroups = []
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
            return this.snapshot
        }
        this.lastInput = input

        const prevSnapshot = this.snapshot
        const visibleMessages: DecryptedMessage[] = []
        const queuedMessages: DecryptedMessage[] = []
        let isSending = false

        for (const msg of input.messages) {
            if (msg.status === 'sending') {
                isSending = true
            }
            if (isDisplayedInQueueBar(msg)) {
                queuedMessages.push(msg)
            } else {
                visibleMessages.push(msg)
            }
        }

        const normalized = this.normalizeMessageList(visibleMessages)
        const goalSource = input.goalSourceMessages ?? buildGoalStateMessages(input.messages)
        const goalNormalized = (
            goalSource.length === visibleMessages.length
            && isSameArrayElements(goalSource, visibleMessages)
        )
            ? normalized
            : this.normalizeMessageList(goalSource)

        let reconciledBlocks: readonly ChatBlock[]
        let reconciledById: ChatBlocksById
        let visibleBlocks: readonly VisibleChatBlock[]
        let latestUsage: LatestUsage | null
        let latestGoal: ThreadGoal | null
        let hasReadyEvent: boolean
        let reductionMode: 'incremental-tail' | 'full'
        let splitIndex: number

        const hasMoreMessages = input.hasMoreMessages ?? false
        const codexExplorationCollapsed = input.codexExplorationCollapsed ?? false

        if (
            canReuseSettledPrefix(
                normalized,
                input.agentState,
                hasMoreMessages,
                codexExplorationCollapsed,
                this.settledPrefixCache
            )
        ) {
            const prefixCache = this.settledPrefixCache
            reductionMode = 'incremental-tail'
            splitIndex = prefixCache.splitIndex

            const tailMessages = normalized.slice(prefixCache.prefixMessages.length)
            const tailReduced = reduceChatBlocks(tailMessages, input.agentState, {
                goalStateMessages: goalNormalized,
            })
            const tailReconciled = reconcileChatBlocks(tailReduced.blocks, this.prevTailById)
            this.prevTailById = tailReconciled.byId

            const tailVisible = buildVisibleChatBlocks(tailReconciled.blocks, {
                hasMoreMessages: false,
                previousGroups: this.prevTailToolGroups,
                codexExplorationCollapsed,
            })
            this.prevTailToolGroups = tailVisible.filter(isToolGroupBlock)

            reconciledBlocks = prefixCache.prefixBlocks.length === 0
                ? tailReconciled.blocks
                : tailReconciled.blocks.length === 0
                    ? prefixCache.prefixBlocks
                    : [...prefixCache.prefixBlocks, ...tailReconciled.blocks]

            const mergedById = new Map<string, ChatBlock>(prefixCache.prefixById)
            for (const [id, block] of tailReconciled.byId.entries()) {
                mergedById.set(id, block)
            }
            reconciledById = mergedById

            visibleBlocks = prefixCache.prefixVisibleBlocks.length === 0
                ? tailVisible
                : tailVisible.length === 0
                    ? prefixCache.prefixVisibleBlocks
                    : [...prefixCache.prefixVisibleBlocks, ...tailVisible]

            this.prevFullToolGroups = [...prefixCache.prefixToolGroups, ...this.prevTailToolGroups]
            latestUsage = tailReduced.latestUsage ?? prefixCache.prefixLatestUsage
            latestGoal = tailReduced.latestGoal
            hasReadyEvent = prefixCache.prefixHasReadyEvent || tailReduced.hasReadyEvent
        } else {
            reductionMode = 'full'
            const fullReduced = reduceChatBlocks(normalized, input.agentState, {
                goalStateMessages: goalNormalized,
            })
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
            visibleBlocks = fullVisible

            latestUsage = fullReduced.latestUsage
            latestGoal = fullReduced.latestGoal
            hasReadyEvent = fullReduced.hasReadyEvent

            splitIndex = findLatestUserTurnSplitIndex(normalized)
            this.settledPrefixCache = this.tryBuildSettledPrefixCache(
                normalized,
                splitIndex,
                reconciledBlocks,
                input.agentState,
                hasMoreMessages,
                codexExplorationCollapsed,
                allGroups
            )
            if (this.settledPrefixCache) {
                const prefixIds = new Set(this.settledPrefixCache.prefixById.keys())
                const nextTailById = new Map<string, ChatBlock>()
                for (const [id, block] of reconciledById.entries()) {
                    if (!prefixIds.has(id)) {
                        nextTailById.set(id, block)
                    }
                }
                this.prevTailById = nextTailById
                const prefixGroupIds = new Set(this.settledPrefixCache.prefixToolGroups.map((g) => g.id))
                this.prevTailToolGroups = allGroups.filter((g) => !prefixGroupIds.has(g.id))
            } else {
                this.prevTailById = new Map()
                this.prevTailToolGroups = []
            }
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

        const visibleById = new Map<string, VisibleChatBlock>()
        for (const block of stableVisibleBlocks) {
            visibleById.set(block.id, block)
        }

        const hasLiveStreamingMessage = hasUnsettledPrefixMessages(stableNormalizedMessages)
        const canReuseBlocksWithThreadIds = !sessionChanged
            && stableVisibleBlocks === prevSnapshot.visibleBlocks
            && input.metadata?.flavor === prevInput?.metadata?.flavor
        const blocksWithThreadIds = canReuseBlocksWithThreadIds
            ? prevSnapshot.blocksWithThreadIds
            : assignThreadMessageIdsWithStableWrappers(
                hoistMidTurnTitleEvents(filterVisibleBlocksForFlavor(stableVisibleBlocks, input.metadata?.flavor)),
                this.threadIdWrapperCache
            )
        for (const entry of blocksWithThreadIds) {
            if (visibleBlockRole(entry.block) !== 'assistant') {
                visibleById.set(entry.threadMessageId, entry.block)
            }
        }
        const turnsById = canReuseBlocksWithThreadIds
            ? prevSnapshot.turnsById
            : buildTurnEntitiesById(blocksWithThreadIds, sessionChanged ? EMPTY_TURNS_BY_ID : prevSnapshot.turnsById, this.turnPartCache)
        const turnLayoutsById = turnsById === prevSnapshot.turnsById
            ? prevSnapshot.turnLayoutsById
            : buildTurnLayoutsById(turnsById, sessionChanged ? EMPTY_TURN_LAYOUTS : prevSnapshot.turnLayoutsById)
        const outlineItems = (!sessionChanged && stableBlocks === prevSnapshot.blocks)
            ? prevSnapshot.outlineItems
            : buildConversationOutline([...stableBlocks], this.prevOutlineItems)
        this.prevOutlineItems = [...outlineItems]

        const timelineIndex = buildThreadTopology(blocksWithThreadIds, sessionChanged ? EMPTY_TIMELINE_INDEX : prevSnapshot.timelineIndex)
        const timelineStructureKey = timelineIndex === prevSnapshot.timelineIndex && !sessionChanged
            ? prevSnapshot.timelineStructureKey
            : timelineIndex.map((entry) => `${entry.role}:${entry.kind}:${entry.id}`).join('|')
        const timelineVersion = (sessionChanged ? 0 : prevSnapshot.timelineVersion)
            + (timelineIndex === (sessionChanged ? EMPTY_TIMELINE_INDEX : prevSnapshot.timelineIndex) ? 0 : 1)
        const stableQueuedMessages = isSameArrayElements(queuedMessages, prevSnapshot.meta.queuedMessages)
            ? prevSnapshot.meta.queuedMessages
            : Object.freeze(queuedMessages)
        const stableLatestUsage = isSameLatestUsage(latestUsage, prevSnapshot.meta.latestUsage)
            ? prevSnapshot.meta.latestUsage
            : latestUsage
        const stableLatestGoal = isSameThreadGoal(latestGoal, prevSnapshot.meta.latestGoal)
            ? prevSnapshot.meta.latestGoal
            : latestGoal
        const contextSize = stableLatestUsage?.contextSize
        const hasRunningChildAgent = hasAbortableAgentRun(stableBlocks)
        const activityLabel = findActiveToolActivityLabel(stableBlocks)

        const rawSessionStatus = buildSessionStatusData({
            goal: stableLatestGoal,
            blocks: [...stableBlocks],
            messages: [...stableNormalizedMessages],
            backgroundTaskCount: input.backgroundTaskCount,
            includeSubagents: false,
        })
        const sessionStatus = (
            this.prevSessionStatus && areSessionStatusDataEqual(this.prevSessionStatus, rawSessionStatus)
        )
            ? this.prevSessionStatus
            : rawSessionStatus
        this.prevSessionStatus = sessionStatus

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
            blocks: stableBlocks,
            byId: reconciledById,
            visibleBlocks: stableVisibleBlocks,
            visibleById,
            blocksWithThreadIds,
            turnsById,
            turnLayoutsById,
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
            splitIndex,
        }
        this.snapshot = nextSnapshot
        if (options?.deferNotifications) {
            if (!this.pendingNotificationBaseline) {
                this.pendingNotificationBaseline = prevSnapshot
            }
        } else {
            const baseline = this.pendingNotificationBaseline ?? prevSnapshot
            this.pendingNotificationBaseline = null
            this.notifyChangedListeners(baseline, nextSnapshot)
        }
        return nextSnapshot
    }

    flushNotifications(): void {
        const baseline = this.pendingNotificationBaseline
        if (!baseline) return
        this.pendingNotificationBaseline = null
        this.notifyChangedListeners(baseline, this.snapshot)
    }

    private tryBuildSettledPrefixCache(
        normalized: readonly NormalizedMessage[],
        splitIndex: number,
        reconciledBlocks: readonly ChatBlock[],
        agentState: AgentState | null | undefined,
        hasMoreMessages: boolean,
        codexExplorationCollapsed: boolean,
        previousGroups: readonly ToolGroupBlock[]
    ): SettledPrefixCache | null {
        if (splitIndex < 0) return null
        const boundaryMsg = normalized[splitIndex]
        if (!boundaryMsg) return null

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
        const prefixReduced = reduceChatBlocks(prefixMessages, agentState)
        if (prefixReduced.blocks.length !== prefixBlocks.length) {
            return null
        }
        for (let i = 0; i < prefixBlocks.length; i += 1) {
            if (
                prefixReduced.blocks[i]?.id !== prefixBlocks[i]?.id
                || prefixReduced.blocks[i]?.kind !== prefixBlocks[i]?.kind
            ) {
                return null
            }
        }

        const prefixById = new Map<string, ChatBlock>()
        for (const block of prefixBlocks) {
            prefixById.set(block.id, block)
        }

        const prefixVisibleBlocks = buildVisibleChatBlocks(prefixBlocks, {
            hasMoreMessages,
            previousGroups: [...previousGroups],
            codexExplorationCollapsed,
        })
        const prefixToolGroups = prefixVisibleBlocks.filter(isToolGroupBlock)

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

        const candidateCache: SettledPrefixCache = {
            prefixMessages,
            splitIndex,
            splitCreatedAt: boundaryMsg.createdAt,
            prefixBlocks,
            prefixById,
            prefixVisibleBlocks,
            prefixToolGroups,
            prefixHasMoreMessages: hasMoreMessages,
            prefixCodexExplorationCollapsed: codexExplorationCollapsed,
            prefixPermissionsSignature,
            prefixToolIds,
            prefixUuids,
            prefixPrompts,
            prefixStreamIds,
            prefixTitleChanges,
            prefixWorkCardIds,
            prefixLatestUsage: prefixReduced.latestUsage,
            prefixHasReadyEvent: prefixReduced.hasReadyEvent,
        }

        for (let i = splitIndex + 1; i < normalized.length; i += 1) {
            if (tailMessageReferencesPrefix(normalized[i]!, candidateCache)) {
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
        const metaChanged = prev.meta !== next.meta

        const changedEntityIds = new Set<string>()
        if (this.entityListeners.size > 0) {
            for (const id of this.entityListeners.keys()) {
                const prevVisible = prev.visibleById.get(id)
                const nextVisible = next.visibleById.get(id)
                const prevBlock = prev.byId.get(id)
                const nextBlock = next.byId.get(id)
                const prevTurn = prev.turnsById.get(id)
                const nextTurn = next.turnsById.get(id)
                const layoutId = id.startsWith('layout:') ? id.slice('layout:'.length) : null
                const layoutChanged = layoutId !== null && prev.turnLayoutsById.get(layoutId) !== next.turnLayoutsById.get(layoutId)
                if (
                    prevVisible !== nextVisible
                    || prevBlock !== nextBlock
                    || prevTurn !== nextTurn
                    || layoutChanged
                ) {
                    changedEntityIds.add(id)
                }
            }
        }

        const anySnapshotChanged =
            timelineChanged
            || metaChanged
            || prev.sessionId !== next.sessionId
            || !isSameArrayElements(prev.visibleBlocks, next.visibleBlocks)
            || !isSameArrayElements(prev.blocks, next.blocks)

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
