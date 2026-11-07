import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { isDisplayedInQueueBar, isQueuedForInvocation, mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        id: partial.id,
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        steered: partial.steered,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }
}

describe('mergeMessages', () => {
    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })

    it('does not inherit optimistic "queued" onto an already-invoked server echo (steered message)', () => {
        const optimistic = userMessage({ id: 'local-1', localId: 'local-1', invokedAt: null, status: 'queued' })
        const serverInvoked = userMessage({ id: 'server-1', localId: 'local-1', invokedAt: 2_000 })

        const merged = mergeMessages([optimistic], [serverInvoked])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(2_000)
        expect(merged[0]?.status).not.toBe('queued')
    })

    it('keeps "queued" while the message is not yet invoked (normal queue mode)', () => {
        const optimistic = userMessage({ id: 'local-2', localId: 'local-2', invokedAt: null, status: 'queued' })
        const serverPending = userMessage({ id: 'server-2', localId: 'local-2', invokedAt: null })

        const merged = mergeMessages([optimistic], [serverPending])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).toBe('queued')
    })

    it('carries the live "steered" marker from the optimistic row onto the server echo', () => {
        const optimisticSteered = userMessage({ id: 'local-s', localId: 'local-s', invokedAt: 4_000, status: 'sent', steered: true })
        const serverEcho = userMessage({ id: 'server-s', localId: 'local-s', invokedAt: 4_000 })

        const merged = mergeMessages([optimisticSteered], [serverEcho])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('preserves "steered" across a refetch that omits it', () => {
        const existing = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000, steered: true })]
        const incoming = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000 })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('normalizes a stuck queued status on an invoked message', () => {
        const inconsistent = userMessage({ id: 'server-3', localId: 'local-3', invokedAt: 3_000, status: 'queued' })

        const merged = mergeMessages([inconsistent], [])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).not.toBe('queued')
    })

    it('preserves status "sent" and queuedWhileSending when an uninvoked server echo arrives', () => {
        const optimisticIdle = userMessage({ id: 'local-idle', localId: 'local-idle', invokedAt: null, status: 'sent' })
        const serverIdle = userMessage({ id: 'server-idle', localId: 'local-idle', invokedAt: null })
        const mergedIdle = mergeMessages([optimisticIdle], [serverIdle])
        expect(mergedIdle[0]?.status).toBe('sent')
        expect(isDisplayedInQueueBar(mergedIdle[0]!)).toBe(false)

        const optimisticQueued = {
            ...userMessage({ id: 'local-q', localId: 'local-q', invokedAt: null, status: 'sending' }),
            queuedWhileSending: true,
        }
        const serverQueued = userMessage({ id: 'server-q', localId: 'local-q', invokedAt: null })
        const mergedQueued = mergeMessages([optimisticQueued], [serverQueued])
        expect(mergedQueued[0]?.queuedWhileSending).toBe(true)
        expect(isDisplayedInQueueBar(mergedQueued[0]!)).toBe(true)
    })
})

describe('isDisplayedInQueueBar', () => {
    it('routes immediate idle sends to the main timeline while keeping them queued for invocation retention', () => {
        const sendingIdle = userMessage({ id: 'local-1', invokedAt: null, status: 'sending' })
        expect(isQueuedForInvocation(sendingIdle)).toBe(true)
        expect(isDisplayedInQueueBar(sendingIdle)).toBe(false)

        const sentIdle = userMessage({ id: 'local-1', invokedAt: null, status: 'sent' })
        expect(isQueuedForInvocation(sentIdle)).toBe(true)
        expect(isDisplayedInQueueBar(sentIdle)).toBe(false)
    })

    it('routes thinking-session, explicitly queued, scheduled, and server-uninvoked messages to the queue bar', () => {
        const sendingWhileBusy: DecryptedMessage = {
            ...userMessage({ id: 'local-2', invokedAt: null, status: 'sending' }),
            queuedWhileSending: true,
        }
        expect(isDisplayedInQueueBar(sendingWhileBusy)).toBe(true)

        const queued = userMessage({ id: 'local-3', invokedAt: null, status: 'queued' })
        expect(isDisplayedInQueueBar(queued)).toBe(true)

        const serverPending = userMessage({ id: 'server-4', invokedAt: null, status: undefined })
        expect(isDisplayedInQueueBar(serverPending)).toBe(true)

        const scheduled: DecryptedMessage = {
            ...userMessage({ id: 'local-5', invokedAt: null, status: 'sent' }),
            scheduledAt: 1_700_005_000_000,
        }
        expect(isDisplayedInQueueBar(scheduled)).toBe(true)
    })
})
