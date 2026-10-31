import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { TrainingSeries } from '../trainingSeries'
import { TrainingChart } from './TrainingChart'

type ChartCall = {
    series?: Array<{ spanGaps?: boolean; points?: { show?: boolean } }>
    data?: unknown[]
}

const chartCalls = vi.hoisted(() => [] as ChartCall[])

vi.mock('uplot', () => {
    class FakeUPlot {
        constructor(opts: { series?: ChartCall['series'] }, data: unknown[]) {
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

function renderChart(run = 'exp-1', extra?: { xSource?: readonly TrainingSeries[] }) {
    return render(
        <I18nProvider>
            <TrainingChart run={run} series={[loss, evalLoss]} xSource={extra?.xSource} />
        </I18nProvider>,
    )
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

    it('connects a sparse metric across nulls without drawing points', () => {
        renderChart()
        const call = chartCalls[0]
        expect(call?.data?.[2]).toEqual([null, 0.4, null])
        expect(call?.series?.slice(1)).toEqual([
            expect.objectContaining({ spanGaps: true, points: { show: false }, label: 'loss' }),
            expect.objectContaining({ spanGaps: true, points: { show: false }, label: 'eval' }),
        ])
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

    it('remembers hidden metrics and the x axis for that run only', () => {
        const first = renderChart('exp-1')
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'eval' }))
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '_runtime' } })
        first.unmount()

        renderChart('exp-1')
        fireEvent.click(screen.getByRole('button', { name: 'loss' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: 'loss' })).toBeChecked()
        expect(screen.getByRole('combobox')).toHaveValue('_runtime')
        expect(localStorage.getItem('hapi.training.xAxis')).toBeNull()
        cleanup()

        renderChart('exp-2')
        fireEvent.click(screen.getByRole('button', { name: 'loss, eval' }))
        expect(screen.getByRole('checkbox', { name: 'eval' })).toBeChecked()
        expect(screen.getByRole('combobox')).toHaveValue('_step')
    })

    it('explains that a custom axis is drawn in sorted order', () => {
        renderChart('exp-1', {
            xSource: [
                loss,
                evalLoss,
                { id: 'lr', name: 'lr', points: [{ step: 1, value: 0.1 }, { step: 2, value: 0.01 }, { step: 3, value: 0.05 }] },
            ],
        })
        const select = screen.getByRole('combobox')
        expect(select.getAttribute('title')).toBeNull()
        fireEvent.change(select, { target: { value: 'lr' } })
        expect(screen.getByRole('combobox').getAttribute('title')).toBe('A non-monotonic custom axis is plotted in sorted order.')
    })
})
