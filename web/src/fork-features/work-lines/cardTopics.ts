import type { QueryClient, QueryKey } from '@tanstack/react-query'

type Watch = { topic: string; accountId: number; queryKey: QueryKey }

const watches: Watch[] = []

export function watchCardTopic(topic: string, accountId: number, queryKey: QueryKey): () => void {
    const watch = { topic, accountId, queryKey }
    watches.push(watch)
    return () => {
        const index = watches.indexOf(watch)
        if (index >= 0) watches.splice(index, 1)
    }
}

export function applyCardInvalidated(queryClient: QueryClient, event: { accountId: number; topic: string }): void {
    for (const watch of watches) {
        if (watch.accountId === event.accountId && watch.topic === event.topic) {
            void queryClient.invalidateQueries({ queryKey: watch.queryKey })
        }
    }
}

export function refetchWatchedCardTopics(queryClient: QueryClient, accountId: number): void {
    const seen = new Set<string>()
    for (const watch of watches) {
        if (watch.accountId !== accountId) continue
        const key = JSON.stringify(watch.queryKey)
        if (seen.has(key)) continue
        seen.add(key)
        void queryClient.invalidateQueries({ queryKey: watch.queryKey })
    }
}
