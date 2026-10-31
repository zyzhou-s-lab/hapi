export type TrainingPoint = { step: number; value: number }

export type TrainingSeries = {
    id: string
    name: string
    points: TrainingPoint[]
}

export type TrainingBatchPoint = { step: number; metric: string; value: number }

export function applyTrainingBatch(series: TrainingSeries[], batch: TrainingBatchPoint[] | undefined, reset: boolean): TrainingSeries[] {
    const next = reset ? [] : series.map((row) => ({ ...row, points: row.points.slice() }))
    for (const point of batch ?? []) {
        if (!Number.isFinite(point.step) || !Number.isFinite(point.value) || point.metric.length === 0) continue
        let row = next.find((item) => item.id === point.metric)
        if (!row) {
            row = { id: point.metric, name: point.metric, points: [] }
            next.push(row)
        }
        const index = row.points.findIndex((item) => item.step === point.step)
        if (index >= 0) row.points[index] = { step: point.step, value: point.value }
        else row.points.push({ step: point.step, value: point.value })
        row.points.sort((left, right) => left.step - right.step)
    }
    return next
}

export function trainingMetricsFromArgs(args: Record<string, string> | undefined): string[] | null {
    const raw = args?.metrics
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return null
        const names = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
        return names.length > 0 ? names : null
    } catch {
        return null
    }
}

export function filterTrainingSeries(series: readonly TrainingSeries[], metrics: string[] | null): TrainingSeries[] {
    if (!metrics) return [...series]
    const allowed = new Set(metrics)
    return series.filter((row) => allowed.has(row.id))
}

export function smoothPoints(points: readonly TrainingPoint[], alpha: number): TrainingPoint[] {
    let previous: number | null = null
    return points.map((point) => {
        const value = previous == null ? point.value : alpha * point.value + (1 - alpha) * previous
        previous = value
        return { step: point.step, value }
    })
}

export const TRAINING_X_STEP = '_step'
export const TRAINING_X_RUNTIME = '_runtime'
export const TRAINING_X_WALL = '_timestamp'

export function trainingCustomXAxes(series: readonly TrainingSeries[]): string[] {
    return series
        .filter((row) => row.id.length > 0 && !row.id.startsWith('_') && row.points.length > 0)
        .map((row) => row.id)
}

export function prepareTrainingPlot(series: readonly TrainingSeries[], options: {
    hidden: ReadonlySet<string>
    smooth: boolean
    log: boolean
    alpha: number
    xAxis?: string
    xSource?: readonly TrainingSeries[]
}): {
    steps: number[]
    drawable: { id: string; name: string; values: (number | null)[] }[]
    dropped: number
} {
    const xAxis = options.xAxis && options.xAxis.length > 0 ? options.xAxis : TRAINING_X_STEP
    const xByStep = new Map<number, number>()
    if (xAxis !== TRAINING_X_STEP) {
        const source = options.xSource ?? series
        for (const point of source.find((row) => row.id === xAxis)?.points ?? []) {
            if (Number.isFinite(point.value)) xByStep.set(point.step, point.value)
        }
    }
    let dropped = 0
    const visible = series.filter((row) => !options.hidden.has(row.id)).map((row) => {
        let points = row.points
        if (options.smooth) points = smoothPoints(points, options.alpha)
        if (options.log) {
            const kept: TrainingPoint[] = []
            for (const point of points) {
                if (point.value > 0) kept.push(point)
                else dropped += 1
            }
            points = kept
        }
        const plotted = points.flatMap((point) => {
            const x = xAxis === TRAINING_X_STEP ? point.step : xByStep.get(point.step)
            return x == null || !Number.isFinite(x) ? [] : [{ step: x, value: point.value }]
        })
        return { id: row.id, name: row.name, points: plotted }
    })
    const steps = [...new Set(visible.flatMap((row) => row.points.map((point) => point.step)))].sort((left, right) => left - right)
    return {
        steps,
        dropped,
        drawable: visible.map((row) => {
            const byStep = new Map(row.points.map((point) => [point.step, point.value]))
            return {
                id: row.id,
                name: row.name,
                values: steps.map((step) => byStep.get(step) ?? null),
            }
        }),
    }
}
