import { describe, expect, it } from 'vitest'
import { CARD_POLL_MIN_MS, clampCardPollMs, bindTrainingSlot, mergeLayout, slotsForRegion, LAYOUT_REVISION, visiblePollInterval, type WorkLayout } from './layout'
import { workbenchLayout } from './defaultLayouts'

const defaults: WorkLayout = {
    revision: 1,
    regions: {
        stats: [{ cardId: 'overview.line-count' }, { cardId: 'overview.running-count' }],
        body: [{ cardId: 'overview.needs-you-list' }],
    },
}

describe('work layout', () => {
    it('drops an unknown id and a card in the wrong region', () => {
        const cards = new Map([
            ['overview.line-count', { size: 'stat' as const }],
            ['overview.needs-you-list', { size: 'full' as const }],
        ])
        const layout: WorkLayout = {
            revision: 1,
            regions: {
                stats: [{ cardId: 'overview.line-count' }, { cardId: 'missing' }, { cardId: 'overview.needs-you-list' }],
            },
        }
        expect(slotsForRegion(layout, 'stats', cards).map((slot) => slot.cardId)).toEqual(['overview.line-count'])
    })

    it('appends new default cards without reordering a saved layout', () => {
        const saved: WorkLayout = {
            revision: 0,
            regions: { stats: [{ cardId: 'overview.running-count' }, { cardId: 'overview.line-count' }] },
        }
        expect(mergeLayout(saved, defaults).regions.stats.map((slot) => slot.cardId)).toEqual([
            'overview.running-count',
            'overview.line-count',
        ])
        expect(mergeLayout(saved, defaults).regions.body.map((slot) => slot.cardId)).toEqual(['overview.needs-you-list'])
    })

    it('binds a run per line without using a dead default slot', () => {
        expect(workbenchLayout.regions.main.some((slot) => slot.cardId === 'example.training-curves')).toBe(false)
        const saved: WorkLayout = { revision: 1, regions: { main: [{ cardId: 'workbench.line-header' }] } }
        const merged = mergeLayout(saved, workbenchLayout)
        expect(merged.regions.main.map((slot) => slot.cardId)).not.toContain('example.training-curves')
        const bound = bindTrainingSlot(merged, 'line-1', 'exp-1')
        const both = bindTrainingSlot(bound, 'line-2', 'exp-2')
        expect(both.revision).toBe(LAYOUT_REVISION)
        expect(both.regions.main.filter((slot) => slot.cardId === 'example.training-curves' && slot.args?.lineId).map((slot) => slot.args)).toEqual([
            { run: 'exp-1', lineId: 'line-1' },
            { run: 'exp-2', lineId: 'line-2' },
        ])
    })

    it('clamps a short poll and stops it while the page is hidden', () => {
        expect(clampCardPollMs(1_000)).toBe(CARD_POLL_MIN_MS)
        expect(visiblePollInterval(1_000, false)).toBe(false)
        expect(visiblePollInterval(undefined, true)).toBe(false)
    })
})
