import type { GitActionKind, GitRepositoryStatus } from '@hapi/protocol/sourceControl'

export type GitActionBlock = 'offline' | 'busy' | 'detached' | 'remote' | 'behind' | 'diverged' | 'dirty' | 'upstream' | 'staged' | 'gh' | 'auth' | 'base' | 'clean'

export function getGitActionBlock(
    action: GitActionKind,
    repo: GitRepositoryStatus,
    online: boolean,
    busy: boolean
): GitActionBlock | null {
    if (!online) return 'offline'
    if (busy || repo.blockedReason) return 'busy'
    if (action === 'stage') return null
    if (action.startsWith('commit') && !repo.dirty && repo.stagedFiles.length === 0) return 'clean'
    if (action === 'commit') return null
    if (!repo.branch) return 'detached'
    if (!repo.remote) return 'remote'
    if (action === 'pull') {
        if (!repo.upstream) return 'upstream'
        if (repo.dirty) return 'dirty'
        if (repo.ahead > 0) return 'diverged'
        return null
    }
    if (repo.behind > 0) return repo.ahead > 0 ? 'diverged' : 'behind'
    if (action === 'pr' || action === 'commit-push-pr') {
        if (!repo.ghAvailable) return 'gh'
        if (!repo.ghAuthenticated) return 'auth'
        if (!repo.baseRef && !repo.defaultBranch) return 'base'
    }
    return null
}

export function getPrimaryGitAction(repo: GitRepositoryStatus): GitActionKind | null {
    if (repo.dirty || repo.stagedFiles.length > 0) return 'commit'
    if (repo.ahead > 0 && repo.behind > 0) return null
    if (repo.behind > 0) return 'pull'
    if (repo.ahead > 0 || (!repo.upstream && repo.remote && repo.head)) return 'push'
    if ((repo.branchChangedFiles ?? 0) > 0 && !repo.pullRequest) return 'pr'
    return null
}

