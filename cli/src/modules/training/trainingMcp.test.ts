import { describe, expect, it } from 'vitest'
import { bindTrainingCard, formatWorkResult, queryTrainingRun, registerTrainingRun, type WorkHub } from './trainingMcp'

function hub(status: number, body: unknown, seen: { path: string; method?: string; body?: unknown }[]): WorkHub {
    return {
        async request(path, init) {
            seen.push({ path, method: init?.method, body: init?.body })
            return { status, body }
        },
    }
}

describe('training MCP hub calls', () => {
    it('registers, queries, and binds through the work API', async () => {
        const seen: { path: string; method?: string; body?: unknown }[] = []
        const client = hub(200, { ok: true }, seen)
        await registerTrainingRun(client, { run: 'exp-1', machineId: 'gpu', runDir: '/data/wandb/offline-run-1' })
        await queryTrainingRun(client, 'exp/1')
        await bindTrainingCard(client, { lineId: 'line-1', run: 'exp-1', metrics: ['loss'] })
        expect(seen).toEqual([
            { path: '/api/work/training-runs', method: 'POST', body: { run: 'exp-1', machineId: 'gpu', runDir: '/data/wandb/offline-run-1' } },
            { path: '/api/work/training-runs/exp%2F1', method: undefined, body: undefined },
            { path: '/api/work/layout/workbench/training', method: 'PUT', body: { lineId: 'line-1', run: 'exp-1', metrics: ['loss'] } },
        ])
        expect(formatWorkResult(404, { error: '训练不存在' })).toEqual({ text: '训练不存在', isError: true })
        expect(formatWorkResult(200, { metrics: ['loss'] }).isError).toBe(false)
    })
})
