import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { getMessageStreamId } from '@hapi/protocol/messages'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

describe('cancelQueuedMessage', () => {
    it('happy path: deletes queued message, returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-happy')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-1')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-1')
        }

        // Row should be gone from uninvoked list
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('already-invoked: returns status=invoked with full message row, row stays in DB', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-already-invoked')
        const content = { role: 'user', content: { type: 'text', text: 'hello' } }
        const msg = store.messages.addMessage(session.id, content, 'lid-2')

        const invokedAt = Date.now()
        // Simulate CLI invoke ack
        store.messages.markMessagesInvoked(session.id, ['lid-2'], invokedAt)

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('invoked')

        // Must include the invoked row so the web client can restore authoritative state
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe('lid-2')
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists (with invoked_at set)
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })

    it('cancel × 2 idempotent: second call returns status=cancelled with localId=null (row gone)', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-idempotent')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-3')

        const first = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe('lid-3')
        }

        const second = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('non-existent messageId: returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-nonexistent')

        const result = store.messages.cancelQueuedMessage(session.id, 'nonexistent-id')
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }
    })

    it('wrong sessionId: returns status=cancelled with localId=null, message from other session untouched', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'cancel-session-a')
        const sessionB = makeSession(store, 'cancel-session-b')
        const msg = store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-A')

        const result = store.messages.cancelQueuedMessage(sessionB.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }

        // Original message still exists
        const remaining = store.messages.getUninvokedLocalMessages(sessionA.id)
        expect(remaining).toHaveLength(1)
    })

    it('cancelled localId is propagated from the deleted row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-localid-propagate')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-propagate')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-propagate')
        }
    })

    it('cancel by localId before server echo: localId match returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid')
        // Simulate the optimistic row: server has stored it with local_id but web client
        // still holds msg.id === localId (server echo not yet received).
        const localId = 'local:pre-echo-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        // The web client passes localId as messageId (before server echo replaces it)
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe(localId)
        }

        // Row should be gone
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    it('cancel by localId × 2 idempotent: second call returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-idempotent')
        const localId = 'local:idem-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const first = store.messages.cancelQueuedMessage(session.id, localId)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe(localId)
        }

        // Second cancel by the same localId — row is already gone
        const second = store.messages.cancelQueuedMessage(session.id, localId)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    it('cancel by localId when invoked: returns status=invoked with message row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-invoked')
        const localId = 'local:invoked-id'
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const invokedAt = Date.now()
        store.messages.markMessagesInvoked(session.id, [localId], invokedAt)

        // Web client passes localId as messageId — should detect invoked_at IS NOT NULL
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('invoked')
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe(localId)
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })
})

describe('recordMessagesConsumed', () => {
    it('rolls back the invocation transition when the session namespace cannot be verified', () => {
        const store = makeStore()
        const session = makeSession(store, 'consumed-rollback-wrong-namespace')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'local-rollback')
        const originalUpdatedAt = store.sessions.getSession(session.id)?.updatedAt

        expect(() => store.recordMessagesConsumed(session.id, ['local-rollback'], 2_000, 'other-namespace'))
            .toThrow('session not found after messages-consumed transition')
        expect(store.messages.getLocalMessageStates(session.id, ['local-rollback']))
            .toEqual([{ localId: 'local-rollback', invokedAt: null }])
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(originalUpdatedAt)
    })
})

describe('position pagination and structural epochs', () => {
    it('returns rows strictly after a cursor and respects an inclusive snapshot head', () => {
        const store = makeStore()
        const session = makeSession(store, 'position-after')
        const first = store.messages.addMessage(session.id, { text: 'first' })
        const second = store.messages.addMessage(session.id, { text: 'second' })
        const third = store.messages.addMessage(session.id, { text: 'third' })
        store.messages.addMessage(session.id, { text: 'fourth' })

        const rows = store.messages.getMessagesAfterPosition(
            session.id,
            10,
            { at: first.invokedAt ?? first.createdAt, seq: first.seq },
            { at: third.invokedAt ?? third.createdAt, seq: third.seq }
        )

        expect(rows.map((message) => message.id)).toEqual([second.id, third.id])
    })

    it('reports the newest composite position', () => {
        const store = makeStore()
        const session = makeSession(store, 'position-head')
        const first = store.messages.addMessage(session.id, { text: 'first' })
        const second = store.messages.addMessage(session.id, { text: 'second' })

        expect(store.messages.getNewestMessagePosition(session.id)).toEqual({
            at: second.invokedAt ?? second.createdAt,
            seq: second.seq
        })
        expect(first.seq).toBeLessThan(second.seq)
    })

    it('bumps both epochs when session history is merged', () => {
        const store = makeStore()
        const source = makeSession(store, 'epoch-merge-source')
        const target = makeSession(store, 'epoch-merge-target')
        store.messages.addMessage(source.id, { text: 'source' })
        store.messages.addMessage(target.id, { text: 'target' })

        const result = store.messages.mergeSessionMessages(source.id, target.id)

        expect(result.moved).toBe(1)
        expect(store.messages.getMessageEpoch(source.id)).toBe(1)
        expect(store.messages.getMessageEpoch(target.id)).toBe(1)
    })

    it('clamps future client timestamps to hub receive time', () => {
        const store = makeStore()
        const session = makeSession(store, 'future-client-clock')
        const before = Date.now()

        const message = store.messages.addMessage(
            session.id,
            { text: 'future clock' },
            undefined,
            undefined,
            before + 60_000,
        )

        expect(message.createdAt).toBeGreaterThanOrEqual(before)
        expect(message.createdAt).toBeLessThanOrEqual(Date.now())
        expect(message.invokedAt).toBe(message.createdAt)
    })

    it('bumps the epoch when a newly inserted message is backdated behind the cached head', () => {
        const store = makeStore()
        const session = makeSession(store, 'epoch-backdated-insert')
        const head = store.messages.addMessage(session.id, { text: 'head' })
        const headPosition = { at: head.invokedAt ?? head.createdAt, seq: head.seq }

        const backdated = store.messages.addMessage(
            session.id,
            { text: 'backdated' },
            undefined,
            undefined,
            headPosition.at - 1_000,
        )

        expect(backdated.seq).toBeGreaterThan(head.seq)
        expect(store.messages.getMessagesAfterPosition(session.id, 10, headPosition)).toEqual([])
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('bumps the target epoch when a copied message lands behind the cached head', () => {
        const store = makeStore()
        const target = makeSession(store, 'epoch-copy-target')
        const head = store.messages.addMessage(target.id, { text: 'head' })
        const headPosition = {
            at: head.invokedAt ?? head.createdAt,
            seq: head.seq
        }

        const copied = store.messages.copyMessageToSession(target.id, {
            content: { text: 'historical' },
            createdAt: headPosition.at - 1_000,
            localId: null,
            invokedAt: headPosition.at - 1_000,
            scheduledAt: null
        })

        expect(copied.seq).toBeGreaterThan(head.seq)
        expect(store.messages.getMessagesAfterPosition(target.id, 10, headPosition)).toEqual([])
        expect(store.messages.getMessageEpoch(target.id)).toBe(1)
    })
})

describe('addMessage: scheduledAt invariants', () => {
    it('rejects scheduledAt without a localId — would silently invoke immediately', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-invariant')
        const future = Date.now() + 60_000

        expect(() =>
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'orphan scheduled' } },
                undefined,
                future
            )
        ).toThrow(/scheduledAt requires a localId/)
    })

    it('accepts scheduledAt when paired with a localId and keeps invoked_at NULL', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-ok')
        const future = Date.now() + 60_000

        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued for later' } },
            'lid-sched',
            future
        )

        expect(msg.scheduledAt).toBe(future)
        expect(msg.invokedAt).toBeNull()
    })
})

