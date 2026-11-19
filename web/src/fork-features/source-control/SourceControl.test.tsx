import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GitActionRequest, GitActionResponse, GitReadOptions, GitRepositoryStatus } from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import type { Session } from '@/types/api'
import { SourceControl } from './SourceControl'

const navigate = vi.hoisted(() => vi.fn())
const narrowViewport = vi.hoisted(() => ({ value: false }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => narrowViewport.value }))

const trackedFile = {
    path: 'docs/experiments',
    status: 'M',
    staged: false,
    unstaged: true,
    untracked: false,
    binary: false,
    additions: 5,
    deletions: 2
}

const untrackedFile = {
    path: 'notes.md',
    status: '?',
    staged: false,
    unstaged: true,
    untracked: true,
    binary: false,
    additions: 10,
    deletions: 0
}

const cleanMainRepository: GitRepositoryStatus = {
    repoRoot: '/project',
    branch: 'main',
    head: 'abc',
    indexDigest: 'a'.repeat(64),
    worktreeDigest: 'b'.repeat(64),
    defaultBranch: 'mine/main',
    baseRef: 'mine/main',
    mergeBase: 'abc',
    branchChangedFiles: 0,
    upstream: 'mine/main',
    remote: 'mine',
    remotes: ['mine', 'origin'],
    isDefaultBranch: true,
    ahead: 0,
    behind: 0,
    dirty: false,
    scope: 'working',
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    changesSummary: { insertions: 0, deletions: 0, baseRef: 'mine/main' },
    refs: [
        { name: 'main', remote: false, current: true },
        { name: 'origin/topic', remote: true, current: false }
    ],
    worktrees: [{ path: '/project', branch: 'main', head: 'abc' }],
    pullRequest: {
        url: 'https://github.com/example/repo/pull/50',
        number: 50,
        title: 'feat(agy): backport Antigravity ACP transport with fork MCP & usage integration',
        state: 'merged',
        isDraft: false,
        checks: 'passing'
    },
    ghAvailable: true,
    ghAuthenticated: true
}

const session = {
    id: 'scope-session',
    active: true,
    thinking: false,
    metadata: { path: '/project', host: 'local', machineId: 'machine' },
    agentState: {}
} as Session

beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('hapi-lang', 'en')
    narrowViewport.value = false
    navigate.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

function renderControl(
    repo: GitRepositoryStatus = cleanMainRepository,
    runGitAction = vi.fn(async (_id: string, _req: GitActionRequest): Promise<GitActionResponse> => ({
        success: true,
        steps: [{ action: 'commit', success: true, output: 'Committed' }],
        head: 'def'
    }))
) {
    const getGitRepository = vi.fn(async (_id: string, _options?: GitReadOptions) => ({
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        repository: repo
    }))
    const api = {
        getGitRepository,
        getSessions: async () => ({ sessions: [] }),
        runGitAction
    } as unknown as ApiClient
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const result = render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SourceControl api={api} session={session} />
            </I18nProvider>
        </QueryClientProvider>
    )
    return { ...result, getGitRepository, runGitAction }
}

