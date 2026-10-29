import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMessageStreamId } from '@hapi/protocol/messages'
import { encodeMessageContent } from './contentCodec'
import { Store } from './index'

function snapshot(text: string, live: boolean) {
    return { role: 'agent', content: { type: 'output', data: {
        type: 'assistant', uuid: 'stream', streamSnapshot: true, live,
        message: { content: [{ type: 'text', text }] }
    } } }
}

describe('schema v26 stream metadata', () => {
    it('backfills compressed and plaintext history once and preserves finals over late live after restart', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-stream-v26-'))
        const path = join(directory, 'hapi.db')
        let store: Store | undefined
        try {
            store = new Store(path)
            const session = store.sessions.getOrCreateSession('stream', {}, null, 'default')
            store.close()
            store = undefined
            const legacy = new Database(path)
            const final = snapshot('final '.repeat(100), false)
            const finalBytes = encodeMessageContent(final)
            try {
                legacy.exec(`
                    DROP INDEX idx_messages_stream;
                    ALTER TABLE messages DROP COLUMN stream_id;
                    ALTER TABLE messages DROP COLUMN stream_live;
                    PRAGMA user_version = 25;
                `)
                const insert = legacy.prepare(`INSERT INTO messages
                    (id, session_id, content, created_at, seq, invoked_at)
                    VALUES (?, ?, ?, 1000, ?, 1000)`)
                insert.run('live', session.id, JSON.stringify(snapshot('partial', true)), 1)
                insert.run('old-final', session.id, JSON.stringify(snapshot('old final', false)), 2)
                for (let i = 3; i < 453; i++) insert.run(`context-${i}`, session.id, JSON.stringify({ context: i }), i)
                insert.run('final', session.id, finalBytes, 453)
                insert.run('late-live', session.id, encodeMessageContent(snapshot('late '.repeat(100), true)), 454)
            } finally { legacy.close() }

            store = new Store(path)
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(451)
            expect(messages.filter(message => getMessageStreamId(message.content) !== null))
                .toEqual([expect.objectContaining({ id: 'final', content: final })])
            const epoch = store.messages.getMessageEpoch(session.id)
            store.close()
            store = undefined
            const inspect = new Database(path, { readonly: true })
            try {
                const row = inspect.prepare('SELECT content, stream_id, stream_live, typeof(content) AS encoding FROM messages WHERE id = ?')
                    .get('final') as { content: Buffer; stream_id: string; stream_live: number; encoding: string }
                expect(row.stream_id).toBe('output:assistant:stream')
                expect(row.stream_live).toBe(0)
                expect(row.encoding).toBe('blob')
                expect(Buffer.from(row.content)).toEqual(Buffer.from(finalBytes))
                const version = inspect.prepare('PRAGMA user_version').get() as { user_version: number }
                expect(version.user_version).toBe(26)
            } finally { inspect.close() }

            store = new Store(path)
            expect(store.messages.getMessageEpoch(session.id)).toBe(epoch)
            expect(store.messages.addMessage(session.id, snapshot('replayed provisional', true)).id).toBe('final')
            expect(store.messages.getAllMessages(session.id)).toEqual(messages)
        } finally {
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