describe('getDeliverableMessagesAfter: CLI backfill excludes future-scheduled rows', () => {
    it('omits rows whose scheduled_at > now (would otherwise be replayed early on reconnect)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-future-sched')
        const now = Date.now()
        const future = now + 60_000
        const past = now - 60_000

        const immediate = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'lid-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future-scheduled' } },
            'lid-future',
            future
        )
        const matureSched = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature-scheduled' } },
            'lid-mature',
            past
        )

        const delivered = store.messages.getDeliverableMessagesAfter(session.id, 0, now)
        const ids = delivered.map((m) => m.id)
        expect(ids).toContain(immediate.id)
        expect(ids).toContain(matureSched.id)
        expect(ids).not.toContain('lid-future')
        const localIds = delivered.map((m) => m.localId)
        expect(localIds).not.toContain('lid-future')
    })

    it('returns the row once now advances past scheduled_at (release boundary)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-release-boundary')
        const fireAt = Date.now() - 60_000

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'boundary' } },
            'lid-bnd',
            fireAt
        )

        const before = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt - 1)
        expect(before.find((m) => m.localId === 'lid-bnd')).toBeUndefined()

        const exact = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt)
        expect(exact.find((m) => m.localId === 'lid-bnd')).toBeDefined()
    })

    it('respects afterSeq alongside the scheduled_at filter (2-axis interaction)', () => {
        // Verifies the seq cursor and the scheduled-at filter compose correctly:
        // a row that satisfies one axis but fails the other must be excluded.
        const store = makeStore()
        const session = makeSession(store, 'backfill-2axis')
        const now = Date.now()

        const m1 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'first' } },
            'lid-1'
        )
        const m2 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'second' } },
            'lid-2'
        )

        // afterSeq = m1.seq → only m2 should be returned.
        const onlyM2 = store.messages.getDeliverableMessagesAfter(session.id, m1.seq, now)
        expect(onlyM2.map((m) => m.id)).toEqual([m2.id])

        // afterSeq = m2.seq → nothing (cursor at the end).
        const empty = store.messages.getDeliverableMessagesAfter(session.id, m2.seq, now)
        expect(empty).toHaveLength(0)
    })
})

describe('countFutureScheduledLocalMessages', () => {
    it('counts only future scheduled uninvoked local messages', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-count')
        const now = Date.now()

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate queued' } },
            'local-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future scheduled' } },
            'local-future',
            now + 60_000
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature scheduled' } },
            'local-mature',
            now - 1
        )

        expect(store.messages.countFutureScheduledLocalMessages(session.id, now)).toBe(1)
    })

    it('batch query returns counts keyed by session id', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'sched-batch-a')
        const sessionB = makeSession(store, 'sched-batch-b')
        const now = Date.now()

        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a1' } },
            'a-1',
            now + 60_000
        )
        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a2' } },
            'a-2',
            now + 120_000
        )
        store.messages.addMessage(
            sessionB.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'b-1'
        )

        const counts = store.messages.countFutureScheduledBySessionIds([sessionA.id, sessionB.id], now)
        expect(counts.get(sessionA.id)).toBe(2)
        expect(counts.get(sessionB.id)).toBeUndefined()

        const nextAt = store.messages.minFutureScheduledAtBySessionIds([sessionA.id, sessionB.id], now)
        expect(nextAt.get(sessionA.id)).toBe(now + 60_000)
        expect(nextAt.get(sessionB.id)).toBeUndefined()
    })
})

describe('moveUninvokedScheduledMessages', () => {
    it('atomically moves only pending scheduled rows to the replacement session', () => {
        const store = makeStore()
        const source = makeSession(store, 'scheduled-source')
        const replacement = makeSession(store, 'scheduled-replacement')
        const now = Date.now()
        const scheduled = store.messages.addMessage(source.id, { text: 'later' }, 'scheduled-local', now + 60_000)
        store.messages.addMessage(source.id, { text: 'ordinary queued' }, 'ordinary-local')

        expect(store.messages.moveUninvokedScheduledMessages(source.id, replacement.id)).toBe(1)
        expect(store.messages.getAllMessages(source.id).map((message) => message.id)).not.toContain(scheduled.id)
        expect(store.messages.getAllMessages(replacement.id)).toEqual([
            expect.objectContaining({ id: scheduled.id, localId: 'scheduled-local', scheduledAt: now + 60_000, invokedAt: null })
        ])
        expect(store.messages.getUninvokedLocalMessages(source.id)).toEqual([
            expect.objectContaining({ localId: 'ordinary-local', scheduledAt: null })
        ])
    })
})

describe('markUninvokedImmediateMessages', () => {
    it('settles immediate queued rows while preserving scheduled rows for clear transfer', () => {
        const store = makeStore()
        const source = makeSession(store, 'clear-source-immediate')
        const invokedAt = Date.now()
        store.messages.addMessage(source.id, { text: 'immediate' }, 'immediate-local')
        store.messages.addMessage(source.id, { text: 'scheduled' }, 'scheduled-local', invokedAt + 60_000)

        expect(store.messages.markUninvokedImmediateMessages(source.id, invokedAt)).toEqual(['immediate-local'])
        expect(store.messages.getAllMessages(source.id)).toEqual(expect.arrayContaining([
            expect.objectContaining({ localId: 'immediate-local', invokedAt }),
            expect.objectContaining({ localId: 'scheduled-local', invokedAt: null })
        ]))
    })
})

