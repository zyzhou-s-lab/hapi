const grants = new Map<string, Set<string>>()

export function grantSessionFileRead(sessionId: string, realpath: string): void {
    const allowed = grants.get(sessionId) ?? new Set<string>()
    allowed.add(realpath)
    grants.set(sessionId, allowed)
}

export function sessionFileReadGranted(sessionId: string, path: string): boolean {
    return grants.get(sessionId)?.has(path) === true
}

export function clearSessionFileReads(sessionId: string): void {
    grants.delete(sessionId)
}