describe('SourceControl 4-row T3-aligned card', () => {
    it('renders the 4 compact rows (branch, merged PR with checks, disabled Commit, Changes vs base +0 -0)', async () => {
        renderControl()
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))

        const card = await screen.findByRole('dialog', { name: 'Git' })
        expect(await within(card).findByText('feat(agy): backport Antigravity ACP transport with fork MCP & usage integration')).toBeVisible()
        expect(within(card).getByText('#50')).toBeVisible()
        expect(within(card).getByLabelText('Checks passing')).toBeVisible()
        expect(within(card).getByRole('button', { name: 'Commit' })).toBeDisabled()
        expect(within(card).getByText('vs mine/main')).toBeVisible()
        expect(within(card).getByText('+0')).toBeVisible()
        expect(within(card).getByText('-0')).toBeVisible()
    })

    it('deduplicates worktree branch from local refs, creates worktree on ref click, and supports idle checkout/create-branch', async () => {
        const { runGitAction } = renderControl()
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        const card = await screen.findByRole('dialog', { name: 'Git' })
        await within(card).findByText('#50')

        fireEvent.click(within(card).getByRole('button', { name: 'main' }))
        expect(screen.getAllByText('main')).toHaveLength(3)
        expect(screen.getByText('Current')).toBeVisible()

        fireEvent.click(screen.getByRole('button', { name: 'origin/topic Remote' }))
        await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/new',
            search: {
                machineId: 'machine',
                directory: '/project',
                sessionType: 'worktree',
                worktreeStartRef: 'origin/topic'
            }
        })))

        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        const reopened = await screen.findByRole('dialog', { name: 'Git' })
        fireEvent.click(await within(reopened).findByRole('button', { name: 'main' }))
        fireEvent.click(screen.getByRole('button', { name: 'Switch current checkout to origin/topic' }))
        await waitFor(() => expect(runGitAction).toHaveBeenCalledWith('scope-session', expect.objectContaining({
            action: 'checkout',
            targetRef: 'origin/topic'
        })))

        fireEvent.click(await within(reopened).findByRole('button', { name: 'main' }))
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search branches and worktrees' }), {
            target: { value: 'feat/new-branch' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Create branch "feat/new-branch"' }))
        await waitFor(() => expect(runGitAction).toHaveBeenCalledWith('scope-session', expect.objectContaining({
            action: 'create-branch',
            targetRef: 'feat/new-branch'
        })))
    })

    it('opens Commit dialog with selectable files, encodes file paths with Base64 on diff click, and submits direct runGitAction', async () => {
        const dirtyRepo: GitRepositoryStatus = {
            ...cleanMainRepository,
            branch: 'feat/diff',
            isDefaultBranch: false,
            upstream: 'mine/feat/diff',
            dirty: true,
            pullRequest: null,
            files: [trackedFile, untrackedFile],
            unstagedFiles: [trackedFile, untrackedFile],
            changesSummary: { insertions: 15, deletions: 2, baseRef: 'mine/main' }
        }
        const { runGitAction } = renderControl(dirtyRepo)
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))

        const quickButton = await screen.findByRole('button', { name: 'Commit, push & PR' })
        expect(quickButton).toBeEnabled()
        fireEvent.click(quickButton)

        await screen.findByRole('dialog')
        expect(screen.getByText('docs/experiments')).toBeVisible()
        expect(screen.getByText('notes.md')).toBeVisible()

        fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'notes.md' }))
        fireEvent.change(screen.getByLabelText('Commit message'), {
            target: { value: 'feat: align source control card' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }))

        await waitFor(() => expect(runGitAction).toHaveBeenCalledWith('scope-session', expect.objectContaining({
            action: 'commit-push-pr',
            paths: ['docs/experiments'],
            message: 'feat: align source control card',
            baseRef: 'mine/main',
            title: 'feat: align source control card'
        })))
    })

    it('encodes file paths whose length is a multiple of 4 using Base64 when opening diff from Commit dialog', async () => {
        const dirtyRepo: GitRepositoryStatus = {
            ...cleanMainRepository,
            branch: 'feat/diff',
            isDefaultBranch: false,
            dirty: true,
            pullRequest: null,
            files: [trackedFile],
            unstagedFiles: [trackedFile]
        }
        renderControl(dirtyRepo)
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }))
        fireEvent.click(await screen.findByRole('button', { name: /docs\/experiments/ }))

        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'scope-session' },
            search: { path: encodeBase64('docs/experiments'), scope: 'working' }
        }))
    })

    it('runs 1-click Pull directly when branch is behind upstream', async () => {
        const behindRepo: GitRepositoryStatus = {
            ...cleanMainRepository,
            behind: 2,
            pullRequest: null
        }
        const { runGitAction } = renderControl(behindRepo)
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        fireEvent.click(await screen.findByRole('button', { name: 'Pull' }))

        await waitFor(() => expect(runGitAction).toHaveBeenCalledWith('scope-session', expect.objectContaining({
            action: 'pull',
            expectedHead: 'abc',
            expectedBranch: 'main'
        })))
    })

    it('hides redundant primary remote-tracking refs in unfiltered list and suppresses Switch on checked-out targets', async () => {
        const multiRemoteRepo: GitRepositoryStatus = {
            ...cleanMainRepository,
            refs: [
                { name: 'main', remote: false, current: true },
                { name: 'mine/main', remote: true, current: false },
                { name: 'origin/main', remote: true, current: false },
                { name: 'origin/topic', remote: true, current: false }
            ]
        }
        renderControl(multiRemoteRepo)
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        const card = await screen.findByRole('dialog', { name: 'Git' })
        await within(card).findByText('#50')

        fireEvent.click(within(card).getByRole('button', { name: 'main' }))
        expect(screen.queryByRole('button', { name: 'mine/main Remote' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'origin/main Remote' })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Switch current checkout to origin/main' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Switch current checkout to origin/topic' })).toBeVisible()

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search branches and worktrees' }), {
            target: { value: 'mine/main' }
        })
        expect(screen.getByRole('button', { name: 'mine/main Remote' })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Switch current checkout to mine/main' })).not.toBeInTheDocument()
    })

    it('gates fork.59 branch actions and performs two-step stage + commit on legacy CLI sessions', async () => {
        const {
            changesSummary: _summary,
            remotes: _remotes,
            isDefaultBranch: _isDefault,
            ...legacyFields
        } = cleanMainRepository
        const legacyDirtyRepo: GitRepositoryStatus = {
            ...legacyFields,
            branch: 'main',
            upstream: 'origin/main',
            remote: 'origin',
            defaultBranch: 'origin/main',
            baseRef: 'origin/main',
            dirty: true,
            pullRequest: null,
            files: [untrackedFile],
            stagedFiles: [],
            unstagedFiles: [untrackedFile],
            refs: [
                { name: 'main', remote: false, current: true },
                { name: 'origin/main', remote: true, current: false },
                { name: 'origin/topic', remote: true, current: false }
            ]
        }
        const stagedDigest = 'c'.repeat(64)
        let currentRepo = legacyDirtyRepo
        const getGitRepository = vi.fn(async () => ({
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repository: currentRepo
        }))
        const runGitAction = vi.fn(async (_id: string, req: GitActionRequest): Promise<GitActionResponse> => {
            if (req.action === 'stage') {
                currentRepo = {
                    ...legacyDirtyRepo,
                    indexDigest: stagedDigest,
                    stagedFiles: [{ ...untrackedFile, staged: true, unstaged: false, untracked: false, status: 'A' }],
                    unstagedFiles: [],
                    files: [{ ...untrackedFile, staged: true, unstaged: false, untracked: false, status: 'A' }]
                }
                return { success: true, steps: [{ action: 'stage', success: true, output: 'Staged 1 path.' }], head: 'abc' }
            }
            return {
                success: true,
                steps: [
                    { action: 'commit', success: true, output: 'Committed' },
                    { action: 'push', success: true, output: 'Pushed' }
                ],
                head: 'def'
            }
        })
        const api = {
            getGitRepository,
            getSessions: async () => ({ sessions: [] }),
            runGitAction
        } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SourceControl api={api} session={session} />
                </I18nProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))
        const card = await screen.findByRole('dialog', { name: 'Git' })
        await within(card).findByRole('button', { name: 'Commit & push' })

        fireEvent.click(within(card).getByRole('button', { name: 'main' }))
        expect(screen.queryByRole('button', { name: 'Switch current checkout to origin/topic' })).not.toBeInTheDocument()
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search branches and worktrees' }), {
            target: { value: 'feat/new-branch' }
        })
        expect(screen.queryByRole('button', { name: 'Create branch "feat/new-branch"' })).not.toBeInTheDocument()

        fireEvent.click(within(card).getByRole('button', { name: 'Commit & push' }))
        await screen.findByRole('dialog')
        fireEvent.change(screen.getByLabelText('Commit message'), {
            target: { value: 'chore: stage untracked on legacy cli' }
        })
        fireEvent.click(screen.getByRole('checkbox'))
        fireEvent.click(screen.getByRole('button', { name: 'Commit & push' }))

        await waitFor(() => expect(runGitAction).toHaveBeenCalledTimes(2))
        expect(runGitAction.mock.calls[0]?.[1]).toMatchObject({
            action: 'stage',
            paths: ['notes.md'],
            expectedIndexDigest: 'a'.repeat(64)
        })
        expect(runGitAction.mock.calls[1]?.[1]).toMatchObject({
            action: 'commit-push',
            message: 'chore: stage untracked on legacy cli',
            expectedIndexDigest: stagedDigest,
            confirmDefaultBranch: true
        })
        expect(runGitAction.mock.calls[1]?.[1]).not.toHaveProperty('paths')
    })

    it('does not autofocus the branch searchbox on narrow mobile viewports', async () => {
        narrowViewport.value = true
        renderControl()
        fireEvent.click(screen.getByTestId('statusbar-git-trigger'))

        const sheet = await screen.findByRole('dialog', { name: 'Git' })
        fireEvent.click(await within(sheet).findByRole('button', { name: 'main' }))

        const searchbox = await within(sheet).findByRole('searchbox', { name: 'Search branches and worktrees' })
        expect(searchbox).toBeVisible()
        expect(searchbox).not.toHaveFocus()
    })
})