describe('content codec integration', () => {
    it('stores large agent content compressed and returns it truncated on read', () => {
        const store = makeStore()
        const session = makeSession(store, 'codec-agent')
        const stdout = 'line\n'.repeat(60_000) // ~300KB, above the truncate limit
        const content = {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c1', output: { stdout } } }
        }

        const added = store.messages.addMessage(session.id, content)
        const read = store.messages.getMessages(session.id, 10)
        expect(read).toHaveLength(1)

        const readContent = read[0]!.content as typeof content
        expect(readContent.content.data.output.stdout.length).toBeLessThan(stdout.length)
        expect(readContent.content.data.output.stdout).toContain('[hapi: truncated')
        expect(readContent.content.data.callId).toBe('c1')
        // addMessage's return value matches what a later read sees (SSE broadcast uses it)
        expect(added.content).toEqual(read[0]!.content)
    })

    it('round-trips large queued user prompts verbatim (delivery path must not truncate)', () => {
        const store = makeStore()
        const session = makeSession(store, 'codec-user')
        const text = 'prompt '.repeat(30_000) // ~210KB user paste
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text } },
            'lid-big',
            Date.now() + 60_000
        )

        const scheduled = store.messages.getMatureScheduledMessages(Date.now() + 120_000)
        expect(scheduled).toHaveLength(1)
        const delivered = scheduled[0]!.content as { content: { text: string } }
        expect(delivered.content.text).toBe(text)
    })

    it('requeues an indeterminate delivery only on explicit request', () => {
        const store = makeStore()
        const session = makeSession(store, 'requeue-indeterminate')
        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'retry me' } },
            'lid-retry'
        )
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'dispatching')).toBe(1)
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'indeterminate')).toBe(1)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        const claimed = store.messages.claimIndeterminateMessage(session.id, msg.id)
        expect(claimed).toMatchObject({ id: msg.id, invokedAt: null, deliveryState: 'indeterminate' })
        expect(store.messages.claimIndeterminateMessage(session.id, msg.id)).toBeNull()
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'queued')).toBe(1)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(1)
    })

    it('holds indeterminate delivery out of replay without stamping invoked_at', () => {
        const store = makeStore()
        const session = makeSession(store, 'indeterminate')
        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'uncertain' } },
            'lid-uncertain'
        )

        expect(store.messages.markMessagesIndeterminate(session.id, ['lid-uncertain'])).toBe(1)
        expect(store.messages.markMessagesIndeterminate(session.id, ['lid-uncertain'])).toBe(0)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        expect(store.messages.getImmediateQueuedLocalMessages(session.id)).toHaveLength(0)
        expect(store.messages.getUninvokedLocalMessages(session.id)[0]).toMatchObject({
            id: msg.id,
            deliveryState: 'indeterminate',
            invokedAt: null
        })
        expect(store.messages.lookupQueuedMessage(session.id, msg.id)).toEqual({
            status: 'indeterminate',
            localId: 'lid-uncertain',
            resolvedId: msg.id,
            scheduledAt: null
        })

        const invokedAt = Date.now()
        expect(store.messages.markMessagesInvoked(session.id, ['lid-uncertain'], invokedAt)).toBe(1)
        expect(store.messages.getMessages(session.id)[0]).toMatchObject({ invokedAt })
    })
})

