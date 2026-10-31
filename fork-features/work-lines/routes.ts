import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { MultiUserGatewayStore } from '../multi-user/gatewayStore'
import { gatewayAccountId } from '../multi-user/executionMount'
import { WorkMapError } from '../../hub/src/store/workLines'
import { pushTrainingCard } from '../../hub/src/socket/trainingCardPush'
const lineCreateSchema = z.object({
    name: z.string(),
    goal: z.string().nullable().optional(),
    sort: z.number().optional(),
    primaryMachineId: z.string(),
    primaryPath: z.string()
})

const linePatchSchema = z.object({
    name: z.string().optional(),
    goal: z.string().nullable().optional(),
    sort: z.number().optional(),
    primaryMachineId: z.string().optional(),
    primaryPath: z.string().optional()
})

const directorySchema = z.object({
    directoryKey: z.string(),
    mode: z.enum(['line', 'mixed', 'ignored']).nullable(),
    lineId: z.string().nullable().optional()
})

const sessionSchema = z.object({
    sessionId: z.string(),
    state: z.enum(['line', 'ignored', 'follow']),
    lineId: z.string().nullable().optional()
})

const dismissedSchema = z.object({
    sessionId: z.string(),
    dismissed: z.boolean()
})

const trainingSchema = z.object({
    run: z.string(),
    machineId: z.string(),
    runDir: z.string()
})

type Ready = {
    account: { id: number; defaultNamespace: string }
    engine: SyncEngine
}

export function mountWorkLineRoutes(app: Hono<WebAppEnv>, deps: {
    store: MultiUserGatewayStore
    jwtSecret: Uint8Array
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
}): void {
    const routes = new Hono<WebAppEnv>()

    const open = async (c: { req: { raw: Request }; json: (body: unknown, status?: number) => Response }): Promise<Ready | Response> => {
        const accountId = await gatewayAccountId(c.req.raw, deps.jwtSecret)
        if (accountId === null) return c.json({ error: 'Not connected' }, 401)
        const account = deps.store.getAccount(accountId)
        if (!account) return c.json({ error: 'Not connected' }, 401)
        const engine = deps.getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        return { account, engine }
    }

    // Visibility is the gateway binding (owner or grant), the same set
    // GET /sessions and GET /machines return. Sharing defaultNamespace is
    // not enough: another account in that namespace must not classify a
    // session or machine it cannot open.
    const canSeeSession = (accountId: number, sessionId: string): boolean => {
        return deps.store.listAccessibleResources('session', accountId).some((binding) => binding.resourceId === sessionId)
    }

    const canSeeMachine = (accountId: number, machineId: string): boolean => {
        return deps.store.listAccessibleResources('machine', accountId).some((binding) => binding.resourceId === machineId)
    }

    const invalidate = (namespace: string, accountId: number, topic: 'work-map' | 'work-layout') => {
        deps.getSseManager()?.broadcast({
            type: 'card-invalidated',
            namespace,
            accountId,
            topic
        })
    }

    routes.get('/map', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const map = ready.engine.getWorkLines().getMap(ready.account.id)
        const items = [
            ...map.lines.map((line) => ({ machineId: line.primaryMachineId, path: line.primaryPath })),
            ...map.directories.map((row) => splitDirectoryKey(row.directoryKey)),
        ]
        const resolved = await canonicalPaths(ready.engine, items)
        return c.json({ ...map, ...(Object.keys(resolved).length > 0 ? { canonicalPaths: resolved } : {}) })
    })

    routes.post('/lines', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = lineCreateSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeMachine(ready.account.id, parsed.data.primaryMachineId)) {
            return c.json({ error: 'Not found' }, 404)
        }
        try {
            const primaryPath = await canonicalPath(ready.engine, parsed.data.primaryMachineId, parsed.data.primaryPath)
            const line = ready.engine.getWorkLines().createLine(ready.account.id, { ...parsed.data, primaryPath })
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ line })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.patch('/lines/:id', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = linePatchSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (parsed.data.primaryMachineId && !canSeeMachine(ready.account.id, parsed.data.primaryMachineId)) {
            return c.json({ error: 'Not found' }, 404)
        }
        try {
            const primaryPath = parsed.data.primaryPath === undefined || !parsed.data.primaryMachineId
                ? parsed.data.primaryPath
                : await canonicalPath(ready.engine, parsed.data.primaryMachineId, parsed.data.primaryPath)
            const line = ready.engine.getWorkLines().updateLine(ready.account.id, c.req.param('id'), { ...parsed.data, primaryPath })
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ line })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.delete('/lines/:id', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        try {
            ready.engine.getWorkLines().deleteLine(ready.account.id, c.req.param('id'))
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/directories', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = directorySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const machineId = machineIdFromDirectoryKey(parsed.data.directoryKey)
        if (!canSeeMachine(ready.account.id, machineId)) return c.json({ error: 'Not found' }, 404)
        try {
            const parts = splitDirectoryKey(parsed.data.directoryKey)
            const path = await canonicalPath(ready.engine, parts.machineId, parts.path)
            ready.engine.getWorkLines().putDirectory(ready.account.id, { ...parsed.data, directoryKey: `${parts.machineId}::${path}` })
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/sessions', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = sessionSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeSession(ready.account.id, parsed.data.sessionId)) {
            return c.json({ error: 'Not found' }, 404)
        }
        try {
            ready.engine.getWorkLines().putSession(ready.account.id, parsed.data)
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/dismissed', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = dismissedSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeSession(ready.account.id, parsed.data.sessionId)) {
            return c.json({ error: 'Not found' }, 404)
        }
        try {
            ready.engine.getWorkLines().putDismissed(ready.account.id, parsed.data.sessionId, parsed.data.dismissed)
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-map')
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/layout/:surface', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        try {
            const layout = ready.engine.getWorkLines().getLayout(ready.account.id, c.req.param('surface'))
            if (!layout) return c.json({ source: 'default', layout: null })
            return c.json({ source: 'saved', layout })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/layout/:surface/training', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        if (c.req.param('surface') !== 'workbench') return c.json({ error: 'Not found' }, 404)
        const body = await c.req.json().catch(() => null) as { lineId?: unknown; run?: unknown; metrics?: unknown } | null
        if (!body || typeof body.lineId !== 'string' || typeof body.run !== 'string') return c.json({ error: 'Invalid body' }, 400)
        if (body.metrics !== undefined && (!Array.isArray(body.metrics) || body.metrics.some((metric) => typeof metric !== 'string'))) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        try {
            const metrics = Array.isArray(body.metrics) ? body.metrics : []
            const layout = ready.engine.getWorkLines().bindTrainingLine(ready.account.id, body.lineId, body.run, metrics)
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-layout')
            pushTrainingCard(ready.account.id, { lineId: body.lineId, run: body.run, metrics })
            return c.json({ layout })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/layout/:surface', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        try {
            const layout = ready.engine.getWorkLines().putLayout(
                ready.account.id,
                c.req.param('surface'),
                await c.req.json().catch(() => null)
            )
            invalidate(ready.account.defaultNamespace, ready.account.id, 'work-layout')
            return c.json({ layout })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/training-runs', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        return c.json({ runs: ready.engine.getWorkLines().listTrainingRuns(ready.account.id) })
    })

    routes.post('/training-runs', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const parsed = trainingSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeMachine(ready.account.id, parsed.data.machineId)) {
            return c.json({ error: 'Not found' }, 404)
        }
        try {
            const run = ready.engine.getWorkLines().registerTrainingRun(ready.account.id, parsed.data)
            return c.json({ run })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/training-runs/:run', async (c) => {
        const ready = await open(c)
        if (ready instanceof Response) return ready
        const row = ready.engine.getWorkLines().getTrainingRun(ready.account.id, c.req.param('run'))
        if (!row || !canSeeMachine(ready.account.id, row.machineId)) return c.json({ error: 'Not found' }, 404)
        try {
            const summary = await ready.engine.queryTrainingRun(row.machineId, { run: row.run, runDir: row.runDir })
            if (!summary || typeof summary !== 'object') return c.json({ unavailable: true })
            return c.json(summary)
        } catch {
            return c.json({ unavailable: true })
        }
    })

    app.route('/api/work', routes)
}

