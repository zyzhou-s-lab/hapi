export type ZoomableChart = {
    scales: Record<string, { min?: number; max?: number } | undefined>
    setData: (data: unknown, resetScales?: boolean) => void
    setScale: (key: string, limits: { min: number; max: number }) => void
}

export function pushTrainingChartData(chart: ZoomableChart, data: unknown, zoomed: boolean): void {
    if (!zoomed) {
        chart.setData(data)
        return
    }
    const x = chart.scales.x
    const y = chart.scales.y
    chart.setData(data, false)
    if (x?.min != null && x.max != null) chart.setScale('x', { min: x.min, max: x.max })
    if (y?.min != null && y.max != null) chart.setScale('y', { min: y.min, max: y.max })
}

export function trainingSeriesShowsPoints(values: ArrayLike<number | null | undefined> | undefined): boolean {
    if (!values) return true
    let count = 0
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]
        if (typeof value === 'number' && Number.isFinite(value)) {
            count += 1
            if (count >= 2) return false
        }
    }
    return true
}