describe('message stream snapshots', () => {
    function snapshot(kind: 'reasoning' | 'message' | 'assistant', text: string, live: boolean, id = 'shared') {
        return {
            role: 'agent',
            content: {
                type: kind === 'assistant' ? 'output' : AGENT_MESSAGE_PAYLOAD_TYPE,
                data: kind === 'assistant'
                    ? { type: kind, uuid: id, streamSnapshot: true, live, message: { content: [{ type: 'text', text }] } }
                    : { type: kind, id, streamSnapshot: true, live, message: text }
            }
        }
    }

    it('does not invalidate usage scans on live replacement but does on final correction', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'stream-epochs')
            for (let i = 0; i < 450; i++) {
                store.messages.addMessage(session.id, snapshot('assistant', `partial ${i}`, true), undefined, undefined, 1000)
            }
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            store.messages.addMessage(session.id, snapshot('assistant', 'final', false), undefined, undefined, 1000)
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            store.messages.addMessage(session.id, snapshot('assistant', '', false), undefined, undefined, 1000)
            expect(store.messages.getMessageEpoch(session.id)).toBe(1)
            store.messages.addMessage(session.id, snapshot('assistant', 'late', true), undefined, undefined, 1000)
            expect(store.messages.getMessageEpoch(session.id)).toBe(1)
        } finally { store.close() }
    })

    it('keeps Pi text snapshots live so intermediates do not bump the epoch', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'pi-text-stream')
            const pi = (text: string, live: boolean) => ({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        id: 'pi-nonce-turn-1-message-1-text-0',
                        streamSnapshot: true,
                        ...(live ? { live: true } : {}),
                        message: text
                    }
                },
                meta: { sentFrom: 'cli' }
            })
            store.messages.addMessage(session.id, pi('hel', true))
            const grown = store.messages.addMessage(session.id, pi('hello', true))
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            expect(store.messages.getAllMessages(session.id)).toEqual([grown])
            const replay = store.messages.addMessage(session.id, pi('hello', true))
            expect(replay.id).toBe(grown.id)
            expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            const settled = store.messages.addMessage(session.id, pi('hello!', false))
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
            expect(store.messages.getAllMessages(session.id)).toEqual([settled])
            expect(settled.content).toEqual(pi('hello!', false))
            const sameFinal = store.messages.addMessage(session.id, pi('hello!', false))
            expect(sameFinal.id).toBe(settled.id)
            expect(store.messages.getMessageEpoch(session.id)).toBe(0)
        } finally { store.close() }
    })

    it('keeps mixed kinds distinct and leaves ordinary messages independent', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'mixed-streams')
            for (const kind of ['reasoning', 'message', 'assistant'] as const) {
                store.messages.addMessage(session.id, snapshot(kind, 'partial', true))
                store.messages.addMessage(session.id, snapshot(kind, 'final', false))
            }
            const ordinary = { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', id: 'shared', message: 'ordinary' } } }
            store.messages.addMessage(session.id, ordinary)
            store.messages.addMessage(session.id, ordinary)
            expect(store.messages.getAllMessages(session.id).map(message => getMessageStreamId(message.content)))
                .toEqual(['codex:reasoning:shared', 'codex:message:shared', 'output:assistant:shared', null, null])
        } finally { store.close() }
    })

    it('accepts shorter and empty authoritative corrections and rejects late live replay', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'final-corrections')
            for (const kind of ['reasoning', 'message', 'assistant'] as const) {
                store.messages.addMessage(session.id, snapshot(kind, 'a long provisional answer', true))
                store.messages.addMessage(session.id, snapshot(kind, 'short', false))
                const empty = snapshot(kind, '', false)
                const settled = store.messages.addMessage(session.id, empty)
                for (let i = 0; i < 3; i++) {
                    expect(store.messages.addMessage(session.id, snapshot(kind, 'late', true)).id).toBe(settled.id)
                }
                expect(store.messages.getAllMessages(session.id).filter(message => getMessageStreamId(message.content) === getMessageStreamId(empty)))
                    .toEqual([settled])
            }
        } finally { store.close() }
    })

    it('retains context across over 400 updates and arbitrary intervening rows', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'long-stream')
            const context = store.messages.addMessage(session.id, { role: 'user', content: 'keep this context' })
            store.messages.addMessage(session.id, snapshot('assistant', 'old', true))
            for (let i = 0; i < 450; i++) store.messages.addMessage(session.id, { role: 'agent', content: { type: 'event', id: i } })
            for (let i = 0; i < 450; i++) store.messages.addMessage(session.id, snapshot('assistant', `update ${i}`, true))
            const final = store.messages.addMessage(session.id, snapshot('assistant', 'done', false))
            const all = store.messages.getAllMessages(session.id)
            expect(all).toHaveLength(452)
            expect(all[0]).toEqual(context)
            expect(all.filter(message => getMessageStreamId(message.content) !== null)).toEqual([final])
        } finally { store.close() }
    })

    it('paginates only canonical rows with stable timestamp and seq tie-break', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'stream-pagination')
            const timestamp = 1000
            store.messages.addMessage(session.id, snapshot('message', 'partial', true), undefined, undefined, timestamp)
            for (let i = 0; i < 70; i++) store.messages.addMessage(session.id, { context: i }, undefined, undefined, timestamp)
            const final = store.messages.addMessage(session.id, snapshot('message', 'done', false), undefined, undefined, timestamp)
            store.messages.addMessage(session.id, snapshot('message', 'late', true), undefined, undefined, timestamp)
            const pages = []
            let before: { at: number; seq: number } | undefined
            for (;;) {
                const page = store.messages.getMessagesByPosition(session.id, 13, before)
                if (page.length === 0) break
                pages.unshift(...page)
                const first = page[0]!
                before = { at: first.invokedAt ?? first.createdAt, seq: first.seq }
            }
            expect(pages).toEqual(store.messages.getAllMessages(session.id))
            expect(pages).toHaveLength(71)
            expect(pages.at(-1)).toEqual(final)
        } finally { store.close() }
    })

    it('prunes live rows exactly without crossing kind or session boundaries', () => {
        const store = makeStore()
        try {
            const mine = makeSession(store, 'mine')
            const theirs = makeSession(store, 'theirs')
            const live = store.messages.addMessage(mine.id, snapshot('reasoning', 'live', true))
            const otherKind = store.messages.addMessage(mine.id, snapshot('message', 'live', true))
            const otherSession = store.messages.addMessage(theirs.id, snapshot('reasoning', 'live', true))
            for (let i = 0; i < 450; i++) store.messages.addMessage(mine.id, { context: i })
            expect(store.messages.deleteLiveMessageSnapshots(mine.id, 'codex:reasoning:shared', live.id)).toBe(0)
            expect(store.messages.deleteLiveMessageSnapshots(mine.id, 'codex:reasoning:shared')).toBe(1)
            expect(store.messages.getAllMessages(mine.id)[0]).toEqual(otherKind)
            expect(store.messages.getAllMessages(theirs.id)).toEqual([otherSession])
            const final = store.messages.addMessage(mine.id, snapshot('reasoning', 'final', false))
            expect(store.messages.deleteLiveMessageSnapshots(mine.id, 'codex:reasoning:shared')).toBe(0)
            expect(store.messages.getAllMessages(mine.id).at(-1)).toEqual(final)
        } finally { store.close() }
    })

    it('canonicalizes imported, copied, merged, and replacement history', () => {
        const store = makeStore()
        try {
            const source = makeSession(store, 'source')
            const target = makeSession(store, 'target')
            const live = snapshot('assistant', 'live', true)
            const final = snapshot('assistant', 'final', false)
            const historyFinal = {
                ...final,
                meta: {
                    scope: 'history',
                    replayedHistory: true
                }
            }
            store.messages.addImportedMessage(source.id, live, 'import-live', 1)
            const settled = store.messages.addImportedMessage(source.id, final, 'import-final', 2).message
            expect(settled.content).toEqual(historyFinal)
            store.messages.copyMessageToSession(target.id, settled)
            store.messages.copyMessagesToSession(target.id, [{ ...settled, content: live, localId: null }])
            expect(store.messages.getAllMessages(target.id).map(message => message.content)).toEqual([historyFinal])
            store.messages.mergeSessionMessages(source.id, target.id)
            expect(store.messages.getAllMessages(target.id).map(message => message.content)).toEqual([historyFinal])
            store.messages.addMessage(target.id, { role: 'user', content: 'anchor' }, 'anchor')
            store.messages.truncateMessagesFromLocalId(target.id, 'anchor', [{ content: live }, { content: final }])
            expect(store.messages.getAllMessages(target.id).map(message => message.content)).toEqual([historyFinal])
        } finally { store.close() }
    })

    it('settles only owned live rows and rejects late live replay', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'finalize-live-streams')
            const turn1Live = {
                role: 'agent',
                meta: {
                    turnId: 'turn-1'
                },
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        id: 'turn1-msg',
                        turnId: 'turn-1',
                        phase: 'commentary',
                        streamSnapshot: true,
                        live: true,
                        message: 'streaming turn 1'
                    }
                }
            }
            const inserted = store.messages.addMessage(session.id, turn1Live)
            expect(inserted.lifecycleState).toBe('streaming')
            expect(store.sessions.setSessionLifecycle(session.id, 'turn-1', 'thinking', 'default')).toBe(true)

            const settledRows = store.messages.finalizeOpenLiveStreamsForSession(session.id, 'turn-1')
            expect(settledRows).toHaveLength(1)
            expect(settledRows[0]!.id).toBe(inserted.id)
            expect(settledRows[0]!.lifecycleState).toBe('settled')
            expect(settledRows[0]!.content).toEqual({
                ...turn1Live,
                content: {
                    ...turn1Live.content,
                    data: {
                        ...turn1Live.content.data,
                        live: false
                    }
                }
            })

            // Late liveSnapshot packet for the finalized stream must be rejected and return the settled row
            const lateLive = store.messages.addMessage(session.id, {
                ...turn1Live,
                content: {
                    ...turn1Live.content,
                    data: {
                        ...turn1Live.content.data,
                        message: 'late live packet'
                    }
                }
            })
            expect(lateLive.id).toBe(inserted.id)
            expect(lateLive.lifecycleState).toBe('settled')
            expect(lateLive.content).toEqual(settledRows[0]!.content)

        } finally { store.close() }
    })

    it('enforces canonical turn lifecycle ordering, source fencing, and durable receipt idempotency', () => {
        const store = makeStore()
        try {
            const session = makeSession(store, 'canonical-lifecycle')
            const bind1 = store.messages.bindSessionSource(session.id, 'src-1', 1000, 'default')
            expect(bind1).toMatchObject({
                sourceInstanceId: 'src-1',
                sourceGeneration: 1,
                fenced: false
            })

            const t1Start = {
                role: 'agent',
                meta: {
                    turnId: 'turn-1',
                    invocationId: 'inv-1',
                    scope: 'main' as const,
                    sourceInstanceId: 'src-1',
                    sourceGeneration: 1
                },
                content: {
                    id: 'evt-t1-start',
                    type: 'event',
                    data: {
                        type: 'turn-lifecycle' as const,
                        transition: 'started' as const,
                        turnId: 'turn-1',
                        invocationId: 'inv-1',
                        scope: 'main' as const,
                        sourceInstanceId: 'src-1',
                        sourceGeneration: 1,
                        eventId: 'evt-t1-start'
                    }
                }
            }
            const t1Started = store.messages.addLifecycleMessage(
                session.id,
                'default',
                t1Start,
                t1Start.content.data,
                'evt-t1-start',
                1010
            )
            expect(t1Started.transition.fenced).toBe(false)
            expect(store.sessions.getSession(session.id)).toMatchObject({
                activeTurnId: 'turn-1',
                lifecycleState: 'thinking'
            })

            const t1StreamLive = {
                role: 'agent',
                meta: {
                    turnId: 'turn-1',
                    invocationId: 'inv-1',
                    scope: 'main' as const,
                    sourceInstanceId: 'src-1',
                    sourceGeneration: 1
                },
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        id: 'shared-stream',
                        phase: 'commentary',
                        streamSnapshot: true,
                        live: true,
                        message: 'turn-1 partial'
                    }
                }
            }
            const t1LiveMsg = store.messages.addMessage(session.id, t1StreamLive, 'msg-t1-live-1', undefined, 1020)
            expect(t1LiveMsg.lifecycleState).toBe('streaming')

            // Subsequent live revision deletes msg-t1-live-1 row, but durable receipt remains matched
            const t1StreamLive2 = {
                ...t1StreamLive,
                content: {
                    ...t1StreamLive.content,
                    data: {
                        ...t1StreamLive.content.data,
                        message: 'turn-1 partial 2'
                    }
                }
            }
            store.messages.addMessage(session.id, t1StreamLive2, 'msg-t1-live-2', undefined, 1030)
            expect(store.messages.getMessageByLocalId(session.id, 'msg-t1-live-1')).toBeNull()
            expect(store.messages.checkSessionMessageReceipt(
                session.id,
                'msg-t1-live-1',
                store.messages.buildMessageReceiptInfo(t1StreamLive)
            )).toBe('matched')

            // Turn 2 starts on the same source and reuses the same provider stream id 'shared-stream'
            const t2Start = {
                role: 'agent',
                meta: {
                    turnId: 'turn-2',
                    invocationId: 'inv-2',
                    scope: 'main' as const,
                    sourceInstanceId: 'src-1',
                    sourceGeneration: 1
                },
                content: {
                    id: 'evt-t2-start',
                    type: 'event',
                    data: {
                        type: 'turn-lifecycle' as const,
                        transition: 'started' as const,
                        turnId: 'turn-2',
                        invocationId: 'inv-2',
                        scope: 'main' as const,
                        sourceInstanceId: 'src-1',
                        sourceGeneration: 1,
                        eventId: 'evt-t2-start'
                    }
                }
            }
            store.messages.addLifecycleMessage(session.id, 'default', t2Start, t2Start.content.data, 'evt-t2-start', 1040)
            const t2StreamLive = {
                role: 'agent',
                meta: {
                    turnId: 'turn-2',
                    invocationId: 'inv-2',
                    scope: 'main' as const,
                    sourceInstanceId: 'src-1',
                    sourceGeneration: 1
                },
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        id: 'shared-stream',
                        phase: 'commentary',
                        streamSnapshot: true,
                        live: true,
                        message: 'turn-2 live'
                    }
                }
            }
            const t2LiveMsg = store.messages.addMessage(session.id, t2StreamLive, 'msg-t2-live', undefined, 1050)
            expect(t2LiveMsg.id).not.toBe(t1LiveMsg.id)
            expect(store.sessions.getSession(session.id)?.activeTurnId).toBe('turn-2')

            // Late turn-1 final content and terminal event settle turn-1 without preempting turn-2
            const t1FinalContent = {
                ...t1StreamLive,
                content: {
                    ...t1StreamLive.content,
                    data: {
                        ...t1StreamLive.content.data,
                        live: false,
                        message: 'turn-1 final'
                    }
                }
            }
            store.messages.addMessage(session.id, t1FinalContent, 'msg-t1-final', undefined, 1060)
            const t1End = {
                role: 'agent',
                meta: {
                    turnId: 'turn-1',
                    invocationId: 'inv-1',
                    scope: 'main' as const,
                    sourceInstanceId: 'src-1',
                    sourceGeneration: 1
                },
                content: {
                    id: 'evt-t1-end',
                    type: 'event',
                    data: {
                        type: 'turn-lifecycle' as const,
                        transition: 'finished' as const,
                        outcome: 'completed' as const,
                        turnId: 'turn-1',
                        invocationId: 'inv-1',
                        scope: 'main' as const,
                        sourceInstanceId: 'src-1',
                        sourceGeneration: 1,
                        eventId: 'evt-t1-end'
                    }
                }
            }
            const t1Ended = store.messages.addLifecycleMessage(session.id, 'default', t1End, t1End.content.data, 'evt-t1-end', 1070)
            expect(t1Ended.transition.fenced).toBe(false)
            expect(store.sessions.getSession(session.id)).toMatchObject({
                activeTurnId: 'turn-2',
                lifecycleState: 'thinking'
            })
            const remaining = store.messages.getAllMessages(session.id)
            expect(remaining.find(m => m.id === t2LiveMsg.id)?.lifecycleState).toBe('streaming')

            // Binding a replacement source fences src-1 and cuts off running turn-2
            const bind2 = store.messages.bindSessionSource(session.id, 'src-2', 1080, 'default')
            expect(bind2.sourceGeneration).toBe(1)
            expect(bind2.closedTurnIds).toEqual(['turn-2'])
            expect(bind2.finalizedMessages.map(m => m.id)).toEqual([t2LiveMsg.id])
            expect(store.messages.isSessionSourceAuthoritative(session.id, 'src-1', 1)).toBe(false)
            expect(store.messages.isSessionSourceAuthoritative(session.id, 'src-2', 1)).toBe(true)
        } finally { store.close() }
    })
})


