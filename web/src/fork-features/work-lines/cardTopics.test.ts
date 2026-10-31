import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { applyCardInvalidated, refetchWatchedCardTopics, watchCardTopic } from './cardTopics'

describe('card topics', () => {
    it('invalidates only the query registered for that account and topic', () => {
        const queryClient = new QueryClient()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
        const stop = watchCardTopic('work-map', 7, ['work', 'map'])
        const stopLayout = watchCardTopic('work-layout', 7, ['work', 'layout'])
        applyCardInvalidated(queryClient, { accountId: 7, topic: 'work-map' })
        applyCardInvalidated(queryClient, { accountId: 8, topic: 'work-map' })
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work', 'map'] })
        stop()
        stopLayout()
        expect(invalidate).toHaveBeenCalledTimes(1)
    })

    it('refetches only the signed-in account after reconnect', () => {
        const queryClient = new QueryClient()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
        const stopMine = watchCardTopic('work-map', 7, ['work', 'map'])
        const stopOther = watchCardTopic('work-map', 8, ['work', 'map', 8])
        refetchWatchedCardTopics(queryClient, 7)
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work', 'map'] })
        stopMine()
        stopOther()
    })
})
