import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Store } from '../store'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { CliSocketWithData } from '../socket/socketTypes'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { WebAppEnv } from '../web/middleware/auth'
import { createGitRoutes } from '../web/routes/git'
import { readStoredGeneratedImage, writeStoredGeneratedImage } from './storage'

async function withTempHapiHome<T>(run: (hapiHome: string) => Promise<T>): Promise<T> {
    const previous = process.env.HAPI_HOME
    const tempHome = await mkdtemp(join(tmpdir(), 'hapi-gen-images-'))
    process.env.HAPI_HOME = tempHome
    try {
        return await run(tempHome)
    } finally {
        if (previous === undefined) {
            delete process.env.HAPI_HOME
        } else {
            process.env.HAPI_HOME = previous
        }
        await rm(tempHome, { recursive: true, force: true })
    }
}

describe('generatedImages hub storage', () => {
    it('persists and reads generated images scoped by namespace', async () => {
        await withTempHapiHome(async (hapiHome) => {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            const wrote = await writeStoredGeneratedImage(hapiHome, 'team-a', 'bd1cb377-bfcd-4bf3-a1d1-373021b09233', {
                fileName: 'curve.png',
                mimeType: 'image/png',
                bytes: pngBytes
            })
            expect(wrote).toBe(true)

            const loaded = await readStoredGeneratedImage(hapiHome, 'team-a', 'bd1cb377-bfcd-4bf3-a1d1-373021b09233')
            expect(loaded).not.toBeNull()
            expect(loaded?.fileName).toBe('curve.png')
            expect(loaded?.mimeType).toBe('image/png')
            expect(loaded?.bytes).toEqual(pngBytes)

            const otherNamespace = await readStoredGeneratedImage(hapiHome, 'team-b', 'bd1cb377-bfcd-4bf3-a1d1-373021b09233')
            expect(otherNamespace).toBeNull()
        })
    })

    it('rejects invalid imageId values with path traversal characters', async () => {
        await withTempHapiHome(async (hapiHome) => {
            const wrote = await writeStoredGeneratedImage(hapiHome, 'default', '../escape', {
                fileName: 'curve.png',
                mimeType: 'image/png',
                bytes: Buffer.from([1, 2, 3])
            })
            expect(wrote).toBe(false)
            expect(await readStoredGeneratedImage(hapiHome, 'default', '../escape')).toBeNull()
        })
    })

    it('persists CLI generated-image:upload events and serves them when the session is inactive or forked', async () => {
        await withTempHapiHome(async (hapiHome) => {
            const store = new Store(':memory:')
            try {
                const originSession = store.sessions.getOrCreateSession('session-origin', {}, null, 'default')
                const forkedSession = store.sessions.getOrCreateSession('session-forked', {}, null, 'default')
                const handlers = new Map<string, (data: unknown) => unknown>()
                const fakeSocket = {
                    on(event: string, handler: (data: unknown) => unknown) {
                        handlers.set(event, handler)
                        return this
                    },
                    to() {
                        return { emit() {} }
                    }
                }

                registerSessionHandlers(fakeSocket as unknown as CliSocketWithData, {
                    store,
                    resolveSessionAccess: (sid) => sid === originSession.id
                        ? { ok: true, value: originSession }
                        : { ok: false, reason: 'not-found' },
                    emitAccessError: () => {}
                })

                const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
                const imageId = 'bd1cb377-bfcd-4bf3-a1d1-373021b09233'
                await handlers.get('generated-image:upload')?.({
                    sid: originSession.id,
                    imageId,
                    fileName: 'training_curve.png',
                    mimeType: 'image/png',
                    content: pngBytes.toString('base64')
                })

                const sessionsById: Record<string, Session> = {
                    [originSession.id]: { id: originSession.id, namespace: 'default', active: false } as unknown as Session,
                    [forkedSession.id]: { id: forkedSession.id, namespace: 'default', active: false } as unknown as Session
                }

                const engine = {
                    resolveSessionAccess: (sessionId: string, namespace: string) => {
                        const session = sessionsById[sessionId]
                        if (!session || session.namespace !== namespace) {
                            return { ok: false as const, reason: 'not-found' as const }
                        }
                        return { ok: true as const, sessionId, session }
                    },
                    readGeneratedImage: async (sessionId: string, id: string) => {
                        const session = sessionsById[sessionId]
                        const stored = await readStoredGeneratedImage(hapiHome, session?.namespace ?? 'default', id)
                        if (stored) {
                            return {
                                success: true,
                                content: stored.bytes.toString('base64'),
                                mimeType: stored.mimeType,
                                fileName: stored.fileName
                            }
                        }
                        return { success: false, error: 'RPC not available (session inactive)' }
                    }
                } as unknown as Partial<SyncEngine>

                const app = new Hono<WebAppEnv>()
                app.use('*', async (c, next) => {
                    c.set('namespace', 'default')
                    await next()
                })
                app.route('/api', createGitRoutes(() => engine as SyncEngine))

                const inactiveRes = await app.request(`/api/sessions/${originSession.id}/generated-images/${imageId}`)
                expect(inactiveRes.status).toBe(200)
                expect(inactiveRes.headers.get('content-type')).toBe('image/png')
                expect(Buffer.from(await inactiveRes.arrayBuffer())).toEqual(pngBytes)

                const forkedRes = await app.request(`/api/sessions/${forkedSession.id}/generated-images/${imageId}`)
                expect(forkedRes.status).toBe(200)
                expect(forkedRes.headers.get('content-type')).toBe('image/png')
                expect(Buffer.from(await forkedRes.arrayBuffer())).toEqual(pngBytes)
            } finally {
                store.close()
            }
        })
    })
})
