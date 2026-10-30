import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Store } from '../../hub/src/store'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import { mountWorkLineRoutes } from '../work-lines/routes'
import { bindUnownedNamespaceResources } from './hubMount'
import { MultiUserGatewayStore } from './gatewayStore'

const jwtSecret = new TextEncoder().encode('test-secret-test-secret-test-secret')

describe('unowned namespace resources', () => {
    it('binds a single old account so the work line API is not 404', async () => {
        const core = new Store(':memory:')
        const gateway = new MultiUserGatewayStore(':memory:')
        try {
            core.machines.getOrCreateMachine('gpu', null, null, 'default')
            core.sessions.getOrCreateSession('old', { path: '/data/hapi', machineId: 'gpu' }, null, 'default')
            const admin = gateway.createAccount('admin', 'admin', 'default', null)
            expect(gateway.getResource('machine', 'gpu')).toBeNull()

            expect(bindUnownedNamespaceResources(core, gateway)).toBe(2)
            expect(gateway.getResource('machine', 'gpu')).toMatchObject({
                ownerAccountId: admin.id,
                coreNamespace: 'default'
            })

            const token = await new SignJWT({ gaid: admin.id }).setProtectedHeader({ alg: 'HS256' }).sign(jwtSecret)
            const app = new Hono<WebAppEnv>()
            mountWorkLineRoutes(app, {
                store: gateway,
                jwtSecret,
                getSyncEngine: () => ({ getWorkLines: () => core.workLines }) as never,
                getSseManager: () => null
            })
            const response = await app.request('/api/work/lines', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: '主线', primaryMachineId: 'gpu', primaryPath: '/data/hapi' })
            })
            expect(response.status).toBe(200)
        } finally {
            core.close()
            gateway.close()
        }
    })

    it('does not take a machine that two accounts already share a namespace for', () => {
        const core = new Store(':memory:')
        const gateway = new MultiUserGatewayStore(':memory:')
        try {
            core.machines.getOrCreateMachine('gpu', null, null, 'default')
            gateway.createAccount('admin', 'admin', 'default', null)
            gateway.createAccount('alice', 'user', 'default', null)
            expect(bindUnownedNamespaceResources(core, gateway)).toBe(0)
            expect(gateway.getResource('machine', 'gpu')).toBeNull()
        } finally {
            core.close()
            gateway.close()
        }
    })

    it('does not replace an owner that is already recorded', () => {
        const core = new Store(':memory:')
        const gateway = new MultiUserGatewayStore(':memory:')
        try {
            core.machines.getOrCreateMachine('gpu', null, null, 'default')
            const owner = gateway.createAccount('owner', 'user', 'default', null)
            gateway.createAccount('other', 'user', 'other', null)
            gateway.bindResource({
                resourceType: 'machine',
                resourceId: 'gpu',
                ownerAccountId: owner.id,
                coreNamespace: 'default'
            })
            expect(bindUnownedNamespaceResources(core, gateway)).toBe(0)
            expect(gateway.getResource('machine', 'gpu')?.ownerAccountId).toBe(owner.id)
        } finally {
            core.close()
            gateway.close()
        }
    })
})
