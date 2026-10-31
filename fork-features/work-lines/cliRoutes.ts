import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import { WorkMapError, type WorkLayout } from '../../hub/src/store/workLines'
import { pushTrainingCard } from '../../hub/src/socket/trainingCardPush'
import { getConfiguration } from '../../hub/src/configuration'
import { parseAccessToken } from '../../hub/src/utils/accessToken'
import { constantTimeEquals } from '../../hub/src/utils/crypto'
import type { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { resolveGatewayCliAccountId } from '../multi-user/cliAdapter'

const registerSchema = z.object({
    run: z.string(),
    machineId: z.string(),
    runDir: z.string(),
})

const bindSchema = z.object({
    lineId: z.string(),
    run: z.string(),
    metrics: z.array(z.string()).optional(),
    instanceId: z.string().optional(),
    xAxis: z.string().optional(),
})

const unbindSchema = z.object({
    instanceId: z.string(),
})

function bearerToken(header: string | undefined): string | null {
    if (!header) return null
    const match = /^Bearer\s+(.+)$/i.exec(header)
    return match?.[1] ?? null
}

export function mountCliWorkRoutes(app: Hono<WebAppEnv>, deps: {
    store: MultiUserGatewayStore
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
}): void {
    const routes = new Hono<WebAppEnv>()
    const open = (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }) => {
        const token = bearerToken(c.req.header('authorization'))
        if (!token) return c.json({ error: 'Missing Authorization header' }, 401)
        const accountId = resolveGatewayCliAccountId(deps.store, token)
        if (accountId === null) {
            const error = isHubBaseCliToken(token) ? 'training tools need a gateway CLI token' : 'Invalid token'
            return c.json({ error }, 401)
        }
        const account = deps.store.getAccount(accountId)
        const engine = deps.getSyncEngine()
        if (!account || !engine) return c.json({ error: 'Not ready' }, 503)
        return { account, engine }
    }

    const canSeeMachine = (accountId: number, machineId: string): boolean => {
        return deps.store.listAccessibleResources('machine', accountId).some((binding) => binding.resourceId === machineId)
    }

    routes.post('/training-runs', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = registerSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeMachine(ready.account.id, parsed.data.machineId)) return c.json({ error: 'Not found' }, 404)
        try {
            const run = ready.engine.getWorkLines().registerTrainingRun(ready.account.id, parsed.data)
            return c.json({ run })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/training-runs/:run', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const row = ready.engine.getWorkLines().getTrainingRun(ready.account.id, c.req.param('run'))
        if (!row || !canSeeMachine(ready.account.id, row.machineId)) return c.json({ error: 'Not found' }, 404)
        const cards = ready.engine.getWorkLines().listTrainingCards(ready.account.id, row.run)
        try {
            const summary = await ready.engine.queryTrainingRun(row.machineId, { run: row.run, runDir: row.runDir })
            if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return c.json({ unavailable: true, cards })
            return c.json({ ...summary, cards })
        } catch {
            return c.json({ unavailable: true, cards })
        }
    })

    routes.put('/training-card', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = bindSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const bound = ready.engine.getWorkLines().bindTrainingLine(ready.account.id, parsed.data)
            deps.getSseManager()?.broadcast({
                type: 'card-invalidated',
                namespace: ready.account.defaultNamespace,
                accountId: ready.account.id,
                topic: 'work-layout',
            })
            pushTrainingCard(ready.account.id, {
                lineId: parsed.data.lineId,
                run: parsed.data.run,
                metrics: storedTrainingMetrics(bound.layout, bound.instanceId),
                instanceId: bound.instanceId,
            })
            return c.json({ layout: bound.layout, instanceId: bound.instanceId })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.delete('/training-card/:instanceId', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = unbindSchema.safeParse({ instanceId: c.req.param('instanceId') })
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const layout = ready.engine.getWorkLines().unbindTrainingCard(ready.account.id, parsed.data.instanceId)
            deps.getSseManager()?.broadcast({
                type: 'card-invalidated',
                namespace: ready.account.defaultNamespace,
                accountId: ready.account.id,
                topic: 'work-layout',
            })
            return c.json({ layout })
        } catch (error) {
            return mapError(c, error)
        }
    })

    app.route('/cli/work', routes)
}

function mapError(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
    if (error instanceof WorkMapError) return c.json({ error: error.message }, error.status)
    console.error('[work-lines] cli request failed', error)
    return c.json({ error: 'Work request failed' }, 500)
}

function isHubBaseCliToken(token: string): boolean {
    try {
        const parsed = parseAccessToken(token)
        if (!parsed) return false
        return constantTimeEquals(parsed.baseToken, getConfiguration().cliApiToken)
    } catch {
        return false
    }
}

function storedTrainingMetrics(layout: WorkLayout, instanceId: string): string[] {
    const slot = layout.regions.main?.find((item) => item.cardId === 'example.training-curves' && item.args?.instanceId === instanceId)
    const raw = slot?.args?.metrics
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}
