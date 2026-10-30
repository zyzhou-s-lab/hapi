import { LAYOUT_REVISION, type WorkLayout } from './layout'

export const overviewLayout: WorkLayout = {
    revision: LAYOUT_REVISION,
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

export const workbenchLayout: WorkLayout = {
    revision: LAYOUT_REVISION,
    regions: {
        rail: [{ cardId: 'workbench.line-list' }],
        main: [
            { cardId: 'workbench.line-header' },
            { cardId: 'workbench.focus' },
            { cardId: 'workbench.directories' },
            { cardId: 'workbench.inbox' },
        ],
        side: [
            { cardId: 'workbench.sessions' },
            { cardId: 'workbench.continue' },
        ],
    },
}
