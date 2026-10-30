import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { applyCardInvalidated, watchCardTopic } from './cardTopics'

describe('card topics', () => {
    it('invalidates only the query registered for that account and topic', () => {
        const queryClient = new QueryClient()
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
        const stop = watchCardTopic('work-map', 7, ['work', 'map'])
        watchCardTopic('work-layout', 7, ['work', 'layout'])
        applyCardInvalidated(queryClient, { accountId: 7, topic: 'work-map' })
        applyCardInvalidated(queryClient, { accountId: 8, topic: 'work-map' })
        expect(invalidate).toHaveBeenCalledTimes(1)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work', 'map'] })
        stop()
        applyCardInvalidated(queryClient, { accountId: 7, topic: 'work-map' })
        expect(invalidate).toHaveBeenCalledTimes(1)
    })
})
