import { describe, expect, it } from 'vitest'
import type { GitRepositoryStatus } from '@hapi/protocol/sourceControl'
import {
    buildGitMenuItems,
    getGitActionBlock,
    getPrimaryGitAction,
    resolveQuickGitAction,
    splitRemoteRef,
    supportsExtendedGitActions
} from './actions'

export const repository: GitRepositoryStatus = {
    repoRoot: '/project',
    branch: 'feature',
    head: 'abc',
    indexDigest: 'a'.repeat(64),
    worktreeDigest: 'b'.repeat(64),
    defaultBranch: 'origin/trunk',
    baseRef: 'origin/trunk',
    mergeBase: 'base',
    branchChangedFiles: 0,
    upstream: 'origin/feature',
    remote: 'origin',
    remotes: ['origin'],
    isDefaultBranch: false,
    ahead: 0,
    behind: 0,
    dirty: false,
    scope: 'working',
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    refs: [],
    worktrees: [],
    pullRequest: null,
    ghAvailable: true,
    ghAuthenticated: true,
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

    it('checks offline, activity, and conflicts before any write', () => {
        expect(getGitActionBlock('stage', repository, false, false)).toBe('offline')
        expect(getGitActionBlock('stage', repository, true, true)).toBe('busy')
        expect(getGitActionBlock('commit', { ...repository, blockedReason: 'Unresolved merge conflicts block commit and publication.' }, true, false)).toBe('conflicts')
        expect(getGitActionBlock('stage', repository, true, false)).toBeNull()
    })

    it('blocks detached HEAD commits and publication while allowing checkout and branch creation', () => {
        const detached = { ...repository, branch: null, remote: null, dirty: true }
        expect(getGitActionBlock('commit', detached, true, false)).toBe('detached')
        expect(getGitActionBlock('push', detached, true, false)).toBe('detached')
        expect(getGitActionBlock('create-branch', detached, true, false)).toBeNull()
        expect(getGitActionBlock('checkout', { ...repository, branch: null, dirty: false }, true, false)).toBeNull()
        expect(getGitActionBlock('push', { ...repository, remote: null }, true, false)).toBe('remote')
        expect(getGitActionBlock('pr', { ...repository, ghAuthenticated: false }, true, false)).toBe('auth')
    })

    it('offers PR for committed branch changes regardless of the selected inspection scope', () => {
        for (const scope of ['working', 'staged', 'unstaged', 'branch'] as const) {
            expect(getPrimaryGitAction({ ...repository, scope, branchChangedFiles: 2 })).toBe('pr')
        }
        expect(getPrimaryGitAction({ ...repository, branchChangedFiles: null })).toBeNull()
        expect(getPrimaryGitAction({
            ...repository,
            branchChangedFiles: 2,
            pullRequest: { url: 'https://github.com/example/repo/pull/1', number: 1, title: 'Existing', state: 'open' }
        })).toBeNull()
    })

    it('resolves smart quick actions matching T3 Code states', () => {
        expect(resolveQuickGitAction({ ...repository, branch: 'trunk', isDefaultBranch: true }, true, false)).toMatchObject({
            labelKey: 'sourceControl.quick.commit',
            disabled: true,
            block: 'clean'
        })
        expect(resolveQuickGitAction({ ...repository, dirty: true }, true, false)).toMatchObject({
            action: 'commit-push-pr',
            labelKey: 'sourceControl.quick.commitPushPr',
            opensDialog: true,
            disabled: false
        })
        expect(resolveQuickGitAction({ ...repository, branch: 'trunk', isDefaultBranch: true, dirty: true }, true, false)).toMatchObject({
            action: 'commit-push',
            labelKey: 'sourceControl.quick.commitPush',
            opensDialog: true,
            disabled: false
        })
        expect(resolveQuickGitAction({ ...repository, ahead: 2 }, true, false)).toMatchObject({
            action: 'push-pr',
            labelKey: 'sourceControl.quick.pushPr',
            opensDialog: true,
            disabled: false
        })
        expect(resolveQuickGitAction({ ...repository, behind: 1 }, true, false)).toMatchObject({
            action: 'pull',
            labelKey: 'sourceControl.quick.pull',
            opensDialog: false,
            disabled: false
        })
    })

    it('builds the 3-item dropdown menu on clean branches and hides Create PR only for open PRs', () => {
        const mergedPrOnMain: GitRepositoryStatus = {
            ...repository,
            branch: 'trunk',
            isDefaultBranch: true,
            pullRequest: { url: 'https://github.com/example/repo/pull/50', number: 50, title: 'Merged PR', state: 'merged' }
        }
        expect(buildGitMenuItems(mergedPrOnMain, true, false).map((item) => item.id)).toEqual(['commit', 'push', 'pr'])

        const openPr = {
            ...repository,
            pullRequest: { url: 'https://github.com/example/repo/pull/51', number: 51, title: 'Open PR', state: 'open' as const }
        }
        expect(buildGitMenuItems(openPr, true, false).map((item) => item.id)).toEqual(['commit', 'push'])

        const behind = { ...repository, behind: 1 }
        expect(buildGitMenuItems(behind, true, false).map((item) => item.id)).toEqual(['commit', 'pull', 'push', 'pr'])
    })

    it('detects legacy CLI payloads, splits remote refs, and degrades unsupported fork.59 actions', () => {
        const { remotes: _remotes, isDefaultBranch: _isDefault, changesSummary: _summary, ...legacyBase } = repository
        const legacyAhead: GitRepositoryStatus = { ...legacyBase, ahead: 2 }

        expect(supportsExtendedGitActions(legacyAhead)).toBe(false)
        expect(supportsExtendedGitActions(repository)).toBe(true)

        expect(splitRemoteRef('origin/feat/foo', legacyAhead)).toEqual({ remote: 'origin', branch: 'feat/foo' })
        expect(splitRemoteRef('mine/main', {
            remote: 'mine',
            remotes: ['mine', 'origin'],
            upstream: 'mine/main',
            defaultBranch: 'mine/main'
        })).toEqual({ remote: 'mine', branch: 'main' })

        expect(getGitActionBlock('checkout', legacyAhead, true, false)).toBe('busy')
        expect(getGitActionBlock('create-branch', legacyAhead, true, false)).toBe('busy')
        expect(getGitActionBlock('push-pr', legacyAhead, true, false)).toBe('busy')
        expect(resolveQuickGitAction(legacyAhead, true, false)).toMatchObject({
            action: 'push',
            labelKey: 'sourceControl.quick.push',
            opensDialog: false,
            disabled: false
        })

        expect(buildGitMenuItems(legacyAhead, true, false).find((item) => item.id === 'pr')).toMatchObject({
            action: 'pr',
            disabled: false
        })
        const legacyUnpublished: GitRepositoryStatus = { ...legacyAhead, upstream: null }
        expect(buildGitMenuItems(legacyUnpublished, true, false).find((item) => item.id === 'pr')).toMatchObject({
            action: 'pr',
            disabled: true,
            block: 'upstream'
        })
    })
})
