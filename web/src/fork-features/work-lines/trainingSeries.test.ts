import { describe, expect, it } from 'vitest'
import { applyTrainingBatch, prepareTrainingPlot, smoothPoints, type TrainingSeries } from './trainingSeries'
import { reduceTrainingDisconnect, reduceTrainingError, reduceTrainingFrame, emptyTrainingState, nextSubscribeDelay, trainingMessageKey } from '@/hooks/useTrainingSocket'
import { pushTrainingChartData } from './charts/chartUpdate'

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

    it('keeps the curve across a disconnect and appends the next history', () => {
        const live = reduceTrainingFrame(emptyTrainingState(), { run: 'exp-1', reset: true, batch: [{ step: 1, metric: 'loss', value: 0.2 }] })
        const failed = reduceTrainingError(live, 'Runner is not connected.')
        expect(failed.series).toEqual(live.series)
        expect(failed.status).toBe('reconnecting')
        expect(trainingMessageKey(failed.message)).toBe('work.trainingRunnerDown')
        const blip = reduceTrainingDisconnect(live)
        expect(blip.series).toEqual(live.series)
        expect(blip.status).toBe('reconnecting')
        const again = reduceTrainingFrame(blip, { run: 'exp-1', reset: true, batch: [{ step: 3, metric: 'loss', value: 0.1 }] })
        expect(again.series[0]?.points).toEqual([{ step: 1, value: 0.2 }, { step: 3, value: 0.1 }])
        const cleared = reduceTrainingFrame(again, { run: 'exp-1', reset: true })
        expect(cleared.series).toEqual([])
        expect(nextSubscribeDelay(0)).toBe(1000)
        expect(nextSubscribeDelay(3)).toBe(5000)
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

    it('updates the chart without resetting the zoom', () => {
        const scales = { x: { min: 2, max: 8 }, y: { min: 0.1, max: 0.4 } }
        const calls: unknown[] = []
        pushTrainingChartData({
            scales,
            setData: (_data, resetScales) => calls.push(['data', resetScales]),
            setScale: (key, limits) => calls.push(['scale', key, limits]),
        }, [[1, 2], [0.2, 0.1]])
        expect(calls).toEqual([
            ['data', false],
            ['scale', 'x', { min: 2, max: 8 }],
            ['scale', 'y', { min: 0.1, max: 0.4 }],
        ])
    })
})
