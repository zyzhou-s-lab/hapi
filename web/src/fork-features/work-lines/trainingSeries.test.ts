import { describe, expect, it } from 'vitest'
import { applyTrainingBatch, prepareTrainingPlot, smoothPoints, type TrainingSeries } from './trainingSeries'
import { reduceTrainingFrame, emptyTrainingState } from '@/hooks/useTrainingSocket'

const loss: TrainingSeries = {
    id: 'loss',
    name: 'loss',
    points: [{ step: 1, value: 1 }, { step: 2, value: 0 }],
}

describe('training series', () => {
    it('replaces on history and overwrites the same step', () => {
        const replaced = applyTrainingBatch([loss], [{ step: 1, metric: 'acc', value: 0.1 }], true)
        expect(replaced).toEqual([{ id: 'acc', name: 'acc', points: [{ step: 1, value: 0.1 }] }])
        const updated = applyTrainingBatch(replaced, [{ step: 1, metric: 'acc', value: 0.4 }, { step: 2, metric: 'acc', value: 0.5 }], false)
        expect(updated[0]?.points).toEqual([{ step: 1, value: 0.4 }, { step: 2, value: 0.5 }])
    })

    it('clears points on an error and keeps a later history', () => {
        const live = reduceTrainingFrame(emptyTrainingState(), { run: 'exp-1', reset: true, batch: [{ step: 1, metric: 'loss', value: 0.2 }] })
        expect(live.series).toHaveLength(1)
        expect(live.status).toBe('live')
        const failed = { ...live, status: 'unavailable' as const, series: [], message: 'Runner is not connected.' }
        expect(failed.series).toEqual([])
        const again = reduceTrainingFrame(failed, { run: 'exp-1', reset: true, batch: [{ step: 3, metric: 'loss', value: 0.1 }] })
        expect(again.series[0]?.points).toEqual([{ step: 3, value: 0.1 }])
    })

    it('smooths a display copy and drops non-positive log points', () => {
        const smoothed = smoothPoints([{ step: 1, value: 1 }, { step: 2, value: 0 }], 0.6)
        expect(smoothed[0]?.value).toBe(1)
        expect(smoothed[1]?.value).toBeCloseTo(0.4)
        expect(loss.points[1]?.value).toBe(0)
        const plot = prepareTrainingPlot([loss, { id: 'acc', name: 'acc', points: [{ step: 1, value: -1 }] }], {
            hidden: new Set(['acc']),
            smooth: false,
            log: true,
            alpha: 0.6,
        })
        expect(plot.dropped).toBe(1)
        expect(plot.drawable).toEqual([{ id: 'loss', name: 'loss', values: [1] }])
        expect(plot.steps).toEqual([1])
    })
})
