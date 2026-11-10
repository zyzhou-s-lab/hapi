import type { TimelineCheckpoint } from '@/chat/reducer'
import type { NormalizedMessage } from '@/chat/types'
import { isCliOutputText } from '@/chat/reducerCliOutput'
import { parseMessageAsEvent } from '@/chat/reducerEvents'
import { titleFromChangeTitleCall } from '@/chat/reducerTools'
import { isSubagentToolName } from '@/chat/subagentTool'

export type RetainedTimelineSuffix = TimelineCheckpoint & {
    readonly startMessageId: string
    readonly replayedMessages: number
}

const INDEPENDENT_EVENTS: Record<string, true> = {
    switch: true,
    message: true,
    error: true,
    'limit-reached': true,
    'limit-warning': true,
    ready: true,
    'api-error': true,
    microcompact: true,
    compact: true,
    'compact-summary': true,
    recap: true,
    'model-refusal-fallback': true,
    'thread-goal-updated': true,
    'thread-goal-cleared': true,
    'abort-restore': true,
    'token-count': true,
    'omp-compaction': true,
    'turn-lifecycle': true,
}

const NON_EMITTING_EVENTS: Record<string, true> = {
    ready: true,
    'token-count': true,
    'abort-restore': true,
    'turn-summary': true,
    'turn-duration': true,
}

