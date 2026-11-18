import type { GitActionKind, GitChange, GitRepositoryStatus } from '@hapi/protocol/sourceControl'

export type GitActionBlock =
    | 'offline'
    | 'busy'
    | 'conflicts'
    | 'detached'
    | 'remote'
    | 'behind'
    | 'diverged'
    | 'dirty'
    | 'upstream'
    | 'staged'
    | 'gh'
    | 'auth'
    | 'base'
    | 'defaultBranchPr'
    | 'clean'

export type GitQuickIcon = 'commit' | 'push' | 'pull' | 'pr' | 'sync'

export type GitActionDescriptor = {
    id: 'commit' | 'push' | 'pull' | 'pr' | 'quick'
    icon: GitQuickIcon
    labelKey: string
    action: GitActionKind | null
    opensDialog: boolean
    disabled: boolean
    block: GitActionBlock | null
}

export function hasOpenPullRequest(repo: GitRepositoryStatus): boolean {
    return repo.pullRequest !== null && (repo.pullRequest.state ?? 'open') === 'open'
}

export function isRepositoryDefaultBranch(repo: GitRepositoryStatus): boolean {
    if (repo.isDefaultBranch !== undefined) return repo.isDefaultBranch
    if (!repo.branch) return false
    const remotes = repo.remotes ?? (repo.remote ? [repo.remote] : [])
    if (!repo.defaultBranch) {
        return remotes.length > 0 && (repo.branch === 'main' || repo.branch === 'master')
    }
    for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
        if (repo.defaultBranch.startsWith(`${remote}/`)) {
            return repo.branch === repo.defaultBranch.slice(remote.length + 1)
        }
    }
    return repo.branch === repo.defaultBranch
}

export function hasTrackedDirtyChanges(repo: GitRepositoryStatus): boolean {
    return repo.stagedFiles.length > 0 || repo.unstagedFiles.some((file) => !file.untracked)
}

export function getRepositoryDirtyFiles(repo: GitRepositoryStatus): GitChange[] {
    if (repo.scope === 'working') {
        return repo.files
    }
    const byPath = new Map<string, GitChange>()
    for (const file of repo.stagedFiles) {
        byPath.set(file.path, { ...file })
    }
    for (const file of repo.unstagedFiles) {
        const existing = byPath.get(file.path)
        if (!existing) {
            byPath.set(file.path, { ...file })
            continue
        }
        existing.unstaged = existing.unstaged || file.unstaged
        existing.untracked = existing.untracked || file.untracked
        existing.binary = existing.binary || file.binary
        if (existing.additions !== null && file.additions !== null) {
            existing.additions += file.additions
        } else {
            existing.additions = null
        }
        if (existing.deletions !== null && file.deletions !== null) {
            existing.deletions += file.deletions
        } else {
            existing.deletions = null
        }
    }
    return [...byPath.values()]
}

export function getGitActionBlock(
    action: GitActionKind,
    repo: GitRepositoryStatus,
    online: boolean,
    busy: boolean
): GitActionBlock | null {
    if (!online) return 'offline'
    if (busy) return 'busy'
    if (repo.blockedReason && /conflict/i.test(repo.blockedReason)) return 'conflicts'
    if (action === 'checkout') {
        return hasTrackedDirtyChanges(repo) ? 'dirty' : null
    }
    if (action === 'create-branch') {
        return null
    }
    if (
        repo.blockedReason
        && !repo.blockedReason.startsWith('Detached HEAD')
        && !repo.blockedReason.startsWith('Branch has diverged')
    ) {
        return 'busy'
    }
    if (action === 'stage') return null
    const hasChanges = repo.dirty || repo.stagedFiles.length > 0
    if (action.startsWith('commit') && !hasChanges) return 'clean'
    if (!repo.branch) return 'detached'
    if (action === 'commit') return null
    if (!repo.remote) return 'remote'
    if (action === 'pull') {
        if (!repo.upstream) return 'upstream'
        if (repo.dirty) return 'dirty'
        if (repo.ahead > 0) return 'diverged'
        return null
    }
    if (repo.behind > 0) return repo.ahead > 0 ? 'diverged' : 'behind'
    if (action === 'push') {
        if (repo.upstream && repo.ahead <= 0) return 'clean'
        if (!repo.upstream && repo.head === null) return 'clean'
        return null
    }
    if (action === 'pr' || action === 'push-pr' || action === 'commit-push-pr') {
        if (isRepositoryDefaultBranch(repo)) return 'defaultBranchPr'
        if (!repo.ghAvailable) return 'gh'
        if (!repo.ghAuthenticated) return 'auth'
        if (!repo.baseRef && !repo.defaultBranch) return 'base'
        if (action === 'pr' && repo.upstream && repo.ahead <= 0 && (repo.branchChangedFiles ?? 0) <= 0) {
            return 'clean'
        }
        if (action === 'pr' && !repo.upstream && repo.head === null) {
            return 'clean'
        }
    }
    return null
}

