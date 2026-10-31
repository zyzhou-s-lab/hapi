import { describe, expect, it } from 'vitest'
import { applyTrainingBatch, filterTrainingSeries, prepareTrainingPlot, smoothPoints, trainingCustomXAxes, trainingCustomXReordered, trainingMetricSelection, trainingMetricsFromArgs, type TrainingSeries } from './trainingSeries'
import { pushTrainingChartData, trainingSeriesShowsPoints } from './charts/chartUpdate'
import { reduceTrainingDisconnect, reduceTrainingError, reduceTrainingFrame, emptyTrainingState, nextSubscribeDelay, trainingMessageKey } from '@/hooks/useTrainingSocket'

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

    it('keeps every series when the card metrics field is empty', () => {
        expect(trainingMetricsFromArgs(undefined)).toBeNull()
        expect(trainingMetricsFromArgs({ metrics: '[]' })).toBeNull()
        expect(trainingMetricsFromArgs({ metrics: '["loss"]' })).toEqual(['loss'])
        expect(filterTrainingSeries([loss, { id: 'acc', name: 'acc', points: [] }], ['loss']).map((row) => row.id)).toEqual(['loss'])
        expect(filterTrainingSeries([loss], null)).toEqual([loss])
    })

    it('keeps the curve across a disconnect and appends the next history', () => {
        const live = reduceTrainingFrame(emptyTrainingState(), { run: 'exp-1', reset: true, batch: [{ step: 1, metric: 'loss', value: 0.2 }] })
        const failed = reduceTrainingError(live, 'Runner is not connected.')
        expect(failed.series).toEqual(live.series)
        expect(failed.status).toBe('reconnecting')
        expect(trainingMessageKey(failed.message)).toBe('work.trainingRunnerDown')
        const permanent = reduceTrainingError(live, 'wandb is not available')
        expect(permanent.status).toBe('unavailable')
        const blip = reduceTrainingDisconnect(live)
        expect(blip.series).toEqual(live.series)
        const again = reduceTrainingFrame(blip, { run: 'exp-1', reset: true, batch: [{ step: 3, metric: 'loss', value: 0.1 }] })
        expect(again.series[0]?.points).toEqual([{ step: 1, value: 0.2 }, { step: 3, value: 0.1 }])
        expect(reduceTrainingFrame(again, { run: 'exp-1', reset: true }).series).toEqual([])
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

    it('uses a logged numeric metric as the x axis', () => {
        const plot = prepareTrainingPlot([
            { id: 'loss', name: 'loss', points: [{ step: 1, value: 0.5 }, { step: 2, value: 0.2 }] },
        ], {
            hidden: new Set(),
            smooth: false,
            log: false,
            alpha: 0.6,
            xAxis: 'epoch',
            xSource: [
                { id: 'loss', name: 'loss', points: [{ step: 1, value: 0.5 }, { step: 2, value: 0.2 }] },
                { id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }, { step: 2, value: 1 }] },
                { id: '_runtime', name: '_runtime', points: [{ step: 1, value: 3 }, { step: 2, value: 9 }] },
            ],
        })
        expect(plot.steps).toEqual([0, 1])
        expect(plot.drawable).toEqual([{ id: 'loss', name: 'loss', values: [0.5, 0.2] }])
        expect(trainingCustomXAxes([
            { id: '_runtime', name: '_runtime', points: [{ step: 1, value: 3 }] },
            { id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }] },
        ])).toEqual(['epoch'])
        const repeated = prepareTrainingPlot([
            { id: 'loss', name: 'loss', points: [{ step: 1, value: 0.5 }, { step: 2, value: 0.4 }, { step: 3, value: 0.3 }] },
        ], {
            hidden: new Set(),
            smooth: false,
            log: false,
            alpha: 0.6,
            xAxis: 'lr',
            xSource: [
                { id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.1 }, { step: 3, value: 0.01 }] },
            ],
        })
        expect(repeated.steps).toEqual([0.01, 0.1, 0.1])
        expect(repeated.drawable[0]?.values).toEqual([0.3, 0.5, 0.4])
        const decay = prepareTrainingPlot([
            { id: 'loss', name: 'loss', points: [{ step: 1, value: 0.9 }, { step: 2, value: 0.5 }, { step: 3, value: 0.2 }] },
        ], {
            hidden: new Set(),
            smooth: false,
            log: false,
            alpha: 0.6,
            xAxis: 'lr',
            xSource: [
                { id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.05 }, { step: 3, value: 0.01 }] },
            ],
        })
        expect(decay.steps).toEqual([0.01, 0.05, 0.1])
        expect(decay.drawable[0]?.values).toEqual([0.2, 0.5, 0.9])
    })

    it('leaves null gaps where a sparse metric has no sample', () => {
        const sparse = prepareTrainingPlot([
            { id: 'loss', name: 'loss', points: [{ step: 1, value: 1 }, { step: 2, value: 0.5 }, { step: 3, value: 0.2 }] },
            { id: 'eval', name: 'eval', points: [{ step: 2, value: 0.4 }] },
        ], {
            hidden: new Set(),
            smooth: false,
            log: false,
            alpha: 0.6,
        })
        expect(sparse.steps).toEqual([1, 2, 3])
        expect(sparse.drawable.map((row) => row.values)).toEqual([
            [1, 0.5, 0.2],
            [null, 0.4, null],
        ])
        const custom = prepareTrainingPlot([
            { id: 'loss', name: 'loss', points: [{ step: 1, value: 1 }, { step: 2, value: 0.5 }, { step: 3, value: 0.2 }] },
            { id: 'eval', name: 'eval', points: [{ step: 1, value: 0.8 }, { step: 3, value: 0.3 }] },
        ], {
            hidden: new Set(),
            smooth: false,
            log: false,
            alpha: 0.6,
            xAxis: 'epoch',
            xSource: [
                { id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }, { step: 2, value: 1 }, { step: 3, value: 2 }] },
            ],
        })
        expect(custom.steps).toEqual([0, 1, 2])
        expect(custom.drawable.find((row) => row.id === 'eval')?.values).toEqual([0.8, null, 0.3])
    })

    it('marks only a direction-changing custom axis as reordered', () => {
        const epoch = [{ id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }, { step: 2, value: 1 }, { step: 3, value: 2 }] }]
        const decay = [{ id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.05 }, { step: 3, value: 0.01 }] }]
        const bump = [{ id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.01 }, { step: 3, value: 0.05 }] }]
        expect(trainingCustomXReordered(epoch, 'epoch')).toBe(false)
        expect(trainingCustomXReordered(decay, 'lr')).toBe(false)
        expect(trainingCustomXReordered(bump, 'lr')).toBe(true)
        expect(trainingCustomXReordered(bump, '_step')).toBe(false)
        expect(trainingSeriesShowsPoints([null, 0.4, null])).toBe(true)
        expect(trainingSeriesShowsPoints([1, 0.5, 0.2])).toBe(false)
        expect(trainingSeriesShowsPoints([1, null, 2])).toBe(false)
    })

    it('names one or two selected metrics and counts the rest', () => {
        expect(trainingMetricSelection([])).toEqual({ kind: 'none' })
        expect(trainingMetricSelection(['loss'])).toEqual({ kind: 'names', text: 'loss' })
        expect(trainingMetricSelection(['loss', 'lr'])).toEqual({ kind: 'names', text: 'loss, lr' })
        expect(trainingMetricSelection(['loss', 'lr', 'epoch'])).toEqual({ kind: 'count', count: 3 })
    })

    it('auto-scales until the user zooms', () => {
        const scales = { x: { min: 2, max: 8 }, y: { min: 0.1, max: 0.4 } }
        const calls: unknown[] = []
        const chart = {
            scales,
            setData: (_data: unknown, resetScales?: boolean) => calls.push(['data', resetScales]),
            setScale: (key: string, limits: { min: number; max: number }) => calls.push(['scale', key, limits]),
        }
        pushTrainingChartData(chart, [[1]], false)
        expect(calls).toEqual([['data', undefined]])
        calls.length = 0
        pushTrainingChartData(chart, [[1, 2]], true)
        expect(calls).toEqual([
            ['data', false],
            ['scale', 'x', { min: 2, max: 8 }],
            ['scale', 'y', { min: 0.1, max: 0.4 }],
        ])
    })
})
