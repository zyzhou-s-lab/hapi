import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { mountCliWorkRoutes } from './cliRoutes'
import { Store } from '../../hub/src/store'
import { createConfiguration } from '../../hub/src/configuration'
import { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { createApiToken } from '../multi-user/token'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { setTrainingCardPush } from '../../hub/src/socket/trainingCardPush'

const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

describe('cli work routes', () => {
    const core = new Store(':memory:')
    const gateway = new MultiUserGatewayStore(':memory:')
    const owner = gateway.createAccount('owner', 'user', 'owner-namespace', null)
    const other = gateway.createAccount('other', 'user', 'other-namespace', null)
    const ownerToken = createApiToken()
    const otherToken = createApiToken()
    gateway.createToken(owner.id, 'cli', ownerToken.hash, 'owner-namespace')
    gateway.createToken(other.id, 'cli', otherToken.hash, 'other-namespace')
    gateway.bindResource({
        resourceType: 'machine',
        resourceId: 'gpu',
        ownerAccountId: owner.id,
        coreNamespace: owner.defaultNamespace,
    })
    const rpcCalls: Array<{ machineId: string; run: string; runDir: string }> = []
    const pushed: unknown[] = []
    setTrainingCardPush((_accountId, update) => { pushed.push(update) })

    const engine = {
        getWorkLines: () => core.workLines,
        queryTrainingRun: async (machineId: string, query: { run: string; runDir: string }) => {
            rpcCalls.push({ machineId, run: query.run, runDir: query.runDir })
            return { metrics: ['loss'], partial: true }
        },
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    mountCliWorkRoutes(app, {
        store: gateway,
        getSyncEngine: () => engine,
        getSseManager: () => ({ broadcast: () => undefined }) as unknown as SSEManager,
    })

    const ownerAuth = { authorization: `Bearer ${ownerToken.plaintext}`, 'content-type': 'application/json' }

    it('registers, queries and binds from the CLI token, not a body account', async () => {
        const created = await app.request('/cli/work/training-runs', {
            method: 'POST',
            headers: ownerAuth,
            body: JSON.stringify({ run: 'exp-1', machineId: 'gpu', runDir: '/data/wandb/offline-run-1', accountId: other.id }),
        })
        expect(created.status).toBe(200)
        expect(core.workLines.getTrainingRun(owner.id, 'exp-1')?.runDir).toBe('/data/wandb/offline-run-1')
        expect(core.workLines.getTrainingRun(other.id, 'exp-1')).toBeNull()

        const summary = await app.request('/cli/work/training-runs/exp-1', { headers: ownerAuth })
        expect(summary.status).toBe(200)
        expect(await summary.json()).toEqual({ metrics: ['loss'], partial: true })
        expect(rpcCalls).toEqual([{ machineId: 'gpu', run: 'exp-1', runDir: '/data/wandb/offline-run-1' }])

        const hidden = await app.request('/cli/work/training-runs/exp-1', {
            headers: { authorization: `Bearer ${otherToken.plaintext}` },
        })
        expect(hidden.status).toBe(404)

        const line = core.workLines.createLine(owner.id, { name: '主线', primaryMachineId: 'gpu', primaryPath: '/data/hapi' })
        const bound = await app.request('/cli/work/training-card', {
            method: 'PUT',
            headers: ownerAuth,
            body: JSON.stringify({ lineId: line.id, run: 'exp-1', metrics: ['loss', ' loss', 'loss'], accountId: other.id }),
        })
        expect(bound.status).toBe(200)
        expect(pushed).toEqual([{ lineId: line.id, run: 'exp-1', metrics: ['loss'] }])
        const layout = core.workLines.getLayout(owner.id, 'workbench')
        const slot = layout?.regions.main.find((item) => item.args?.run === 'exp-1')
        expect(slot?.args?.lineId).toBe(line.id)
    })

    it('rejects a web JWT on the CLI training route', async () => {
        const jwt = await new SignJWT({ gaid: owner.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
        const response = await app.request('/cli/work/training-runs', {
            method: 'POST',
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            body: JSON.stringify({ run: 'exp-jwt', machineId: 'gpu', runDir: '/data/wandb/jwt' }),
        })
        expect(response.status).toBe(401)
    })

    it('does not bind another account line and does not push', async () => {
        pushed.length = 0
        const line = core.workLines.createLine(owner.id, { name: '别人的主线', primaryMachineId: 'gpu', primaryPath: '/data/other-line' })
        const response = await app.request('/cli/work/training-card', {
            method: 'PUT',
            headers: { authorization: `Bearer ${otherToken.plaintext}`, 'content-type': 'application/json' },
            body: JSON.stringify({ lineId: line.id, run: 'exp-1', metrics: ['loss'] }),
        })
        expect(response.status).toBe(404)
        expect(pushed).toEqual([])
        const slot = core.workLines.getLayout(owner.id, 'workbench')?.regions.main.find((item) => item.args?.lineId === line.id)
        expect(slot).toBeUndefined()
    })

    it('tells a hub base token that is not a gateway token to use one', async () => {
        const config = await createConfiguration()
        const previousToken = config.cliApiToken
        const previousSource = config.cliApiTokenSource === 'file' || config.cliApiTokenSource === 'generated' ? config.cliApiTokenSource : 'env'
        config._setCliApiToken('hub-base-token', 'env', false)
        try {
            const response = await app.request('/cli/work/training-runs', {
                method: 'POST',
                headers: { authorization: 'Bearer hub-base-token', 'content-type': 'application/json' },
                body: JSON.stringify({ run: 'exp-base', machineId: 'gpu', runDir: '/data/wandb/offline-run-base' }),
            })
            expect(response.status).toBe(401)
            expect(await response.json()).toEqual({ error: 'training tools need a gateway CLI token' })
        } finally {
            config._setCliApiToken(previousToken, previousSource, false)
        }
    })

    it('accepts the hub base token when that token is already the gateway token', async () => {
        const config = await createConfiguration()
        const previousToken = config.cliApiToken
        const previousSource = config.cliApiTokenSource === 'file' || config.cliApiTokenSource === 'generated' ? config.cliApiTokenSource : 'env'
        config._setCliApiToken(ownerToken.plaintext, 'env', false)
        try {
            const response = await app.request('/cli/work/training-runs', {
                method: 'POST',
                headers: ownerAuth,
                body: JSON.stringify({ run: 'exp-seed', machineId: 'gpu', runDir: '/data/wandb/offline-run-seed' }),
            })
            expect(response.status).toBe(200)
            expect(core.workLines.getTrainingRun(owner.id, 'exp-seed')?.run).toBe('exp-seed')
        } finally {
            config._setCliApiToken(previousToken, previousSource, false)
        }
    })
})