/** A checkpoint is a dependency-closed raw-timeline cut, not a REST page or user turn. */
export function findRetainedTimelineSuffix(
    messages: readonly NormalizedMessage[],
    previousMessages: readonly NormalizedMessage[],
    checkpoint: TimelineCheckpoint
): RetainedTimelineSuffix | null {
    let shared = 0
    while (
        shared < messages.length && shared < previousMessages.length
        && messages[messages.length - 1 - shared] === previousMessages[previousMessages.length - 1 - shared]
    ) shared += 1
    const changedEnd = messages.length - shared
    if (changedEnd === 0 || shared !== previousMessages.length) return null

    const previousStates = new Map<string, string>()
    const currentStates = new Map<string, string>()
    for (const [items, states] of [[previousMessages, previousStates], [messages, currentStates]] as const) {
        for (const msg of items) {
            if (msg.isSidechain || msg.parentToolUseId != null || msg.turnId === undefined || msg.turnState === undefined || msg.turnState === 'history') continue
            if (msg.turnState !== 'running' || !states.has(msg.turnId)) states.set(msg.turnId, msg.turnState)
        }
    }
    // New terminal authority matters even when the old window had no state for that turn.
    for (let index = changedEnd; index < messages.length; index += 1) {
        const turnId = messages[index]!.turnId
        if (turnId !== undefined && currentStates.get(turnId) !== previousStates.get(turnId)) {
            return null
        }
    }

    const first = new Map<string, number>()
    const last = new Map<string, number>()
    const ends = messages.map((_, index) => index)
    const outputOwners = new Map<string, number>()
    let assistantRunStart = 0
    let precedingOutput = -1
    const add = (key: string, index: number): void => {
        if (!first.has(key)) first.set(key, index)
        last.set(key, index)
    }
    const recordOutputOwner = (key: string, index: number): void => {
        if (!outputOwners.has(key)) outputOwners.set(key, index)
    }

    for (let index = 0; index < messages.length; index += 1) {
        const msg = messages[index]!
        add(`message:${msg.id}`, index)
        if (msg.parentToolUseId) add(`tool:${msg.parentToolUseId}`, index)
        if (msg.role === 'user') {
            // CLI output has positional coalescing, including across suppressed messages.
            if (isCliOutputText(msg.content.text, msg.meta)) return null
            assistantRunStart = index + 1
            continue
        }
        if (msg.role === 'agent') {
            if (parseMessageAsEvent(msg) !== null) {
                assistantRunStart = index + 1
                continue
            }
            const streamBaseId = msg.streamSnapshot?.id ?? msg.id
            if (msg.streamSnapshot) add(`stream:${msg.streamSnapshot.id}`, index)
            for (let contentIdx = 0; contentIdx < msg.content.length; contentIdx += 1) {
                const content = msg.content[contentIdx]!
                if ('uuid' in content && content.uuid) add(`uuid:${content.uuid}`, index)
                if ('parentUUID' in content && content.parentUUID) add(`uuid:${content.parentUUID}`, index)
                if (content.type === 'text' || content.type === 'reasoning') {
                    if (content.streamId) add(`stream:${content.streamId}`, index)
                    if (content.type === 'text' && isCliOutputText(content.text, msg.meta)) return null
                    if (!msg.isSidechain) {
                        recordOutputOwner(streamBaseId, index)
                        recordOutputOwner(`${streamBaseId}:${contentIdx}`, index)
                        precedingOutput = index
                    }
                } else if (content.type === 'codex-review') {
                    if (!msg.isSidechain) {
                        recordOutputOwner(msg.id, index)
                        recordOutputOwner(`${msg.id}:${contentIdx}`, index)
                        precedingOutput = index
                    }
                } else if (content.type === 'tool-call') {
                    if (titleFromChangeTitleCall(content.name, content.input) || /title/i.test(content.name)) {
                        return null
                    }
                    add(`tool:${content.id}`, index)
                    if (isSubagentToolName(content.name) && typeof content.input === 'object' && content.input !== null && 'prompt' in content.input && typeof content.input.prompt === 'string') {
                        add(`prompt:${content.input.prompt}`, index)
                    }
                    if (!msg.isSidechain) {
                        recordOutputOwner(content.id, index)
                        precedingOutput = index
                    }
                } else if (content.type === 'tool-result') {
                    add(`tool:${content.tool_use_id}`, index)
                    if (!msg.isSidechain) {
                        recordOutputOwner(content.tool_use_id, index)
                        precedingOutput = first.get(`tool:${content.tool_use_id}`) ?? index
                    }
                } else if (content.type === 'sidechain') {
                    add(`prompt:${content.prompt}`, index)
                } else if (content.type === 'summary') {
                    return null
                }
            }
            continue
        }
        const event = msg.content
        if (event.type === 'turn-summary') {
            if (assistantRunStart < index) ends[assistantRunStart] = Math.max(ends[assistantRunStart]!, index)
        } else if (event.type === 'turn-duration') {
            // The reducer falls back to the preceding output when a named target is absent.
            if (precedingOutput >= 0) ends[precedingOutput] = Math.max(ends[precedingOutput]!, index)
            if (typeof event.targetMessageId === 'string' && event.targetMessageId.length > 0) {
                const owner = outputOwners.get(event.targetMessageId)
                if (owner === undefined) return null
                ends[owner] = Math.max(ends[owner]!, index)
            }
        } else if (!INDEPENDENT_EVENTS[event.type]) {
            return null
        }
        if (!NON_EMITTING_EVENTS[event.type]) {
            assistantRunStart = index + 1
        }
    }
    for (const [key, start] of first) ends[start] = Math.max(ends[start]!, last.get(key)!)

    const blockPositions = new Map<string, number>()
    for (let index = 0; index < checkpoint.blocks.length; index += 1) {
        const id = checkpoint.blocks[index]!.id
        if (blockPositions.has(id)) return null
        blockPositions.set(id, index)
    }

    let replayEnd = changedEnd
    for (let index = 0; index < messages.length; index += 1) {
        if (index < replayEnd) {
            replayEnd = Math.max(replayEnd, ends[index]! + 1)
            continue
        }
        const msg = messages[index]!
        if (msg.isSidechain || msg.parentToolUseId != null) continue
        let blockId: string | undefined
        if (msg.role === 'user') {
            blockId = msg.id
        } else if (msg.role === 'event') {
            if (!NON_EMITTING_EVENTS[msg.content.type]) blockId = msg.id
        } else if (parseMessageAsEvent(msg) !== null) {
            blockId = msg.id
        } else {
            const content = msg.content[0]
            if (content?.type === 'tool-call') blockId = content.id
            else if (content?.type === 'text' || content?.type === 'reasoning') blockId = `${msg.streamSnapshot?.id ?? msg.id}:0`
            else if (content?.type === 'generated-image' || content?.type === 'generated-file' || content?.type === 'codex-review') blockId = `${msg.id}:0`
        }
        const position = blockId === undefined ? undefined : blockPositions.get(blockId)
        if (position !== undefined) {
            return {
                startMessageId: msg.id,
                blocks: checkpoint.blocks.slice(position),
                hasReadyEvent: checkpoint.hasReadyEvent,
                replayedMessages: index
            }
        }
        replayEnd = Math.max(replayEnd, ends[index]! + 1)
    }
    return null
}
