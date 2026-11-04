import { describe, expect, it } from 'vitest'
import { EXPLORE_DELETE_CONFIRM_HEADER } from '@hapi/protocol'
import { NOT_ON_EXPLORATION_ERROR, callExploreTool, exploreToolSchemas, type ExploreTool } from './exploreMcp'
import type { WorkHub } from './trainingMcp'

function hub(routes: Record<string, { status: number; body: unknown }>): {
    client: WorkHub
    seen: string[]
    calls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string> } }>
} {
    const seen: string[] = []
    const calls: Array<{ path: string; init?: { method?: string; headers?: Record<string, string> } }> = []
    return {
        seen,
        calls,
        client: {
            request: async (path, init) => {
                const bare = path.split('?')[0] ?? path
                seen.push(bare)
                calls.push({ path: bare, init })
                const route = routes[bare]
                if (!route) return { status: 500, body: { error: `unexpected ${path}` } }
                return route
            },
        },
    }
}

describe('callExploreTool', () => {
    it('lists explorations without resolving the current session', async () => {
        const { client, seen } = hub({
            '/cli/work/explorations': { status: 200, body: { explorations: [] } },
        })
        const result = await callExploreTool(client, 'list_explorations', {}, { sessionId: 's1' })
        expect(result.isError).toBe(false)
        expect(seen).toEqual(['/cli/work/explorations'])
    })

    it('reads the hypothesis of the exploration this session belongs to', async () => {
        const { client, seen } = hub({
            '/cli/work/session-line': { status: 200, body: { lineId: 'line-1' } },
            '/cli/work/explorations/line-1': { status: 200, body: { exploration: { hypothesis: 'one idea' } } },
        })
        const result = await callExploreTool(client, 'get_hypothesis' satisfies ExploreTool, {}, { sessionId: 's1' })
        expect(result).toEqual({ text: JSON.stringify({ lineId: 'line-1', hypothesis: 'one idea' }), isError: false })
        expect(seen).toEqual(['/cli/work/session-line', '/cli/work/explorations/line-1'])
    })

    it('refuses a line-scoped tool when the session is not on an exploration', async () => {
        const { client } = hub({
            '/cli/work/session-line': { status: 200, body: { lineId: null } },
        })
        const result = await callExploreTool(client, 'get_hypothesis', {}, { sessionId: 's1' })
        expect(result).toEqual({ text: NOT_ON_EXPLORATION_ERROR, isError: true })
        expect(exploreToolSchemas.link_session.safeParse({}).success).toBe(false)
        expect(exploreToolSchemas.link_session.safeParse({ lineId: 'line-1' }).success).toBe(true)
    })

    it('sends the delete confirmation header', async () => {
        const { client, calls } = hub({
            '/cli/work/explorations/line-1': { status: 200, body: { ok: true } },
        })
        const result = await callExploreTool(client, 'delete_exploration', { lineId: 'line-1' }, {})
        expect(result.isError).toBe(false)
        expect(EXPLORE_DELETE_CONFIRM_HEADER).toBe('x-hapi-explore-delete-confirm')
        expect(calls).toEqual([{
            path: '/cli/work/explorations/line-1',
            init: { method: 'DELETE', headers: { 'x-hapi-explore-delete-confirm': '1' } },
        }])
    })
})
