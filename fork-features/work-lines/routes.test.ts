import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { mountWorkLineRoutes } from './routes'
import { Store } from '../../hub/src/store'
import { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'

const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

describe('work line routes', () => {
    const core = new Store(':memory:')
    const gateway = new MultiUserGatewayStore(':memory:')
    const events: unknown[] = []
    const rpcCalls: Array<{ machineId: string; run: string; runDir: string }> = []
    const account = gateway.createAccount('owner', 'user', 'owner-namespace', null)
    gateway.bindResource({
        resourceType: 'machine',
        resourceId: 'gpu',
        ownerAccountId: account.id,
        coreNamespace: account.defaultNamespace
    })
    gateway.bindResource({
        resourceType: 'session',
        resourceId: 's1',
        ownerAccountId: account.id,
        coreNamespace: account.defaultNamespace
    })
    let internalError: Error | null = null

    afterEach(() => {
        events.length = 0
        rpcCalls.length = 0
        internalError = null
    })

    const engine = {
        getWorkLines: () => {
            if (internalError) throw internalError
            return core.workLines
        },
        getMachine: (id: string) => id === 'gpu' ? { id, namespace: 'owner-namespace' } : undefined,
        getSession: (id: string) => id === 's1' || id === 'foreign' ? { id, namespace: 'owner-namespace' } : undefined,
        queryTrainingRun: async (machineId: string, query: { run: string; runDir: string }) => {
            rpcCalls.push({ machineId, run: query.run, runDir: query.runDir })
            throw new Error('runner missing')
        }
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    mountWorkLineRoutes(app, {
        store: gateway,
        jwtSecret,
        getSyncEngine: () => engine,
        getSseManager: () => ({ broadcast: (event: unknown) => { events.push(event) } }) as SSEManager
    })

    async function token(): Promise<string> {
        return new SignJWT({ gaid: account.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
    }

    it('registers a run without calling the runner and reports unavailable on query', async () => {
        const auth = { authorization: `Bearer ${await token()}` }
        const created = await app.request('/api/work/training-runs', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ run: 'exp-1', machineId: 'gpu', runDir: '/data/wandb/offline-run-1' })
        })
        expect(created.status).toBe(200)
        expect(rpcCalls).toEqual([])
        expect(events).toEqual([])

        const summary = await app.request('/api/work/training-runs/exp-1', { headers: auth })
        expect(summary.status).toBe(200)
        expect(await summary.json()).toEqual({ unavailable: true })
        expect(rpcCalls).toEqual([{ machineId: 'gpu', run: 'exp-1', runDir: '/data/wandb/offline-run-1' }])


        const listed = await app.request('/api/work/training-runs', { headers: auth })
        expect(listed.status).toBe(200)
        expect(await listed.json()).toEqual({ runs: [{ run: 'exp-1' }] })
        expect(JSON.stringify(await (await app.request('/api/work/training-runs', { headers: auth })).json())).not.toContain('runDir')
    })

    it('broadcasts card-invalidated without curve points when a line is created', async () => {
        const auth = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }
        const created = await app.request('/api/work/lines', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ name: '主线', primaryMachineId: 'gpu', primaryPath: '/data/hapi' })
        })
        expect(created.status).toBe(200)
        expect(events).toEqual([{
            type: 'card-invalidated',
            namespace: 'owner-namespace',
            accountId: account.id,
            topic: 'work-map'
        }])
    })

    it('rejects a layout with a bad region', async () => {
        const response = await app.request('/api/work/layout/overview', {
            method: 'PUT',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ revision: 1, regions: { stats: [], extra: [] } })
        })
        expect(response.status).toBe(400)
    })

    it('refuses a directory on a machine the account cannot see', async () => {
        const response = await app.request('/api/work/directories', {
            method: 'PUT',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ directoryKey: 'other::/tmp', mode: 'line', lineId: null })
        })
        expect(response.status).toBe(404)
    })

    it('stores a directory only for a bound machine', async () => {
        const auth = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }
        const created = await app.request('/api/work/lines', {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ name: '目录主线', primaryMachineId: 'gpu', primaryPath: '/data/dir-only' })
        })
        const line = await created.json() as { line: { id: string } }
        const response = await app.request('/api/work/directories', {
            method: 'PUT',
            headers: auth,
            body: JSON.stringify({ directoryKey: 'gpu::/data/other', mode: 'line', lineId: line.line.id })
        })
        expect(response.status).toBe(200)
    })

    it('does not classify a same-namespace session without a binding', async () => {
        const response = await app.request('/api/work/sessions', {
            method: 'PUT',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'foreign', state: 'ignored', lineId: null })
        })
        expect(response.status).toBe(404)
    })

    it('hides internal error text', async () => {
        internalError = new Error('sqlite: secret path')
        const response = await app.request('/api/work/lines', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'x', primaryMachineId: 'gpu', primaryPath: '/data' })
        })
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Work request failed' })
    })
})
