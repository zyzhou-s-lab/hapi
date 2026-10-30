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

    it('adds the training card to an older workbench layout and can bind a run', () => {
        expect(workbenchLayout.regions.main.some((slot) => slot.cardId === 'example.training-curves')).toBe(true)
        const saved: WorkLayout = { revision: 1, regions: { main: [{ cardId: 'workbench.line-header' }] } }
        const merged = mergeLayout(saved, workbenchLayout)
        expect(merged.regions.main.map((slot) => slot.cardId)).toContain('example.training-curves')
        const bound = bindTrainingSlot(merged, 'line-1', 'exp-1')
        expect(bound.revision).toBe(LAYOUT_REVISION)
        expect(bound.regions.main.find((slot) => slot.cardId === 'example.training-curves')?.args).toEqual({ run: 'exp-1', lineId: 'line-1' })
    })

    it('clamps a short poll and stops it while the page is hidden', () => {
        expect(clampCardPollMs(1_000)).toBe(CARD_POLL_MIN_MS)
        expect(visiblePollInterval(1_000, false)).toBe(false)
        expect(visiblePollInterval(undefined, true)).toBe(false)
    })
})
