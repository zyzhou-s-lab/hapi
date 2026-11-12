import { describe, expect, it } from 'bun:test'
import { TURN_PAGE_BYTE_BUDGET, TURN_PAGE_ROW_MAX } from '@hapi/protocol/turnBoundary'
import { MessageService } from './messageService'
import { Store } from '../store'
import type { Server } from 'socket.io'

function service(store: Store): MessageService {
    const io = { of: () => ({ to: () => ({ emit: () => {} }) }) } as unknown as Server
    return new MessageService(store, io, { publish: () => {} } as never)
}

function user(text: string) {
    return { role: 'user', content: { type: 'text', text } }
}

function agent(text: string) {
    return { role: 'agent', content: { type: 'text', text } }
}

function messageText(content: unknown): string {
    if (!content || typeof content !== 'object' || !('content' in content)) return ''
    const inner = content.content
    if (typeof inner === 'string') return inner
    if (inner && typeof inner === 'object' && 'text' in inner && typeof inner.text === 'string') return inner.text
    return ''
}

describe('getMessagesPage turns', () => {
    it('returns the newest complete turns and then the older ones', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('turns', { path: '/tmp/turns' }, null, 'default')
        const base = Date.now() - 100_000
        for (let index = 0; index < 25; index += 1) {
            store.messages.addMessage(session.id, user(`prompt ${index}`), undefined, undefined, base + index * 2)
            store.messages.addMessage(session.id, agent(`reply ${index}`), undefined, undefined, base + index * 2 + 1)
        }

        const pages = service(store)
        const latest = pages.getMessagesPage(session.id, { limit: 50, turns: 20, before: null })
        expect(latest.messages.map((message) => messageText(message.content))).toEqual(
            Array.from({ length: 20 }, (_, offset) => {
                const index = 5 + offset
                return [`prompt ${index}`, `reply ${index}`]
            }).flat()
        )
        expect(latest.page.hasMore).toBe(true)
        expect(latest.page.limit).toBe(20)
        expect(latest.page.nextBeforeSeq).toBe(latest.messages[0]?.seq)

        const older = pages.getMessagesPage(session.id, {
            limit: 50,
            turns: 20,
            before: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! }
        })
        expect(older.messages.map((message) => messageText(message.content))).toEqual([
            'prompt 0', 'reply 0',
            'prompt 1', 'reply 1',
            'prompt 2', 'reply 2',
            'prompt 3', 'reply 3',
            'prompt 4', 'reply 4'
        ])
        expect(older.page.hasMore).toBe(false)
    })

    it('does not split a turn that is larger than the message page cap', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('fat', { path: '/tmp/fat' }, null, 'default')
        const base = Date.now() - 100_000
        store.messages.addMessage(session.id, user('older'), undefined, undefined, base)
        store.messages.addMessage(session.id, user('latest'), undefined, undefined, base + 1)
        for (let index = 0; index < 201; index += 1) {
            store.messages.addMessage(session.id, agent(`step ${index}`), undefined, undefined, base + 2 + index)
        }

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 1, before: null })
        const texts = page.messages.map((message) => messageText(message.content))
        expect(texts[0]).toBe('latest')
        expect(texts).toHaveLength(202)
        expect(texts.at(-1)).toBe('step 200')
        expect(page.page.hasMore).toBe(true)
        expect(texts).not.toContain('older')
    })

    it('stops at 2000 rows when the ceiling contains no turn start', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('cap', { path: '/tmp/cap' }, null, 'default')
        const base = Date.now() - 500_000
        store.messages.addMessage(session.id, user('prompt'), undefined, undefined, base)
        for (let index = 0; index < TURN_PAGE_ROW_MAX + 5; index += 1) {
            store.messages.addMessage(session.id, agent(`step ${index}`), undefined, undefined, base + 1 + index)
        }

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 20, before: null })
        const texts = page.messages.map((message) => messageText(message.content))
        expect(texts).toHaveLength(TURN_PAGE_ROW_MAX)
        expect(texts[0]).toBe('step 5')
        expect(texts.at(-1)).toBe(`step ${TURN_PAGE_ROW_MAX + 4}`)
        expect(texts).not.toContain('prompt')
        expect(page.page.hasMore).toBe(true)
    })

    it('keeps every complete turn inside the row ceiling', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('cap-start', { path: '/tmp/cap-start' }, null, 'default')
        const base = Date.now() - 500_000
        store.messages.addMessage(session.id, user('outside'), undefined, undefined, base)
        for (let index = 0; index < 100; index += 1) {
            store.messages.addMessage(session.id, agent(`outside ${index}`), undefined, undefined, base + 1 + index)
        }
        const firstAt = base + 200
        store.messages.addMessage(session.id, user('first'), undefined, undefined, firstAt)
        for (let index = 0; index < 1800; index += 1) {
            store.messages.addMessage(session.id, agent(`old ${index}`), undefined, undefined, firstAt + 1 + index)
        }
        const newerAt = firstAt + 2_000
        store.messages.addMessage(session.id, user('newer'), undefined, undefined, newerAt)
        for (let index = 0; index < 150; index += 1) {
            store.messages.addMessage(session.id, agent(`new ${index}`), undefined, undefined, newerAt + 1 + index)
        }

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 20, before: null })
        const texts = page.messages.map((message) => messageText(message.content))
        expect(texts[0]).toBe('first')
        expect(texts).toHaveLength(1952)
        expect(texts).toContain('old 0')
        expect(texts).toContain('newer')
        expect(texts.at(-1)).toBe('new 149')
        expect(texts).not.toContain('outside')
        expect(page.page.hasMore).toBe(true)
    })

    it('keeps injected user rows inside the turn and pins queued prompts off the cursor', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('inject', { path: '/tmp/inject' }, null, 'default')
        const base = Date.now() - 50_000
        store.messages.addMessage(session.id, user('real'), undefined, undefined, base)
        store.messages.addMessage(
            session.id,
            { role: 'user', content: '<task-notification>\n<task-id>1</task-id>' },
            undefined,
            undefined,
            base + 1
        )
        store.messages.addMessage(session.id, agent('still this turn'), undefined, undefined, base + 2)
        store.messages.addMessage(session.id, user('queued'), 'local-queued', undefined, base + 3)

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 1, before: null })
        const texts = page.messages.map((message) => messageText(message.content))
        expect(texts).toContain('real')
        expect(texts.some((text) => text.startsWith('<task-notification>'))).toBe(true)
        expect(texts).toContain('still this turn')
        expect(texts).toContain('queued')
        expect(page.page.hasMore).toBe(false)
        expect(page.page.nextBeforeAt).toBe(base)
    })

    it('includes the leading preamble on the oldest page', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('preamble', { path: '/tmp/preamble' }, null, 'default')
        const base = Date.now() - 20_000
        store.messages.addMessage(session.id, agent('warmup'), undefined, undefined, base)
        store.messages.addMessage(session.id, user('only'), undefined, undefined, base + 1)

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 20, before: null })
        expect(page.messages).toHaveLength(2)
        expect(page.page.hasMore).toBe(false)
    })

    it('leaves a limit-only request on the message cap', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('legacy', { path: '/tmp/legacy' }, null, 'default')
        const base = Date.now() - 20_000
        for (let index = 0; index < 3; index += 1) {
            store.messages.addMessage(session.id, user(`p${index}`), undefined, undefined, base + index)
        }
        const page = service(store).getMessagesPage(session.id, { limit: 2, before: null })
        expect(page.messages).toHaveLength(2)
        expect(page.page.limit).toBe(2)
        expect(page.page.hasMore).toBe(true)
    })

    it('compacts intermediate codex:agent-run-update snapshots and respects TURN_PAGE_BYTE_BUDGET at turn boundaries', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('byte-budget', { path: '/tmp/byte-budget' }, null, 'default')
        const base = Date.now() - 100_000
        const chunkText = 'x'.repeat(55_000)

        // Turn 0 (older): 8 chunks * 55 KB = ~440 KB
        store.messages.addMessage(session.id, user('turn 0'), undefined, undefined, base)
        for (let i = 0; i < 8; i += 1) {
            store.messages.addMessage(session.id, agent(chunkText), undefined, undefined, base + 1 + i)
        }

        // Turn 1 (middle): 8 chunks * 55 KB = ~440 KB
        store.messages.addMessage(session.id, user('turn 1'), undefined, undefined, base + 20)
        for (let i = 0; i < 8; i += 1) {
            store.messages.addMessage(session.id, agent(chunkText), undefined, undefined, base + 21 + i)
        }

        // Turn 2 (newest): 8 chunks * 55 KB (~440 KB) + 20 running agent-run-update snapshots
        store.messages.addMessage(session.id, user('turn 2'), undefined, undefined, base + 40)
        for (let index = 0; index < 20; index += 1) {
            store.messages.addMessage(
                session.id,
                {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'agent-run-update',
                            cardId: 'omp-subagent:1',
                            agentId: 'sub-1',
                            status: 'running',
                            activity: `step ${index}`,
                            summary: 'Subagent 1',
                            progress: { step: index, text: 'p'.repeat(4000) }
                        }
                    }
                },
                undefined,
                undefined,
                base + 41 + index
            )
        }
        for (let i = 0; i < 8; i += 1) {
            store.messages.addMessage(session.id, agent(chunkText), undefined, undefined, base + 70 + i)
        }

        const page = service(store).getMessagesPage(session.id, { limit: 50, turns: 8, before: null })
        const texts = page.messages.map((message) => messageText(message.content)).filter(Boolean)
        // Turn 1 + Turn 2 fit within TURN_PAGE_BYTE_BUDGET (~888 KB <= 1 MiB), whereas adding Turn 0 (~1.33 MiB) exceeds it
        expect(texts).toContain('turn 1')
        expect(texts).toContain('turn 2')
        expect(texts).not.toContain('turn 0')
        expect(page.page.hasMore).toBe(true)

        // Intermediate agent-run-update snapshots in Turn 2 are compacted down to first + last (2 rows instead of 20)
        const agentRunUpdates = page.messages.filter((message) => {
            const record = message.content as { content?: { data?: { type?: string } } }
            return record?.content?.data?.type === 'agent-run-update'
        })
        expect(agentRunUpdates).toHaveLength(2)
        expect(JSON.stringify(page.messages).length).toBeLessThanOrEqual(TURN_PAGE_BYTE_BUDGET * 1.05)
    })
})
