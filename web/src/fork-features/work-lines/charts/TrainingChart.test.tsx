import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { TrainingSeries } from '../trainingSeries'
import { TrainingChart } from './TrainingChart'
import { trainingHiddenStorageKey, trainingPrefId, trainingXAxisStorageKey } from './trainingPrefs'

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

function renderChart(instanceId = 'card-1', extra?: { xSource?: readonly TrainingSeries[]; xAxisDefault?: string }) {
    return render(
        <I18nProvider>
            <TrainingChart instanceId={instanceId} xAxisDefault={extra?.xAxisDefault} series={[loss, evalLoss]} xSource={extra?.xSource} />
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

    it('does not write storage when opened and clears the legacy axis key on a change', () => {
        localStorage.setItem('hapi.training.xAxis', 'epoch')
        const opened = renderChart()
        expect(localStorage.getItem('hapi.training.prefs')).toBeNull()
        expect(localStorage.getItem(trainingHiddenStorageKey(trainingPrefId('card-1')))).toBeNull()
        expect(localStorage.getItem('hapi.training.xAxis')).toBe('epoch')
        opened.unmount()
        renderChart()
        expect(localStorage.getItem('hapi.training.xAxis')).toBe('epoch')
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '_runtime' } })
        expect(localStorage.getItem('hapi.training.xAxis')).toBeNull()
        expect(localStorage.getItem(trainingXAxisStorageKey(trainingPrefId('card-1')))).toBe('_runtime')
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '_step' } })
        expect(localStorage.getItem(trainingXAxisStorageKey(trainingPrefId('card-1')))).toBeNull()
        expect(localStorage.getItem('hapi.training.prefs')).toBeNull()
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

    it('remembers hidden metrics and the x axis for that card only', () => {
        const first = renderChart('card-a')
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'eval' }))
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '_runtime' } })
        first.unmount()

        renderChart('card-a')
        fireEvent.click(screen.getByRole('button', { name: 'loss' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: 'loss' })).toBeChecked()
        expect(screen.getByRole('combobox')).toHaveValue('_runtime')
        expect(localStorage.getItem('hapi.training.xAxis')).toBeNull()
        expect(localStorage.getItem(trainingXAxisStorageKey(trainingPrefId('card-a')))).toBe('_runtime')
        cleanup()

        renderChart('card-b', {
            xAxisDefault: 'epoch',
            xSource: [loss, evalLoss, { id: 'epoch', name: 'epoch', points: [{ step: 1, value: 0 }, { step: 2, value: 1 }] }],
        })
        expect(screen.getByRole('combobox')).toHaveValue('epoch')
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).toBeChecked()
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