function mapError(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
    if (error instanceof WorkMapError) return c.json({ error: error.message }, error.status)
    console.error('[work-lines] request failed', error)
    return c.json({ error: 'Work request failed' }, 500)
}

function machineIdFromDirectoryKey(key: string): string {
    const separator = key.indexOf('::')
    return separator > 0 ? key.slice(0, separator) : ''
}

function splitDirectoryKey(key: string): { machineId: string, path: string } {
    const separator = key.indexOf('::')
    if (separator <= 0) return { machineId: '', path: key }
    return { machineId: key.slice(0, separator), path: key.slice(separator + 2) }
}

async function canonicalPath(engine: SyncEngine, machineId: string, path: string): Promise<string> {
    const resolved = await canonicalPaths(engine, [{ machineId, path }])
    return resolved[path] ?? path
}

async function canonicalPaths(engine: SyncEngine, items: Array<{ machineId: string, path: string }>): Promise<Record<string, string>> {
    const grouped = new Map<string, Set<string>>()
    for (const item of items) {
        if (!item.machineId || !item.path) continue
        const paths = grouped.get(item.machineId) ?? new Set<string>()
        paths.add(item.path)
        grouped.set(item.machineId, paths)
    }
    const canonical: Record<string, string> = {}
    await Promise.all([...grouped].map(async ([machineId, paths]) => {
        try {
            const result = await engine.checkPathsExist(machineId, [...paths])
            for (const [raw, resolved] of Object.entries(result.resolved ?? {})) {
                if (resolved && resolved !== raw) canonical[raw] = resolved
            }
        } catch {
            // The machine is offline. Comparison keeps the stored path.
        }
    }))
    return canonical
}
