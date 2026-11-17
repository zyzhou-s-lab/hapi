import { describe, expect, it } from 'vitest'
import type { GitRepositoryStatus } from '@hapi/protocol/sourceControl'
import { getGitActionBlock, getPrimaryGitAction } from './actions'

export const repository: GitRepositoryStatus = {
    repoRoot: '/project', branch: 'feature', head: 'abc',
    indexDigest: 'a'.repeat(64), worktreeDigest: 'b'.repeat(64),
    defaultBranch: 'origin/trunk', baseRef: 'origin/trunk', mergeBase: 'base', branchChangedFiles: 0,
    upstream: 'origin/feature', remote: 'origin', ahead: 0, behind: 0,
    dirty: false, scope: 'working', files: [], stagedFiles: [], unstagedFiles: [],
    refs: [], worktrees: [], pullRequest: null, ghAvailable: true, ghAuthenticated: true,
}

describe('Git action eligibility', () => {
    it('allows a local commit while behind but blocks publication until synchronized', () => {
        const repo = { ...repository, dirty: true, ahead: 1, behind: 2 }
        expect(getPrimaryGitAction(repo)).toBe('commit')
        expect(getGitActionBlock('commit', repo, true, false)).toBeNull()
        expect(getGitActionBlock('commit-push', repo, true, false)).toBe('diverged')
        expect(getGitActionBlock('push', repo, true, false)).toBe('diverged')
    })

    it('never recommends a destructive synchronization for diverged branches', () => {
        const repo = { ...repository, ahead: 2, behind: 1 }
        expect(getPrimaryGitAction(repo)).toBeNull()
        expect(getGitActionBlock('pull', repo, true, false)).toBe('diverged')
        expect(getPrimaryGitAction({ ...repository, behind: 1 })).toBe('pull')
        expect(getGitActionBlock('pull', { ...repository, dirty: true }, true, false)).toBe('dirty')
    })

    it('checks offline and activity before any write, including staging', () => {
        expect(getGitActionBlock('stage', repository, false, false)).toBe('offline')
        expect(getGitActionBlock('stage', repository, true, true)).toBe('busy')
        expect(getGitActionBlock('commit', { ...repository, blockedReason: 'merge in progress' }, true, false)).toBe('busy')
        expect(getGitActionBlock('stage', repository, true, false)).toBeNull()
    })

    it('keeps detached and no-remote local commits available without enabling publication', () => {
        const detached = { ...repository, branch: null, remote: null, dirty: true }
        expect(getGitActionBlock('commit', detached, true, false)).toBeNull()
        expect(getGitActionBlock('push', detached, true, false)).toBe('detached')
        expect(getGitActionBlock('push', { ...repository, remote: null }, true, false)).toBe('remote')
        expect(getGitActionBlock('pr', { ...repository, ghAuthenticated: false }, true, false)).toBe('auth')
    })

    it('offers PR for committed branch changes regardless of the selected inspection scope', () => {
        for (const scope of ['working', 'staged', 'unstaged', 'branch'] as const) {
            expect(getPrimaryGitAction({ ...repository, scope, branchChangedFiles: 2 })).toBe('pr')
        }
        expect(getPrimaryGitAction({ ...repository, branchChangedFiles: null })).toBeNull()
        expect(getPrimaryGitAction({ ...repository, branchChangedFiles: 2, pullRequest: { url: 'https://github.com/example/repo/pull/1', number: 1, title: 'Existing' } })).toBeNull()
    })
})

