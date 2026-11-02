import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../../hub/src/web/middleware/auth'
import type { SyncEngine } from '../../hub/src/sync/syncEngine'
import type { SSEManager } from '../../hub/src/sse/sseManager'
import { WorkMapError, type WorkLayout, type WorkLine } from '../../hub/src/store/workLines'
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


const cardSchema = z.object({
    run: z.string(),
    metrics: z.array(z.string()).optional(),
    xAxis: z.string().optional(),
    cardId: z.string().optional(),
})

const referenceSchema = z.object({
    format: z.enum(['apa7', 'vancouver']),
    citation: z.string().min(1).max(2000),
})

const lineSchema = z.object({
    name: z.string(),
    hypothesis: z.string().nullable().optional(),
    machineId: z.string(),
    path: z.string(),
})


export function mountCliWorkRoutes(app: Hono<WebAppEnv>, deps: {
    store: MultiUserGatewayStore
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
}): void {
    const routes = new Hono<WebAppEnv>()
    const open = (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }) => {
        const header = c.req.header('authorization')
        const token = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null : null
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

    const canSeeSession = (accountId: number, sessionId: string): boolean => {
        return deps.store.listAccessibleResources('session', accountId).some((binding) => binding.resourceId === sessionId)
    }

    const touch = (account: { id: number; defaultNamespace: string }, topic: 'work-map' | 'work-layout' = 'work-map') => {
        deps.getSseManager()?.broadcast({
            type: 'card-invalidated',
            namespace: account.defaultNamespace,
            accountId: account.id,
            topic,
        })
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
        try {
            const summary = await ready.engine.queryTrainingRun(row.machineId, { run: row.run, runDir: row.runDir })
            if (!summary || typeof summary !== 'object') return c.json({ unavailable: true })
            return c.json(summary)
        } catch {
            return c.json({ unavailable: true })
        }
    })


    routes.get('/explorations', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const explorations = ready.engine.getWorkLines().getMap(ready.account.id).lines.map((line) => ({
            id: line.id,
            name: line.name,
            hypothesis: line.hypothesis,
            primaryMachineId: line.primaryMachineId,
            primaryPath: line.primaryPath,
            createdAt: line.createdAt,
            updatedAt: line.updatedAt,
        }))
        return c.json({ explorations })
    })

    routes.get('/explorations/:id', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const lines = ready.engine.getWorkLines()
        try {
            const line = lines.getMap(ready.account.id).lines.find((item) => item.id === c.req.param('id'))
            if (!line) return c.json({ error: 'Not found' }, 404)
            const sessions = lines.listLinkedSessions(ready.account.id, line.id)
                .filter((session) => canSeeSession(ready.account.id, session.sessionId))
            return c.json({
                exploration: explorationOf(line),
                linkedSessions: sessions,
                verificationCards: lines.listVerificationCards(ready.account.id, line.id),
                references: lines.listReferences(ready.account.id, line.id),
            })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.post('/explorations', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = lineSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        if (!canSeeMachine(ready.account.id, parsed.data.machineId)) return c.json({ error: 'Not found' }, 404)
        try {
            const line = ready.engine.getWorkLines().createLine(ready.account.id, {
                name: parsed.data.name,
                hypothesis: parsed.data.hypothesis,
                primaryMachineId: parsed.data.machineId,
                primaryPath: parsed.data.path,
            })
            const sessionId = c.req.header('x-hapi-session-id')
            if (sessionId && canSeeSession(ready.account.id, sessionId)) {
                ready.engine.getWorkLines().putSession(ready.account.id, { sessionId, state: 'line', lineId: line.id })
            }
            touch(ready.account)
            return c.json({ exploration: explorationOf(line) })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.delete('/explorations/:id', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            ready.engine.getWorkLines().deleteLine(ready.account.id, c.req.param('id'))
            touch(ready.account)
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/explorations/:id/hypothesis', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const body = await c.req.json().catch(() => null) as { hypothesis?: unknown } | null
        if (!body || (typeof body.hypothesis !== 'string' && body.hypothesis !== null)) return c.json({ error: 'Invalid body' }, 400)
        try {
            const hypothesis = ready.engine.getWorkLines().setHypothesis(ready.account.id, c.req.param('id'), body.hypothesis ?? '')
            touch(ready.account)
            return c.json({ lineId: c.req.param('id'), hypothesis })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/explorations/:id/sessions', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            const lineId = c.req.param('id')
            const sessions = ready.engine.getWorkLines().listLinkedSessions(ready.account.id, lineId)
                .filter((session) => canSeeSession(ready.account.id, session.sessionId))
            return c.json({ lineId, sessions })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.put('/explorations/:id/sessions/:sessionId', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const sessionId = c.req.param('sessionId')
        if (!canSeeSession(ready.account.id, sessionId)) return c.json({ error: 'Not found' }, 404)
        try {
            ready.engine.getWorkLines().putSession(ready.account.id, { sessionId, state: 'line', lineId: c.req.param('id') })
            touch(ready.account)
            return c.json({ lineId: c.req.param('id'), sessionId })
        } catch (error) {
            return mapError(c, error)
        }
    })
    routes.delete('/explorations/:id/sessions/:sessionId', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const sessionId = c.req.param('sessionId')
        if (!canSeeSession(ready.account.id, sessionId)) return c.json({ error: 'Not found' }, 404)
        try {
            ready.engine.getWorkLines().putSession(ready.account.id, { sessionId, state: 'follow', lineId: null })
            touch(ready.account)
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/explorations/:id/cards', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            const lineId = c.req.param('id')
            return c.json({ lineId, cards: ready.engine.getWorkLines().listVerificationCards(ready.account.id, lineId) })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.post('/explorations/:id/cards', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = cardSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const lineId = c.req.param('id')
            const bound = ready.engine.getWorkLines().bindTrainingLine(ready.account.id, {
                lineId,
                run: parsed.data.run,
                metrics: parsed.data.metrics,
                xAxis: parsed.data.xAxis,
                instanceId: parsed.data.cardId,
            })
            pushTrainingCard(ready.account.id, {
                lineId,
                run: parsed.data.run,
                metrics: storedTrainingMetrics(bound.layout, bound.instanceId),
                instanceId: bound.instanceId,
            })
            touch(ready.account, 'work-layout')
            const card = ready.engine.getWorkLines().listVerificationCards(ready.account.id, lineId)
                .find((item) => item.cardId === bound.instanceId)
            if (!card) return c.json({ error: 'Not found' }, 404)
            return c.json({ card })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.delete('/explorations/:id/cards/:cardId', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            const cards = ready.engine.getWorkLines().listVerificationCards(ready.account.id, c.req.param('id'))
            if (!cards.some((card) => card.cardId === c.req.param('cardId'))) return c.json({ error: 'Not found' }, 404)
            ready.engine.getWorkLines().unbindTrainingCard(ready.account.id, c.req.param('cardId'))
            touch(ready.account, 'work-layout')
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/explorations/:id/references', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            const lineId = c.req.param('id')
            return c.json({ lineId, references: ready.engine.getWorkLines().listReferences(ready.account.id, lineId) })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.post('/explorations/:id/references', async (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const parsed = referenceSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const reference = ready.engine.getWorkLines().addReference(ready.account.id, { lineId: c.req.param('id'), ...parsed.data })
            touch(ready.account)
            return c.json({ reference })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.delete('/explorations/:id/references/:referenceId', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        try {
            ready.engine.getWorkLines().removeReference(ready.account.id, c.req.param('id'), c.req.param('referenceId'))
            touch(ready.account)
            return c.json({ ok: true })
        } catch (error) {
            return mapError(c, error)
        }
    })

    routes.get('/session-line', (c) => {
        const ready = open(c)
        if (ready instanceof Response) return ready
        const sessionId = c.req.query('sessionId') || c.req.header('x-hapi-session-id') || ''
        if (sessionId && !canSeeSession(ready.account.id, sessionId)) return c.json({ error: 'Not found' }, 404)
        const machineId = c.req.query('machineId') ?? ''
        const path = c.req.query('path') ?? ''
        const lines = ready.engine.getWorkLines()
        const binding = sessionId ? lines.getSessionBinding(ready.account.id, sessionId) : null
        const lineId = binding ? binding.lineId : (machineId && path ? lines.lineForDirectory(ready.account.id, machineId, path) : null)
        return c.json({ lineId })
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

function explorationOf(line: WorkLine) {
    return {
        id: line.id,
        name: line.name,
        goal: line.goal,
        hypothesis: line.hypothesis,
        primaryMachineId: line.primaryMachineId,
        primaryPath: line.primaryPath,
        createdAt: line.createdAt,
        updatedAt: line.updatedAt,
    }
}
