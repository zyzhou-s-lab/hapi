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

export function trainingMetricSelection(names: readonly string[]): { kind: 'none' } | { kind: 'names', text: string } | { kind: 'count', count: number } {
    if (names.length === 0) return { kind: 'none' }
    if (names.length <= 2) return { kind: 'names', text: names.join(', ') }
    return { kind: 'count', count: names.length }
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
    pointsOnly: boolean
} {
    const xAxis = options.xAxis && options.xAxis.length > 0 ? options.xAxis : TRAINING_X_STEP
    const pointsOnly = xAxis !== TRAINING_X_STEP && xAxis !== TRAINING_X_RUNTIME && xAxis !== TRAINING_X_WALL
    const xByStep = new Map<number, number>()
    if (xAxis !== TRAINING_X_STEP) {
        const source = options.xSource ?? series
        for (const point of source.find((row) => row.id === xAxis)?.points ?? []) {
            if (Number.isFinite(point.value)) xByStep.set(point.step, point.value)
        }
    }
    const xFor = (step: number): number | undefined => xAxis === TRAINING_X_STEP ? step : xByStep.get(step)
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
        return {
            id: row.id,
            name: row.name,
            points: points.flatMap((point) => {
                const x = xFor(point.step)
                return x == null || !Number.isFinite(x) ? [] : [{ step: point.step, x, value: point.value }]
            }),
        }
    })
    const byStep = visible.map((row) => new Map(row.points.map((point) => [point.step, point.value])))
    const orders = [...new Set(visible.flatMap((row) => row.points.map((point) => point.step)))].sort((left, right) => left - right)
    if (pointsOnly) {
        const tuples = orders.flatMap((step) => {
            const x = xByStep.get(step)
            if (x == null || !Number.isFinite(x)) return []
            return [{ step, x, values: byStep.map((values) => values.get(step) ?? null) }]
        })
        tuples.sort((left, right) => left.x - right.x || left.step - right.step)
        return {
            pointsOnly: true,
            steps: tuples.map((tuple) => tuple.x),
            dropped,
            drawable: visible.map((row, index) => ({
                id: row.id,
                name: row.name,
                values: tuples.map((tuple) => tuple.values[index] ?? null),
            })),
        }
    }
    const steps: number[] = []
    const seen = new Set<number>()
    for (const step of orders) {
        const x = xFor(step)
        if (x == null || seen.has(x)) continue
        seen.add(x)
        steps.push(x)
    }
    steps.sort((left, right) => left - right)
    return {
        pointsOnly: false,
        steps,
        dropped,
        drawable: visible.map((row, index) => {
            const valueByX = new Map<number, number | null>()
            for (const step of orders) {
                const x = xFor(step)
                if (x == null) continue
                const value = byStep[index]?.get(step) ?? null
                if (!valueByX.has(x) || value != null) valueByX.set(x, value)
            }
            return { id: row.id, name: row.name, values: steps.map((step) => valueByX.get(step) ?? null) }
        }),
    }
}
