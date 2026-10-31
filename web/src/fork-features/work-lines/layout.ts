export const LAYOUT_REVISION = 2
export const CARD_POLL_MIN_MS = 5_000

export type WorkSurface = 'overview' | 'workbench'
export type WorkCardSize = 'stat' | 'full' | 'rail' | 'main' | 'side'

export type WorkLayoutSlot = {
    cardId: string
    args?: Record<string, string>
}

export type WorkLayout = {
    revision: number
    regions: Record<string, WorkLayoutSlot[]>
}

const REGION_SIZE = {
    stats: 'stat',
    body: 'full',
    rail: 'rail',
    main: 'main',
    side: 'side',
} as const

export type WorkRegion = keyof typeof REGION_SIZE

export function regionSize(region: string): WorkCardSize | null {
    return region in REGION_SIZE ? REGION_SIZE[region as WorkRegion] : null
}

export function clampCardPollMs(pollMs: number | undefined): number | false {
    if (pollMs == null) return false
    if (pollMs < CARD_POLL_MIN_MS && import.meta.env.DEV) {
        console.warn(`card pollMs ${pollMs} clamped to ${CARD_POLL_MIN_MS}`)
    }
    return Math.max(pollMs, CARD_POLL_MIN_MS)
}

export function visiblePollInterval(pollMs: number | undefined, visible: boolean): number | false {
    const clamped = clampCardPollMs(pollMs)
    if (clamped === false || !visible) return false
    return clamped
}

export function mergeLayout(saved: WorkLayout | null, defaults: WorkLayout): WorkLayout {
    if (!saved) return defaults
    if (saved.revision >= LAYOUT_REVISION) return saved
    const regions: Record<string, WorkLayoutSlot[]> = {}
    for (const [region, fallback] of Object.entries(defaults.regions)) {
        const current = saved.regions[region] ?? []
        const seen = new Set(current.map((slot) => slot.cardId))
        regions[region] = [
            ...current,
            ...fallback.filter((slot) => !seen.has(slot.cardId)),
        ]
    }
    return { revision: saved.revision, regions }
}

export function bindTrainingSlot(layout: WorkLayout, input: { lineId: string; run: string; instanceId: string; xAxis?: string; metrics?: string }): WorkLayout {
    const main = layout.regions.main ?? []
    const index = main.findIndex((item) => item.cardId === 'example.training-curves' && item.args?.instanceId === input.instanceId)
    const args: Record<string, string> = { ...(index >= 0 ? main[index]?.args : {}), run: input.run, lineId: input.lineId, instanceId: input.instanceId }
    if (input.metrics && input.metrics.length > 0) args.metrics = input.metrics
    else delete args.metrics
    if (input.xAxis && input.xAxis.length > 0) args.xAxis = input.xAxis
    const slot = { cardId: 'example.training-curves', args }
    const next = index >= 0 ? main.map((item, itemIndex) => itemIndex === index ? slot : item) : [...main, slot]
    return { revision: LAYOUT_REVISION, regions: { ...layout.regions, main: next } }
}

export function ensureTrainingSlot(layout: WorkLayout, lineId: string): WorkLayout {
    if (!lineId) return layout
    const main = layout.regions.main ?? []
    if (main.some((item) => item.cardId === 'example.training-curves' && item.args?.lineId === lineId)) return layout
    return {
        ...layout,
        regions: { ...layout.regions, main: [...main, { cardId: 'example.training-curves', args: { lineId } }] },
    }
}

export function slotsForRegion(
    layout: WorkLayout,
    region: string,
    cards: ReadonlyMap<string, { size: WorkCardSize }>,
): WorkLayoutSlot[] {
    const expected = regionSize(region)
    if (!expected) return []
    return (layout.regions[region] ?? []).filter((slot) => cards.get(slot.cardId)?.size === expected)
}
