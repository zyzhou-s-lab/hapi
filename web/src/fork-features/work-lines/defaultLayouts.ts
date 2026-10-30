import type { WorkLayout } from './layout'

export const overviewLayout: WorkLayout = {
    revision: 1,
    regions: {
        stats: [
            { cardId: 'overview.line-count' },
            { cardId: 'overview.needs-you-count' },
            { cardId: 'overview.running-count' },
            { cardId: 'overview.inbox-count' },
        ],
        body: [
            { cardId: 'overview.needs-you-list' },
        ],
    },
}
