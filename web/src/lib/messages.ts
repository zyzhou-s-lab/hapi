import type { DecryptedMessage } from '@/types/api'
import { randomId } from '@/lib/randomId'

export function makeClientSideId(prefix: string): string {
    return `${prefix}-${randomId()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

/** A user message that is still waiting for the CLI ack (messages-consumed).
 *  Strict null on `invokedAt` so a pre-V8 hub response that omits the field
 *  (`undefined`) is treated as already-invoked; only optimistic / V8-loaded
 *  rows that explicitly carry `invokedAt: null` are queued. `failed` rows are
 *  not queued either — they're surfaced as send errors, not pending work. */
export function isQueuedForInvocation(msg: DecryptedMessage): boolean {
    return isUserMessage(msg) && msg.invokedAt === null && msg.status !== 'failed'
}

/** Whether an uninvoked user message belongs in QueuedMessagesBar above the
 *  composer rather than the main chat timeline (`visibleMessages`). Immediate
 *  sends in an idle session (`status === 'sending'` without `queuedWhileSending`,
 *  or `status === 'sent'`) enter the main chat timeline at 0ms instead of
 *  bouncing through the queue bar while awaiting `messages-consumed`. */
export function isDisplayedInQueueBar(msg: DecryptedMessage): boolean {
    if (!isQueuedForInvocation(msg)) return false
    if (msg.scheduledAt != null) return true
    if (msg.status === 'sent') return false
    if (msg.status === 'sending') return msg.queuedWhileSending === true
    return true
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aTime = a.invokedAt ?? a.createdAt
    const bTime = b.invokedAt ?? b.createdAt

    if (aTime !== bTime) {
        return aTime - bTime
    }

    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }
    return a.id.localeCompare(b.id)
}

// Invariant: a message the CLI has consumed (invokedAt set) is delivered, not
// queued. A message delivered immediately — e.g. steered into the active turn —
// can carry a stale optimistic 'queued' status while its invokedAt is already
// set; normalize so the queued clock never lingers on a delivered message.
function normalizeSingleMessageStatus(msg: DecryptedMessage): DecryptedMessage {
    return msg.status === 'queued' && msg.invokedAt != null
        ? { ...msg, status: 'sent' as DecryptedMessage['status'] }
        : msg
}

function clearStaleQueuedStatus(list: DecryptedMessage[]): DecryptedMessage[] {
    return list.map(normalizeSingleMessageStatus)
}

function mergeExistingAndIncomingMessage(
    existingItem: DecryptedMessage,
    msg: DecryptedMessage
): DecryptedMessage {
    // Preserve client-only signals the incoming (server) copy can't carry:
    // a late ack timestamp and the live 'steered' marker (not persisted).
    const preserved: Partial<DecryptedMessage> = {}
    if (existingItem.invokedAt != null && msg.invokedAt == null) {
        preserved.invokedAt = existingItem.invokedAt
    }
    if (existingItem.steered && !msg.steered) {
        preserved.steered = true
    }
    const effectiveInvokedAt = preserved.invokedAt ?? msg.invokedAt
    if (existingItem.status && !msg.status) {
        if (existingItem.status !== 'queued' || effectiveInvokedAt == null) {
            preserved.status = existingItem.status
        }
    }
    if (existingItem.queuedWhileSending && !msg.queuedWhileSending && effectiveInvokedAt == null) {
        preserved.queuedWhileSending = true
    }
    return Object.keys(preserved).length > 0 ? { ...msg, ...preserved } : msg
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return clearStaleQueuedStatus([...incoming]).sort(compareMessages)
    }
    if (incoming.length === 0) {
        return clearStaleQueuedStatus([...existing]).sort(compareMessages)
    }

    if (incoming.length === 1) {
        const nextRaw = incoming[0]!
        let matchIdx = -1
        let canUseFastPath = true
        for (let i = 0; i < existing.length; i++) {
            const cur = existing[i]!
            if (isOptimisticMessage(cur) || (cur.status === 'queued' && cur.invokedAt != null)) {
                canUseFastPath = false
                break
            }
            if (i > 0 && compareMessages(existing[i - 1]!, cur) >= 0) {
                canUseFastPath = false
                break
            }
            if (cur.id === nextRaw.id) {
                matchIdx = i
            }
        }
        if (canUseFastPath) {
            if (matchIdx >= 0) {
                const mergedItem = normalizeSingleMessageStatus(
                    mergeExistingAndIncomingMessage(existing[matchIdx]!, nextRaw)
                )
                const prevOk = matchIdx === 0 || compareMessages(existing[matchIdx - 1]!, mergedItem) < 0
                const nextOk = matchIdx === existing.length - 1 || compareMessages(mergedItem, existing[matchIdx + 1]!) < 0
                if (prevOk && nextOk) {
                    if (mergedItem === existing[matchIdx]) {
                        return existing
                    }
                    const nextList = existing.slice()
                    nextList[matchIdx] = mergedItem
                    return nextList
                }
            } else if (!isOptimisticMessage(nextRaw)) {
                const normalizedNext = normalizeSingleMessageStatus(nextRaw)
                const last = existing[existing.length - 1]!
                if (compareMessages(last, normalizedNext) < 0) {
                    return [...existing, normalizedNext]
                }
            }
        }
    }
    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        const existingItem = byId.get(msg.id)
        if (existingItem) {
            byId.set(msg.id, mergeExistingAndIncomingMessage(existingItem, msg))
        } else {
            byId.set(msg.id, msg)
        }
    }

    let merged = Array.from(byId.values())

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    // Preserve client-side status (e.g. 'queued') and invokedAt on the replacing server message.
    if (incomingStoredLocalIds.size > 0) {
        const optimisticStatusByLocalId = new Map<string, DecryptedMessage['status']>()
        const optimisticInvokedAtByLocalId = new Map<string, number | null | undefined>()
        const optimisticSteeredByLocalId = new Map<string, boolean>()
        const optimisticQueuedWhileSendingByLocalId = new Map<string, boolean>()
        for (const msg of merged) {
            if (msg.localId && isOptimisticMessage(msg) && incomingStoredLocalIds.has(msg.localId)) {
                if (msg.status) {
                    optimisticStatusByLocalId.set(msg.localId, msg.status)
                }
                if (msg.invokedAt !== undefined) {
                    optimisticInvokedAtByLocalId.set(msg.localId, msg.invokedAt)
                }
                if (msg.steered) {
                    optimisticSteeredByLocalId.set(msg.localId, true)
                }
                if (msg.queuedWhileSending) {
                    optimisticQueuedWhileSendingByLocalId.set(msg.localId, true)
                }
            }
        }
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
        if (optimisticStatusByLocalId.size > 0 || optimisticInvokedAtByLocalId.size > 0 || optimisticSteeredByLocalId.size > 0 || optimisticQueuedWhileSendingByLocalId.size > 0) {
            merged = merged.map((msg) => {
                if (!msg.localId) return msg
                const update: Partial<DecryptedMessage> = {}
                if (optimisticStatusByLocalId.has(msg.localId) && !msg.status) {
                    const optimisticStatus = optimisticStatusByLocalId.get(msg.localId)
                    // Don't carry an optimistic 'queued' status onto a server message
                    // the CLI has already consumed (invokedAt set). This happens when a
                    // message is delivered immediately — e.g. steered into the active
                    // turn — so its server echo arrives pre-invoked; inheriting 'queued'
                    // would pin the queued clock on an already-delivered message.
                    if (optimisticStatus !== 'queued' || msg.invokedAt == null) {
                        update.status = optimisticStatus
                    }
                }
                if (optimisticInvokedAtByLocalId.has(msg.localId) && msg.invokedAt == null) {
                    const optimisticInvokedAt = optimisticInvokedAtByLocalId.get(msg.localId)
                    if (optimisticInvokedAt != null) {
                        update.invokedAt = optimisticInvokedAt
                    }
                }
                // The 'steered' marker is live-only (the hub never persists it), so
                // carry it from the optimistic row onto the replacing server echo —
                // otherwise the ↳ Steered badge vanishes the moment the echo lands.
                if (optimisticSteeredByLocalId.has(msg.localId) && !msg.steered) {
                    update.steered = true
                }
                if (optimisticQueuedWhileSendingByLocalId.has(msg.localId) && !msg.queuedWhileSending && (update.invokedAt ?? msg.invokedAt) == null) {
                    update.queuedWhileSending = true
                }
                if (Object.keys(update).length > 0) {
                    return { ...msg, ...update }
                }
                return msg
            })
        }
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            // Compare by the position key (invokedAt ?? createdAt). A late ack can
            // attach `invokedAt` long after `createdAt`, so the optimistic copy and
            // the server echo end up at the same byPosition slot — using
            // `createdAt` alone misses that match and renders both as duplicates.
            const optimisticTime = optimistic.invokedAt ?? optimistic.createdAt
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs((m.invokedAt ?? m.createdAt) - optimisticTime) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    const normalized = clearStaleQueuedStatus(result)
    normalized.sort(compareMessages)
    return normalized
}
