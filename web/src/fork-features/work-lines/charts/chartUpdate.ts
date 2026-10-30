export type ZoomableChart = {
    scales: Record<string, { min?: number; max?: number } | undefined>
    setData: (data: unknown, resetScales?: boolean) => void
    setScale: (key: string, limits: { min: number; max: number }) => void
}

export function pushTrainingChartData(chart: ZoomableChart, data: unknown): void {
    const x = chart.scales.x
    const y = chart.scales.y
    chart.setData(data, false)
    if (x?.min != null && x.max != null) chart.setScale('x', { min: x.min, max: x.max })
    if (y?.min != null && y.max != null) chart.setScale('y', { min: y.min, max: y.max })
}
