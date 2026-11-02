/** Caller-passed token on CLI delete. It is not a second prompt. */
export const EXPLORE_DELETE_CONFIRM_HEADER = 'x-hapi-explore-delete-confirm'

const FRESH_APPROVAL_TOOL = 'delete_exploration'
const FRESH_APPROVAL_PREFIXES = [
    'mcp__hapi__',
    'mcp_hapi__',
    'mcp_hapi_',
    'happy__',
    'hapi__',
    'hapi_',
]

/**
 * delete_exploration must be approved by a person on every call. Session
 * grants and yolo/bypass/safe-yolo/always-proceed do not apply. Names are
 * matched after lowercasing, turning spaces and hyphens into underscores,
 * and stripping one known MCP prefix.
 */
export function requiresFreshApproval(toolName: string): boolean {
    let name = toolName.trim().toLowerCase().replace(/[\s-]+/g, '_')
    for (const prefix of FRESH_APPROVAL_PREFIXES) {
        if (name.startsWith(prefix)) {
            name = name.slice(prefix.length)
            break
        }
    }
    return name === FRESH_APPROVAL_TOOL
}

/** This call may proceed. A session grant is rewritten to a one-shot approval. */
export function freshApprovalDecision<T extends string>(toolName: string, decision: T): T {
    if (decision !== 'approved_for_session' || !requiresFreshApproval(toolName)) return decision
    return 'approved' as T
}

/**
 * Directory keys to try, nearest first. `/` matches only itself and is not
 * an ancestor of other paths. A relative path is exact only.
 */
export function absoluteDirectoryAncestors(path: string): string[] {
    const trimmed = path.trim()
    if (!trimmed.startsWith('/')) {
        const exact = trimmed.replace(/\/+$/, '')
        return exact ? [exact] : []
    }
    if (/^\/+$/.test(trimmed)) return ['/']
    const out: string[] = []
    let current = trimmed.replace(/\/+$/, '')
    while (current.length > 1) {
        out.push(current)
        const slash = current.lastIndexOf('/')
        if (slash <= 0) break
        current = current.slice(0, slash)
    }
    return out
}