describe('lifecycle edge contracts', () => {
    type LifecycleEvent = Parameters<Store['messages']['recordTurnLifecycleEvent']>[2]
    const source = { sourceInstanceId: 'src-1', sourceGeneration: 1 }

    function withSession(tag: string, run: (store: Store, session: ReturnType<typeof makeSession>) => void) {
        const store = makeStore()
        try { run(store, makeSession(store, tag)) } finally { store.close() }
    }

    function lifecycle(
        store: Store,
        sessionId: string,
        turnId: string,
        transition: LifecycleEvent['transition'] = 'started',
        overrides: Partial<LifecycleEvent> = {},
        createdAt = 1000
    ) {
        const event: LifecycleEvent = {
            type: 'turn-lifecycle', eventId: turnId + ':' + transition, transition, turnId,
            invocationId: 'inv-' + turnId, scope: 'main', ...source,
            ...(transition === 'finished' ? { outcome: 'completed' as const } : {}),
            ...overrides
        }
        const content = {
            role: 'agent',
            meta: {
                turnId: event.turnId, invocationId: event.invocationId, scope: event.scope,
                sourceInstanceId: event.sourceInstanceId, sourceGeneration: event.sourceGeneration
            },
            content: { type: 'event', id: event.eventId, data: event }
        }
        return store.messages.addLifecycleMessage(sessionId, 'default', content, event, event.eventId, createdAt)
    }

    function stream(turnId: string | null, text: string, authority = source, id = 'shared-stream') {
        return {
            role: 'agent',
            meta: {
                ...authority, scope: 'main' as const,
                ...(turnId ? { turnId, invocationId: 'inv-' + turnId } : {})
            },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'message', id, streamSnapshot: true, live: true, message: text }
            }
        }
    }

    for (const reason of ['session-abort', 'session-end'] as const) {
        it('targets only the captured turns on ' + reason, () => withSession(reason + '-targeted', (store, session) => {
            store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
            lifecycle(store, session.id, 'older')
            const older = store.messages.addMessage(session.id, stream('older', 'older live'), 'older-live')
            const captured = store.messages.getRunningTurnIdsForSession(session.id)
            expect(captured).toEqual(['older'])
            lifecycle(store, session.id, 'newer')
            const newer = store.messages.addMessage(session.id, stream('newer', 'newer live'), 'newer-live')
            const unknown = store.messages.addMessage(session.id, stream(null, 'unattributed live'), 'unknown-live')
            expect([older, newer, unknown].map(message => message.lifecycleState)).toEqual(['streaming', 'streaming', 'streaming'])
            expect(unknown.turnId).toBeUndefined()

            const closed = store.messages.closeRunningTurnsForSession(session.id, 'default', { reason, turnIds: captured })
            const terminal = reason === 'session-abort' ? 'aborted' : 'cutoff'
            expect(closed.closedTurnIds).toEqual(['older'])
            expect(closed.finalizedMessages.map(message => message.id)).toEqual([older.id])
            expect(closed).toMatchObject({ activeTurnId: 'newer', lifecycleState: 'thinking', turnState: terminal })
            expect(store.messages.getMessageByLocalId(session.id, 'older-live')).toMatchObject({ turnState: terminal, lifecycleState: 'settled' })
            expect(store.messages.getMessageByLocalId(session.id, 'newer-live')).toMatchObject({ id: newer.id, turnState: 'running', lifecycleState: 'streaming' })
            expect(store.messages.getMessageByLocalId(session.id, 'unknown-live')).toMatchObject({ id: unknown.id, lifecycleState: 'streaming' })
            expect(store.messages.getRunningTurnIdsForSession(session.id)).toEqual(['newer'])
            expect(store.sessions.getSession(session.id)).toMatchObject({ activeTurnId: 'newer', lifecycleState: 'thinking' })
        }))
    }

    it('preserves the current generation and execution when the same source reconnects', () => withSession('source-reconnect', (store, session) => {
        store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
        lifecycle(store, session.id, 'expired')
        const expired = store.messages.addMessage(session.id, stream('expired', 'expired live'), 'expired-live')
        const cutoff = store.messages.closeRunningTurnsForSession(session.id, 'default', {
            reason: 'session-inactive', sourceInstanceId: source.sourceInstanceId, bumpGeneration: true, now: 1100
        })
        expect(cutoff.nextSourceGeneration).toBe(2)
        expect(cutoff.finalizedMessages.map(message => message.id)).toEqual([expired.id])
        const currentSource = { ...source, sourceGeneration: 2 }
        const started = lifecycle(store, session.id, 'current', 'started', currentSource)
        expect(started.transition).toMatchObject({ fenced: false, turnState: 'running' })
        const current = store.messages.addMessage(session.id, stream('current', 'current live', currentSource), 'current-live')

        const rebound = store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1200, 'default')
        expect(rebound).toMatchObject({
            ...currentSource, fenced: false, closedTurnIds: [], finalizedMessages: [],
            activeTurnId: 'current', lifecycleState: 'thinking', lifecycleChanged: false
        })
        expect(store.messages.isSessionSourceAuthoritative(session.id, source.sourceInstanceId, 1)).toBe(false)
        expect(store.messages.isSessionSourceAuthoritative(session.id, source.sourceInstanceId, 2)).toBe(true)
        expect(store.messages.getMessageByLocalId(session.id, 'current-live')).toMatchObject({ id: current.id, turnState: 'running', lifecycleState: 'streaming' })

        const finished = lifecycle(store, session.id, 'current', 'finished', currentSource)
        expect(finished.transition).toMatchObject({ fenced: false, turnState: 'completed', activeTurnId: null, lifecycleState: 'completed' })
        expect(finished.transition.finalizedMessages.map(message => message.id)).toEqual([current.id])
        const replay = lifecycle(store, session.id, 'current', 'started', { ...currentSource, eventId: 'current:late-start' })
        expect(replay.transition).toMatchObject({ fenced: false, turnState: 'completed', activeTurnId: null })
    }))

    it('keeps a retired bind fenced without cutting off the replacement source', () => withSession('retired-bind', (store, session) => {
        store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
        store.messages.closeRunningTurnsForSession(session.id, 'default', {
            reason: 'session-inactive', sourceInstanceId: source.sourceInstanceId, bumpGeneration: true, now: 1100
        })
        const replacement = store.messages.bindSessionSource(session.id, 'src-2', 1200, 'default')
        expect(replacement).toMatchObject({ sourceInstanceId: 'src-2', sourceGeneration: 1, fenced: false })
        const currentSource = { sourceInstanceId: 'src-2', sourceGeneration: 1 }
        lifecycle(store, session.id, 'replacement-turn', 'started', currentSource)
        const current = store.messages.addMessage(session.id, stream('replacement-turn', 'replacement live', currentSource), 'replacement-live')

        const retired = store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1300, 'default')
        expect(retired).toMatchObject({
            sourceInstanceId: 'src-1', sourceGeneration: 2, fenced: true,
            closedTurnIds: [], finalizedMessages: [], lifecycleChanged: false,
            activeTurnId: 'replacement-turn', lifecycleState: 'thinking'
        })
        expect(store.messages.isSessionSourceAuthoritative(session.id, 'src-1', 2)).toBe(false)
        expect(store.messages.isSessionSourceAuthoritative(session.id, 'src-2', 1)).toBe(true)
        const rejected = lifecycle(store, session.id, 'retired-late-turn', 'started', { sourceGeneration: 2 })
        expect(rejected.transition).toMatchObject({ fenced: true, turnState: 'cutoff', activeTurnId: 'replacement-turn' })
        expect(store.messages.getRunningTurnIdsForSession(session.id)).toEqual(['replacement-turn'])
        expect(store.messages.getMessageByLocalId(session.id, 'replacement-live')).toMatchObject({ id: current.id, turnState: 'running', lifecycleState: 'streaming' })
        expect(store.sessions.getSession(session.id)).toMatchObject({ activeTurnId: 'replacement-turn', lifecycleState: 'thinking' })
    }))

    for (const [label, sourceGeneration] of [
        ['fractional', 1.5], ['oversized', Number.MAX_SAFE_INTEGER + 1], ['negative', -1]
    ] as const) {
        it('rejects a ' + label + ' source generation without stealing the active turn', () => withSession('invalid-generation-' + label, (store, session) => {
            store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
            lifecycle(store, session.id, 'valid')
            const valid = store.messages.addMessage(session.id, stream('valid', 'valid live'), 'valid-live')
            expect(store.messages.isSessionSourceAuthoritative(session.id, source.sourceInstanceId, sourceGeneration)).toBe(false)

            const rejected = lifecycle(store, session.id, 'invalid-' + label, 'started', { sourceGeneration })
            expect(rejected.transition).toMatchObject({ fenced: true, turnState: 'cutoff', activeTurnId: 'valid', lifecycleState: 'thinking' })
            expect(rejected.message).toMatchObject({ turnId: 'invalid-' + label, turnState: 'cutoff', lifecycleState: 'settled' })
            expect(store.messages.getRunningTurnIdsForSession(session.id)).toEqual(['valid'])
            expect(store.messages.getMessageByLocalId(session.id, 'valid-live')).toMatchObject({ id: valid.id, turnState: 'running', lifecycleState: 'streaming' })
            expect(store.sessions.getSession(session.id)).toMatchObject({ activeTurnId: 'valid', lifecycleState: 'thinking' })
        }))
    }

    it('merges lifecycle and compacted snapshot receipts with the transcript', () => withSession('receipt-merge-source', (store, session) => {
        const target = makeSession(store, 'receipt-merge-target')
        store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
        const started = lifecycle(store, session.id, 'merged')
        const first = stream('merged', 'first')
        const second = stream('merged', 'second')
        store.messages.addMessage(session.id, first, 'merged-live-1')
        const current = store.messages.addMessage(session.id, second, 'merged-live-2')
        const finished = lifecycle(store, session.id, 'merged', 'finished')
        expect(finished.transition).toMatchObject({ fenced: false, turnState: 'completed' })
        expect(store.messages.getMessageByLocalId(session.id, 'merged-live-1')).toBeNull()
        const compactedReceipt = store.messages.buildMessageReceiptInfo(first)
        expect(store.messages.checkSessionMessageReceipt(session.id, 'merged-live-1', compactedReceipt)).toBe('matched')
        expect(store.messages.checkSessionMessageReceipt(session.id, 'merged-live-1', { ...compactedReceipt, sourceGeneration: 2 })).toBe('conflict')

        store.messages.mergeSessionMessages(session.id, target.id)
        expect(store.messages.getAllMessages(session.id)).toEqual([])
        expect(store.messages.getMessageByLocalId(target.id, 'merged-live-2')).toMatchObject({ id: current.id, turnState: 'history', lifecycleState: 'settled' })
        for (const [eventId, content] of [
            ['merged:started', started.message.content], ['merged-live-1', first],
            ['merged-live-2', second], ['merged:finished', finished.message.content]
        ] as const) {
            expect(store.messages.checkSessionMessageReceipt(target.id, eventId, store.messages.buildMessageReceiptInfo(content))).toBe('matched')
        }
        expect(store.messages.checkSessionMessageReceipt(target.id, 'merged-live-1', { ...compactedReceipt, turnId: 'different-turn' })).toBe('conflict')
    }))

    for (const mode of ['single', 'batch'] as const) {
        it('copies ' + mode + ' history as settled rows without copying durable receipts', () => withSession('receipt-copy-' + mode, (store, session) => {
            const target = makeSession(store, 'receipt-copy-target-' + mode)
            store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
            const started = lifecycle(store, session.id, 'copied')
            const first = stream('copied', 'first')
            const second = stream('copied', 'second')
            store.messages.addMessage(session.id, first, 'copied-live-1')
            const current = store.messages.addMessage(session.id, second, 'copied-live-2')
            expect(store.messages.getMessageByLocalId(session.id, 'copied-live-1')).toBeNull()
            expect(store.messages.checkSessionMessageReceipt(session.id, 'copied-live-1', store.messages.buildMessageReceiptInfo(first))).toBe('matched')

            if (mode === 'single') store.messages.copyMessageToSession(target.id, current)
            else expect(store.messages.copyMessagesToSession(target.id, store.messages.getAllMessages(session.id))).toBe(2)
            for (const [eventId, content] of [
                ['copied:started', started.message.content], ['copied-live-1', first], ['copied-live-2', second]
            ] as const) {
                expect(store.messages.checkSessionMessageReceipt(target.id, eventId, store.messages.buildMessageReceiptInfo(content))).toBe('absent')
            }
            const copied = store.messages.getMessageByLocalId(target.id, 'copied-live-2')
            expect(copied).toMatchObject({ turnId: 'copied', turnState: 'history', lifecycleState: 'settled' })
            expect(copied?.content).toMatchObject({ meta: { scope: 'history', replayedHistory: true }, content: { data: { live: false } } })
            expect(store.messages.getMessageByLocalId(session.id, 'copied-live-2')).toMatchObject({ turnState: 'running', lifecycleState: 'streaming' })
            expect(store.messages.getRunningTurnIdsForSession(target.id)).toEqual([])
        }))
    }

    it('truncates suffix receipts even when their snapshot rows were compacted away and keeps pre-anchor lifecycle receipts', () => withSession('receipt-truncate', (store, session) => {
        store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1, 'default')
        const preAnchorStarted = lifecycle(store, session.id, 'kept-turn', 'started', {}, 5)
        const before = stream('kept-turn', 'keep before anchor', source, 'before-anchor')
        const kept = store.messages.addMessage(session.id, before, 'before-receipt', undefined, 10)
        const preAnchorFinished = lifecycle(store, session.id, 'kept-turn', 'finished', { outcome: 'completed' }, 15)
        store.messages.addMessage(session.id, { role: 'user', content: 'rewind here' }, 'truncate-anchor', undefined, 20)
        const started = lifecycle(store, session.id, 'truncated', 'started', {}, 25)
        const first = stream('truncated', 'first suffix snapshot')
        const second = stream('truncated', 'second suffix snapshot')
        store.messages.addMessage(session.id, first, 'truncated-live-1', undefined, 30)
        store.messages.addMessage(session.id, second, 'truncated-live-2', undefined, 40)
        expect(store.messages.getMessageByLocalId(session.id, 'truncated-live-1')).toBeNull()
        expect(store.messages.checkSessionMessageReceipt(session.id, 'truncated-live-1', store.messages.buildMessageReceiptInfo(first))).toBe('matched')

        const result = store.messages.truncateMessagesFromLocalId(session.id, 'truncate-anchor')
        expect(result).toMatchObject({ deleted: 3, inserted: 0 })
        expect(store.messages.getAllMessages(session.id).map((m) => m.id)).toEqual([preAnchorStarted.message.id, kept.id, preAnchorFinished.message.id])
        expect(store.messages.checkSessionMessageReceipt(session.id, 'kept-turn:started', store.messages.buildMessageReceiptInfo(preAnchorStarted.message.content))).toBe('matched')
        expect(store.messages.checkSessionMessageReceipt(session.id, 'before-receipt', store.messages.buildMessageReceiptInfo(before))).toBe('matched')
        expect(store.messages.checkSessionMessageReceipt(session.id, 'kept-turn:finished', store.messages.buildMessageReceiptInfo(preAnchorFinished.message.content))).toBe('matched')
        for (const [eventId, content] of [
            ['truncated:started', started.message.content], ['truncated-live-2', second], ['truncated-live-1', first]
        ] as const) {
            expect(store.messages.checkSessionMessageReceipt(session.id, eventId, store.messages.buildMessageReceiptInfo(content))).toBe('absent')
        }
        expect(store.messages.getRunningTurnIdsForSession(session.id)).toEqual([])
        expect(store.sessions.getSession(session.id)?.activeTurnId ?? null).toBeNull()
        expect(store.sessions.getSession(session.id)?.lifecycleState).toBe('idle')
    }))

    it('persists session_tool_calls lifecycle and hydrates authoritative toolStates across call, result, and turn cutoff', () => withSession('tool-calls-authority', (store, session) => {
        store.messages.bindSessionSource(session.id, source.sourceInstanceId, 1000, 'default')
        lifecycle(store, session.id, 'turn-1', 'started', {}, 1000)

        const callMsg = store.messages.addMessage(session.id, {
            role: 'agent',
            meta: { ...source, scope: 'main' as const, turnId: 'turn-1' },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call', callId: 'tool-1', name: 'bash', input: { command: 'ls' } }
            }
        }, 'call-1', undefined, 1010)
        expect(callMsg.toolStates).toEqual({
            'tool-1': { state: 'running', startedAt: 1010, completedAt: null }
        })

        const openCallMsg = store.messages.addMessage(session.id, {
            role: 'agent',
            meta: { ...source, scope: 'main' as const, turnId: 'turn-1' },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call', callId: 'tool-open', name: 'bash', input: { command: 'sleep 10' } }
            }
        }, 'call-open', undefined, 1020)
        const subagentCallMsg = store.messages.addMessage(session.id, {
            role: 'agent',
            meta: { ...source, scope: 'main' as const, turnId: 'turn-1' },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call', callId: 'tool-subagent', name: 'Task', input: { prompt: 'work' } }
            }
        }, 'call-subagent', undefined, 1025)

        const resultMsg = store.messages.addMessage(session.id, {
            role: 'agent',
            meta: { ...source, scope: 'main' as const, turnId: 'turn-1' },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call-result', callId: 'tool-1', output: 'ok', is_error: false }
            }
        }, 'result-1', undefined, 1030)
        expect(resultMsg.toolStates).toEqual({
            'tool-1': { state: 'completed', startedAt: 1010, completedAt: 1030 }
        })
        expect(store.messages.getMessageByLocalId(session.id, 'call-1')?.toolStates).toEqual({
            'tool-1': { state: 'completed', startedAt: 1010, completedAt: 1030 }
        })

        const finished = lifecycle(store, session.id, 'turn-1', 'finished', { outcome: 'aborted' }, 1040)
        expect(finished.transition.finalizedMessages.map((m) => m.id)).toContain(openCallMsg.id)
        expect(finished.transition.finalizedMessages.map((m) => m.id)).not.toContain(subagentCallMsg.id)
        expect(store.messages.getMessageByLocalId(session.id, 'call-open')?.toolStates).toEqual({
            'tool-open': { state: 'aborted', startedAt: 1020, completedAt: null }
        })
        expect(store.messages.getMessageByLocalId(session.id, 'call-subagent')?.toolStates).toEqual({
            'tool-subagent': { state: 'running', startedAt: 1025, completedAt: null }
        })

        // Late explicit tool-result supersedes earlier turn-cutoff abort in SQLite
        store.messages.addMessage(session.id, {
            role: 'agent',
            meta: { ...source, scope: 'main' as const, turnId: 'turn-1' },
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call-result', callId: 'tool-open', output: 'late ok', is_error: false }
            }
        }, 'result-open-late', undefined, 1050)
        expect(store.messages.getMessageByLocalId(session.id, 'call-open')?.toolStates).toEqual({
            'tool-open': { state: 'completed', startedAt: 1020, completedAt: 1050 }
        })
    }))
})
