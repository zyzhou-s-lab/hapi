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

export function smoothPoints(points: readonly TrainingPoint[], alpha: number): TrainingPoint[] {
    let previous: number | null = null
    return points.map((point) => {
        const value = previous == null ? point.value : alpha * point.value + (1 - alpha) * previous
        previous = value
        return { step: point.step, value }
    })
}

export function prepareTrainingPlot(series: readonly TrainingSeries[], options: {
    hidden: ReadonlySet<string>
    smooth: boolean
    log: boolean
    alpha: number
}): {
    steps: number[]
    drawable: { id: string; name: string; values: (number | null)[] }[]
    dropped: number
} {
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
        return { id: row.id, name: row.name, points }
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
