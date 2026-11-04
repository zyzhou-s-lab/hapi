import type { AgentEvent, AgentEventBlock, ChatBlock, NormalizedMessage } from '@/chat/types'

function parseClaudeUsageLimit(text: string): AgentEvent | null {
    const reachedMatch = text.match(/^Claude AI usage limit reached\|(\d+)(?:\|([^|]*))?$/)
    if (reachedMatch) {
        const timestamp = Number.parseInt(reachedMatch[1], 10)
        if (Number.isFinite(timestamp)) {
            return { type: 'limit-reached', endsAt: timestamp, limitType: reachedMatch[2] || '' }
        }
    }

    const warningMatch = text.match(/^Claude AI usage limit warning\|(\d+)\|(\d+)\|([^|]*)$/)
    if (warningMatch) {
        const timestamp = Number.parseInt(warningMatch[1], 10)
        const utilization = Number.parseInt(warningMatch[2], 10) / 100
        const limitType = warningMatch[3] || ''
        if (Number.isFinite(timestamp) && Number.isFinite(utilization)) {
            return { type: 'limit-warning', utilization, endsAt: timestamp, limitType }
        }
    }

    return null
}

export function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
    if (msg.isSidechain) return null
    if (msg.role !== 'agent') return null

    for (const content of msg.content) {
        if (content.type === 'text') {
            const limitEvent = parseClaudeUsageLimit(content.text)
            if (limitEvent !== null) {
                return limitEvent
            }
        }
    }

    return null
}

export function dedupeAgentEvents(blocks: ChatBlock[]): ChatBlock[] {
    const result: ChatBlock[] = []
    let prevEventKey: string | null = null
    let prevTitleChangedTo: string | null = null

    for (const block of blocks) {
        if (block.kind !== 'agent-event') {
            result.push(block)
            prevEventKey = null
            prevTitleChangedTo = null
            continue
        }

        const event = block.event as { type: string; [key: string]: unknown }
        if (event.type === 'title-changed' && typeof event.title === 'string') {
            const title = event.title.trim()
            const key = `title-changed:${title}`
            if (key === prevEventKey) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = title
            continue
        }

        if (event.type === 'message' && typeof event.message === 'string') {
            const message = event.message.trim()
            const key = `message:${message}`
            if (key === prevEventKey) {
                continue
            }
            if (prevTitleChangedTo && message === prevTitleChangedTo) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        if (event.type === 'error' && typeof event.message === 'string') {
            const message = event.message.trim()
            const key = `error:${message}`
            if (key === prevEventKey) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        let key: string
        try {
            key = `event:${JSON.stringify(event)}`
        } catch {
            key = `event:${String(event.type)}`
        }

        if (key === prevEventKey) {
            continue
        }

        result.push(block)
        prevEventKey = key
        prevTitleChangedTo = null
    }

    return result
}

/**
 * Fold consecutive api-error events, keeping only the latest state.
 */
export function foldApiErrorEvents(blocks: ChatBlock[]): ChatBlock[] {
    const result: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'agent-event') {
            result.push(block)
            continue
        }

        const event = block.event as { type: string }
        if (event.type !== 'api-error') {
            result.push(block)
            continue
        }

        const prev = result[result.length - 1] as AgentEventBlock | undefined
        if (prev?.kind === 'agent-event' && (prev.event as { type: string }).type === 'api-error') {
            result[result.length - 1] = block
        } else {
            result.push(block)
        }
    }

    return result
}

export function isLegacyCompactionStartEvent(event: AgentEvent): boolean {
    return event.type === 'message'
        && typeof event.message === 'string'
        && /^Compacting (?:conversation|context)\.{0,3}$/i.test(event.message.trim())
}

export function isLegacyCompactionEndEvent(event: AgentEvent): boolean {
    return event.type === 'message'
        && typeof event.message === 'string'
        && /^(?:Conversation|Context) compacted\.?$/i.test(event.message.trim())
}

/**
 * Fold paired compaction lifecycle events (`started` -> `finished`, or
 * `"Compacting conversation..."` -> `"Conversation compacted"`) in place so
 * the in-progress compaction status row transitions into its final state
 * instead of leaving two stacked compaction pills.
 */
export function foldCompactionEvents<T extends { kind: string; id: string; event?: AgentEvent }>(
    blocks: readonly T[]
): T[] {
    const result: T[] = []
    let openOmpCompactionIndex = -1
    let openLegacyCompactionIndex = -1

    for (const block of blocks) {
        if (block.kind !== 'agent-event' || !block.event) {
            result.push(block)
            continue
        }
        const event = block.event
        if (event.type === 'omp-compaction') {
            const phase = 'phase' in event ? event.phase : undefined
            const outcome = 'outcome' in event ? event.outcome : undefined
            if (phase === 'started') {
                if (openOmpCompactionIndex >= 0) {
                    const prev = result[openOmpCompactionIndex]!
                    result[openOmpCompactionIndex] = { ...block, id: prev.id }
                } else {
                    openOmpCompactionIndex = result.length
                    result.push(block)
                }
                continue
            }
            if (phase === 'finished') {
                if (outcome === 'skipped') {
                    if (openOmpCompactionIndex >= 0) {
                        result.splice(openOmpCompactionIndex, 1)
                        if (openLegacyCompactionIndex > openOmpCompactionIndex) {
                            openLegacyCompactionIndex -= 1
                        }
                        openOmpCompactionIndex = -1
                    }
                    continue
                }
                if (openOmpCompactionIndex >= 0) {
                    const prev = result[openOmpCompactionIndex]!
                    result[openOmpCompactionIndex] = { ...block, id: prev.id }
                    openOmpCompactionIndex = -1
                } else {
                    result.push(block)
                }
                continue
            }
        }

        if (isLegacyCompactionStartEvent(event)) {
            if (openLegacyCompactionIndex >= 0) {
                const prev = result[openLegacyCompactionIndex]!
                result[openLegacyCompactionIndex] = { ...block, id: prev.id }
            } else {
                openLegacyCompactionIndex = result.length
                result.push(block)
            }
            continue
        }

        if (isLegacyCompactionEndEvent(event)) {
            if (openLegacyCompactionIndex >= 0) {
                const prev = result[openLegacyCompactionIndex]!
                result[openLegacyCompactionIndex] = { ...block, id: prev.id }
                openLegacyCompactionIndex = -1
            } else {
                result.push(block)
            }
            continue
        }

        result.push(block)
    }

    return result
}
