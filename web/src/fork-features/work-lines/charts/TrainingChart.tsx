import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTranslation } from '@/lib/use-translation'
import { prepareTrainingPlot, type TrainingSeries } from '../trainingSeries'
import { pushTrainingChartData, type ZoomableChart } from './chartUpdate'

const STROKES = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2']
const SMOOTH_ALPHA = 0.6

function span(min: number, max: number, log: boolean): { min: number; max: number } {
    if (min !== max) return { min, max }
    return log ? { min: min / 2, max: min * 2 } : { min: min - 1, max: max + 1 }
}

export function TrainingChart(props: { series: TrainingSeries[] }): ReactNode {
    const { t } = useTranslation()
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
    const [smooth, setSmooth] = useState(false)
    const [log, setLog] = useState(false)
    const host = useRef<HTMLDivElement>(null)
    const chartRef = useRef<uPlot | null>(null)
    const zoomedRef = useRef(false)
    const prepared = useMemo(() => prepareTrainingPlot(props.series, {
        hidden,
        smooth,
        log,
        alpha: SMOOTH_ALPHA,
    }), [hidden, log, props.series, smooth])
    const preparedRef = useRef(prepared)
    preparedRef.current = prepared
    const shape = `${log ? 1 : 0}:${[...hidden].sort().join(',')}:${prepared.drawable.map((row) => row.id).join(',')}`

    useEffect(() => {
        const element = host.current
        if (!element || prepared.drawable.length === 0 || prepared.steps.length === 0) return
        const width = Math.max(element.clientWidth, 320)
        const data: uPlot.AlignedData = [prepared.steps, ...prepared.drawable.map((row) => row.values)]
        const chart = new uPlot({
            width,
            height: 280,
            scales: { x: { time: false }, y: log ? { distr: 3 } : {} },
            series: [
                {},
                ...prepared.drawable.map((row, index) => ({
                    label: row.name,
                    stroke: STROKES[index % STROKES.length],
                    width: 2,
                })),
            ],
            cursor: { drag: { x: true, y: true, setScale: true } },
            hooks: { setSelect: [() => { zoomedRef.current = true }] },
        }, data, element)
        chartRef.current = chart
        zoomedRef.current = false
        const reset = () => {
            zoomedRef.current = false
            const current = preparedRef.current
            const ys = current.drawable.flatMap((row) => row.values.filter((value): value is number => value != null))
            const xMin = current.steps[0] ?? 0
            const xMax = current.steps.at(-1) ?? xMin + 1
            const yMin = ys.length > 0 ? Math.min(...ys) : (log ? 1 : 0)
            const yMax = ys.length > 0 ? Math.max(...ys) : 1
            chart.setScale('x', span(xMin, xMax, false))
            chart.setScale('y', span(yMin, yMax, log))
        }
        element.addEventListener('dblclick', reset)
        const observer = new ResizeObserver(() => {
            chart.setSize({ width: Math.max(element.clientWidth, 320), height: 280 })
        })
        observer.observe(element)
        return () => {
            element.removeEventListener('dblclick', reset)
            observer.disconnect()
            chart.destroy()
            chartRef.current = null
        }
    }, [log, shape])

    useEffect(() => {
        const chart = chartRef.current
        if (!chart || prepared.steps.length === 0) return
        const data: uPlot.AlignedData = [prepared.steps, ...prepared.drawable.map((row) => row.values)]
        pushTrainingChartData(chart as unknown as ZoomableChart, data, zoomedRef.current)
    }, [prepared])

    const toggle = (id: string) => {
        setHidden((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    return (
        <div>
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--app-fg)]">
                {props.series.map((row) => (
                    <label key={row.id} className="flex items-center gap-1">
                        <input type="checkbox" checked={!hidden.has(row.id)} onChange={() => toggle(row.id)} />
                        {row.name}
                    </label>
                ))}
                <label className="flex items-center gap-1">
                    <input type="checkbox" checked={smooth} onChange={() => setSmooth((value) => !value)} />
                    {t('work.trainingSmooth')}
                </label>
                <label className="flex items-center gap-1">
                    <input type="checkbox" checked={log} onChange={() => setLog((value) => !value)} />
                    {t('work.trainingLog')}
                </label>
            </div>
            {log && prepared.dropped > 0 ? <p className="mb-2 text-xs text-[var(--app-hint)]">{t('work.trainingDropped', { count: prepared.dropped })}</p> : null}
            <div ref={host} />
            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('work.trainingZoom')}</p>
        </div>
    )
}
