import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTranslation } from '@/lib/use-translation'
import { TRAINING_X_RUNTIME, TRAINING_X_STEP, TRAINING_X_WALL, prepareTrainingPlot, trainingCustomXAxes, trainingMetricSelection, type TrainingSeries } from '../trainingSeries'
import { pushTrainingChartData, type ZoomableChart } from './chartUpdate'

const STROKES = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2']
const SMOOTH_ALPHA = 0.6
const X_AXIS_STORAGE_KEY = 'hapi.training.xAxis'

function storedXAxis(): string {
    try {
        return window.localStorage.getItem(X_AXIS_STORAGE_KEY) || TRAINING_X_STEP
    } catch {
        return TRAINING_X_STEP
    }
}

function rememberXAxis(value: string): void {
    try {
        window.localStorage.setItem(X_AXIS_STORAGE_KEY, value)
    } catch {
        // Private mode or a full quota. The in-memory choice still applies.
    }
}
function span(min: number, max: number, log: boolean): { min: number; max: number } {
    if (min !== max) return { min, max }
    return log ? { min: min / 2, max: min * 2 } : { min: min - 1, max: max + 1 }
}

export function TrainingChart(props: { series: TrainingSeries[], xSource?: readonly TrainingSeries[] }): ReactNode {
    const { t } = useTranslation()
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
    const [smooth, setSmooth] = useState(false)
    const [log, setLog] = useState(false)
    const [xAxis, setXAxis] = useState(storedXAxis)
    const host = useRef<HTMLDivElement>(null)
    const metricsRef = useRef<HTMLDivElement>(null)
    const [metricsOpen, setMetricsOpen] = useState(false)
    const chartRef = useRef<uPlot | null>(null)
    const zoomedRef = useRef(false)
    const xSource = props.xSource ?? props.series
    const customX = trainingCustomXAxes(xSource)
    const xChoices = new Set<string>([TRAINING_X_STEP, TRAINING_X_RUNTIME, TRAINING_X_WALL, ...customX])
    const activeX = xChoices.has(xAxis) ? xAxis : TRAINING_X_STEP
    const prepared = useMemo(() => prepareTrainingPlot(props.series, {
        hidden,
        smooth,
        log,
        alpha: SMOOTH_ALPHA,
        xAxis: activeX,
        xSource,
    }), [activeX, hidden, log, props.series, smooth, xSource])
    const preparedRef = useRef(prepared)
    preparedRef.current = prepared
    const shape = `${activeX}:${log ? 1 : 0}:${[...hidden].sort().join(',')}:${prepared.drawable.map((row) => row.id).join(',')}`

    useEffect(() => {
        const element = host.current
        if (!element || prepared.drawable.length === 0 || prepared.steps.length === 0) return
        const width = Math.max(element.clientWidth, 320)
        const data: uPlot.AlignedData = [prepared.steps, ...prepared.drawable.map((row) => row.values)]
        const chart = new uPlot({
            width,
            height: 280,
            // _timestamp is wandb's unix seconds. uPlot time scale uses seconds.
            scales: { x: { time: activeX === TRAINING_X_WALL }, y: log ? { distr: 3 } : {} },
            axes: [
                { grid: { show: false } },
                { grid: { show: false } },
            ],
            series: [
                {},
                ...prepared.drawable.map((row, index) => ({
                    label: row.name,
                    stroke: STROKES[index % STROKES.length],
                    width: 2,
                    points: { show: false },
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

    useEffect(() => {
        if (!metricsOpen) return
        const close = (event: PointerEvent) => {
            if (!metricsRef.current?.contains(event.target as Node)) setMetricsOpen(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
    }, [metricsOpen])

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
                <label className="flex items-center gap-1">
                    {t('work.trainingXAxis')}
                    <select className="rounded border border-[var(--app-divider)] bg-transparent px-1 py-0.5" value={activeX} onChange={(event) => { setXAxis(event.target.value); rememberXAxis(event.target.value) }}>
                        <option value={TRAINING_X_STEP}>{t('work.trainingXStep')}</option>
                        <option value={TRAINING_X_RUNTIME}>{t('work.trainingXRuntime')}</option>
                        <option value={TRAINING_X_WALL}>{t('work.trainingXWall')}</option>
                        {customX.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                </label>
                <div className="relative" ref={metricsRef}>
                    <button
                        type="button"
                        aria-expanded={metricsOpen}
                        aria-haspopup="listbox"
                        className="rounded border border-[var(--app-divider)] bg-transparent px-1 py-0.5"
                        onClick={() => setMetricsOpen((open) => !open)}
                    >
                        {metricButtonLabel(props.series.filter((row) => !hidden.has(row.id)).map((row) => row.name), t)}
                    </button>
                    {metricsOpen ? (
                        <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg" role="listbox">
                            {props.series.map((row) => (
                                <label key={row.id} className="flex items-center gap-1 px-1 py-0.5">
                                    <input type="checkbox" checked={!hidden.has(row.id)} onChange={() => toggle(row.id)} />
                                    {row.name}
                                </label>
                            ))}
                        </div>
                    ) : null}
                </div>
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

function metricButtonLabel(names: readonly string[], t: (key: string, params?: Record<string, string | number>) => string): string {
    const selection = trainingMetricSelection(names)
    if (selection.kind === 'none') return t('work.trainingMetricsNone')
    if (selection.kind === 'names') return selection.text
    return t('work.trainingMetricsCount', { count: selection.count })
}
