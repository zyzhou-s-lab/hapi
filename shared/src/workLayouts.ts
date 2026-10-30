export type WorkCardSlot = {
    cardId: string
    args?: Record<string, string>
}

export const overviewDefaultRegions: Record<string, WorkCardSlot[]> = {
    stats: [
        { cardId: 'overview.line-count' },
        { cardId: 'overview.needs-you-count' },
        { cardId: 'overview.running-count' },
        { cardId: 'overview.inbox-count' },
    ],
    body: [
        { cardId: 'overview.needs-you-list' },
    ],
}

export const workbenchDefaultRegions: Record<string, WorkCardSlot[]> = {
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
}
