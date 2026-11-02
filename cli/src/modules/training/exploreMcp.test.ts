import { describe, expect, it } from 'vitest'
import { callExploreTool, type ExploreTool } from './exploreMcp'
import type { WorkHub } from './trainingMcp'

function hub(routes: Record<string, { status: number; body: unknown }>): { client: WorkHub; seen: string[] } {
    const seen: string[] = []
    return {
        seen,
        client: {
            request: async (path) => {
                seen.push(path.split('?')[0] ?? path)
                const route = routes[path.split('?')[0] ?? path]
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
        expect(result).toEqual({ text: 'this session is not on an exploration', isError: true })
    })
})
