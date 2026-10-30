import type { SessionSummary } from '@/types/api'

/** Sessions with no machine id share this bucket. Same string as the sidebar machine filter. */
export const UNKNOWN_MACHINE_ID = '__unknown__'

/**
 * Sidebar directory-group key: machine id + worktree base path (else session path, else Other).
 * The tab strip uses this so it follows the same groups as the session list.
 */
export function sessionDirectoryGroupKey(session: SessionSummary): string {
    const directory = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
    const machineId = session.metadata?.machineId ?? null
    return `${machineId ?? UNKNOWN_MACHINE_ID}::${directory}`
}