export function resolveQuickGitAction(
    repo: GitRepositoryStatus,
    online: boolean,
    busy: boolean
): GitActionDescriptor {
    if (!online) {
        return {
            id: 'quick',
            icon: 'commit',
            labelKey: 'sourceControl.quick.commit',
            action: null,
            opensDialog: false,
            disabled: true,
            block: 'offline'
        }
    }
    if (busy) {
        return {
            id: 'quick',
            icon: 'commit',
            labelKey: 'sourceControl.quick.commit',
            action: null,
            opensDialog: false,
            disabled: true,
            block: 'busy'
        }
    }
    if (repo.blockedReason && /conflict/i.test(repo.blockedReason)) {
        return {
            id: 'quick',
            icon: 'commit',
            labelKey: 'sourceControl.quick.commit',
            action: null,
            opensDialog: false,
            disabled: true,
            block: 'conflicts'
        }
    }
    if (!repo.branch) {
        return {
            id: 'quick',
            icon: 'commit',
            labelKey: 'sourceControl.quick.commit',
            action: null,
            opensDialog: false,
            disabled: true,
            block: 'detached'
        }
    }

    const hasChanges = repo.dirty || repo.stagedFiles.length > 0
    const hasRemote = Boolean(repo.remote)
    const hasOpenPr = hasOpenPullRequest(repo)
    const defaultBranch = isRepositoryDefaultBranch(repo)
    const ghReady = repo.ghAvailable && repo.ghAuthenticated && Boolean(repo.baseRef ?? repo.defaultBranch)

    if (hasChanges) {
        if (repo.behind > 0 || !hasRemote) {
            const block = getGitActionBlock('commit', repo, online, busy)
            return {
                id: 'quick',
                icon: 'commit',
                labelKey: 'sourceControl.quick.commit',
                action: 'commit',
                opensDialog: true,
                disabled: block !== null,
                block
            }
        }
        if (hasOpenPr || defaultBranch || !ghReady) {
            const block = getGitActionBlock('commit-push', repo, online, busy)
            return {
                id: 'quick',
                icon: 'push',
                labelKey: 'sourceControl.quick.commitPush',
                action: 'commit-push',
                opensDialog: true,
                disabled: block !== null,
                block
            }
        }
        const block = getGitActionBlock('commit-push-pr', repo, online, busy)
        return {
            id: 'quick',
            icon: 'pr',
            labelKey: 'sourceControl.quick.commitPushPr',
            action: 'commit-push-pr',
            opensDialog: true,
            disabled: block !== null,
            block
        }
    }

    if (repo.ahead > 0 && repo.behind > 0) {
        return {
            id: 'quick',
            icon: 'sync',
            labelKey: 'sourceControl.quick.sync',
            action: null,
            opensDialog: false,
            disabled: true,
            block: 'diverged'
        }
    }

    if (repo.upstream && repo.behind > 0) {
        const block = getGitActionBlock('pull', repo, online, busy)
        return {
            id: 'quick',
            icon: 'pull',
            labelKey: 'sourceControl.quick.pull',
            action: 'pull',
            opensDialog: false,
            disabled: block !== null,
            block
        }
    }

    const unpublishedBranchWithDelta = !repo.upstream
        && hasRemote
        && repo.head !== null
        && !defaultBranch
        && (repo.branchChangedFiles ?? 1) > 0
    if (repo.ahead > 0 || unpublishedBranchWithDelta) {
        if (hasOpenPr || defaultBranch || !ghReady) {
            const block = getGitActionBlock('push', repo, online, busy)
            return {
                id: 'quick',
                icon: 'push',
                labelKey: 'sourceControl.quick.push',
                action: 'push',
                opensDialog: defaultBranch,
                disabled: block !== null,
                block
            }
        }
        const block = getGitActionBlock('push-pr', repo, online, busy)
        return {
            id: 'quick',
            icon: 'pr',
            labelKey: 'sourceControl.quick.pushPr',
            action: 'push-pr',
            opensDialog: true,
            disabled: block !== null,
            block
        }
    }

    if ((repo.branchChangedFiles ?? 0) > 0 && !defaultBranch && !hasOpenPr && hasRemote) {
        const block = getGitActionBlock('pr', repo, online, busy)
        return {
            id: 'quick',
            icon: 'pr',
            labelKey: 'sourceControl.quick.pr',
            action: 'pr',
            opensDialog: true,
            disabled: block !== null,
            block
        }
    }

    return {
        id: 'quick',
        icon: 'commit',
        labelKey: 'sourceControl.quick.commit',
        action: null,
        opensDialog: false,
        disabled: true,
        block: 'clean'
    }
}

export function buildGitMenuItems(
    repo: GitRepositoryStatus,
    online: boolean,
    busy: boolean
): GitActionDescriptor[] {
    const commitBlock = getGitActionBlock('commit', repo, online, busy)
    const items: GitActionDescriptor[] = [
        {
            id: 'commit',
            icon: 'commit',
            labelKey: 'sourceControl.menu.commit',
            action: 'commit',
            opensDialog: true,
            disabled: commitBlock !== null,
            block: commitBlock
        }
    ]

    if (repo.upstream && repo.behind > 0) {
        const pullBlock = getGitActionBlock('pull', repo, online, busy)
        items.push({
            id: 'pull',
            icon: 'pull',
            labelKey: 'sourceControl.menu.pull',
            action: 'pull',
            opensDialog: false,
            disabled: pullBlock !== null,
            block: pullBlock
        })
    }

    if (repo.remote) {
        const defaultBranch = isRepositoryDefaultBranch(repo)
        const pushBlock = getGitActionBlock('push', repo, online, busy)
        items.push({
            id: 'push',
            icon: 'push',
            labelKey: 'sourceControl.menu.push',
            action: 'push',
            opensDialog: defaultBranch,
            disabled: pushBlock !== null,
            block: pushBlock
        })

        if (!hasOpenPullRequest(repo)) {
            const prAction: GitActionKind = repo.ahead > 0 || !repo.upstream ? 'push-pr' : 'pr'
            const prBlock = getGitActionBlock(prAction, repo, online, busy)
            items.push({
                id: 'pr',
                icon: 'pr',
                labelKey: 'sourceControl.menu.pr',
                action: prAction,
                opensDialog: true,
                disabled: prBlock !== null,
                block: prBlock
            })
        }
    }

    return items
}

export function getPrimaryGitAction(repo: GitRepositoryStatus): GitActionKind | null {
    return resolveQuickGitAction(repo, true, false).action
}
