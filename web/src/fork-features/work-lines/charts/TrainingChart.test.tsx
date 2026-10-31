import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { TrainingSeries } from '../trainingSeries'
import { TrainingChart } from './TrainingChart'
import { trainingPrefId, trainingXAxisStorageKey } from './trainingPrefs'

type PointShow = (chart: { data: ArrayLike<ArrayLike<number | null | undefined> | undefined> }, seriesIdx: number, idx0: number, idx1: number) => boolean | undefined

type ChartCall = {
    series?: Array<{ spanGaps?: boolean; label?: string; points?: { show?: boolean | PointShow } }>
    data?: ArrayLike<ArrayLike<number | null | undefined> | undefined>
}

const chartCalls = vi.hoisted(() => [] as ChartCall[])

vi.mock('uplot', () => {
    class FakeUPlot {
        constructor(opts: { series?: ChartCall['series'] }, data: ChartCall['data']) {
            chartCalls.push({ series: opts.series, data })
        }
        destroy() {}
        setData() {}
        setSize() {}
        setScale() {}
    }
    return { default: FakeUPlot }
})

const loss: TrainingSeries = {
    id: 'loss',
    name: 'loss',
    points: [{ step: 1, value: 1 }, { step: 2, value: 0.5 }, { step: 3, value: 0.2 }],
}
const evalLoss: TrainingSeries = {
    id: 'eval',
    name: 'eval',
    points: [{ step: 2, value: 0.4 }],
}

function renderChart(run = 'exp-1', extra?: { lineId?: string; xSource?: readonly TrainingSeries[] }) {
    return render(
        <I18nProvider>
            <TrainingChart run={run} lineId={extra?.lineId ?? 'line-1'} series={[loss, evalLoss]} xSource={extra?.xSource} />
        </I18nProvider>,
    )
}

function showPoints(show: boolean | PointShow | undefined, data: ChartCall['data'], seriesIdx: number): boolean | undefined {
    if (typeof show !== 'function' || !data) return undefined
    return show({ data }, seriesIdx, 0, data.length)
}

describe('TrainingChart', () => {
    beforeAll(() => {
        if (!('ResizeObserver' in globalThis)) {
            globalThis.ResizeObserver = class {
                observe() {}
                unobserve() {}
                disconnect() {}
            } as typeof ResizeObserver
        }
    })

    afterEach(() => {
        cleanup()
        localStorage.clear()
        chartCalls.length = 0
    })

    it('draws a lone sample and keeps spanGaps for a richer series', () => {
        renderChart()
        const call = chartCalls[0]
        expect(call?.data?.[2]).toEqual([null, 0.4, null])
        expect(call?.series?.[1]).toMatchObject({ spanGaps: true, label: 'loss' })
        expect(call?.series?.[2]).toMatchObject({ spanGaps: true, label: 'eval' })
        expect(showPoints(call?.series?.[1]?.points?.show, call?.data, 1)).toBe(false)
        expect(showPoints(call?.series?.[2]?.points?.show, call?.data, 2)).toBe(true)
    })

    it('asks for a metric when every series is hidden', () => {
        renderChart()
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'loss' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'eval' }))
        expect(screen.getByText('Select a metric.')).toBeTruthy()
    })

    it('uses a checkbox group and closes it on Escape', () => {
        renderChart()
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        expect(screen.getByRole('group')).toBeTruthy()
        expect(screen.queryByRole('listbox')).toBeNull()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('group')).toBeNull()
        expect(screen.queryByRole('checkbox', { name: 'loss' })).toBeNull()
    })

    it('remembers hidden metrics and the x axis for that line and run only', () => {
        const first = renderChart('exp-1', { lineId: 'line-1' })
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'eval' }))
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '_runtime' } })
        first.unmount()

        renderChart('exp-1', { lineId: 'line-1' })
        fireEvent.click(screen.getByRole('button', { name: 'loss' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: 'loss' })).toBeChecked()
        expect(screen.getByRole('combobox')).toHaveValue('_runtime')
        expect(localStorage.getItem('hapi.training.xAxis')).toBeNull()
        expect(localStorage.getItem('hapi.training.xAxis:exp-1')).toBeNull()
        expect(localStorage.getItem(trainingXAxisStorageKey(trainingPrefId('line-1', 'exp-1')))).toBe('_runtime')
        cleanup()

        renderChart('exp-1', { lineId: 'line-2' })
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).toBeChecked()
        expect(screen.getByRole('combobox')).toHaveValue('_step')
    })

    it('explains a custom axis only when its values change direction', () => {
        renderChart('exp-1', {
            xSource: [
                loss,
                evalLoss,
                { id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }, { step: 2, value: 1 }, { step: 3, value: 2 }] },
                { id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.01 }, { step: 3, value: 0.05 }] },
            ],
        })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'epoch' } })
        expect(screen.getByRole('combobox').getAttribute('title')).toBeNull()
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lr' } })
        expect(screen.getByRole('combobox').getAttribute('title')).toBe('A non-monotonic custom axis is plotted in sorted order.')
    })
})
