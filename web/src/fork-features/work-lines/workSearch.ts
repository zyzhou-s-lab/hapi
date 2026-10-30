export type WorkSearch = {
    line?: string
    inbox?: boolean
}

export function parseWorkSearch(search: Record<string, unknown>): WorkSearch {
    const line = typeof search.line === 'string' && search.line.length > 0 ? search.line : undefined
    if (line) return { line }
    if (search.inbox === '1' || search.inbox === 1 || search.inbox === true) return { inbox: true }
    return {}
}

export function defaultWorkSearch(search: WorkSearch, lineIds: readonly string[]): WorkSearch | null {
    if (search.line || search.inbox) return null
    const first = lineIds[0]
    if (first) return { line: first }
    return { inbox: true }
}
