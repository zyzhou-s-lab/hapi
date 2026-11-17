import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GitReadOptions, GitRepositoryStatus } from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SourceControl } from './SourceControl'
import { GitChatProvider } from './GitChatContext'
import { GitDraftEditor } from './GitDraftEditor'
import { getLatestGitPreparation } from './gitChat'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => false }))

const file = { path: 'tracked.ts', status: 'M', staged: false, unstaged: true, untracked: false, binary: false, additions: 5, deletions: 2 }
const repository: GitRepositoryStatus = {
    repoRoot: '/project', branch: 'feature', head: 'abc',
    indexDigest: 'a'.repeat(64), worktreeDigest: 'b'.repeat(64),
    defaultBranch: 'origin/trunk', baseRef: 'origin/trunk', mergeBase: 'base', branchChangedFiles: 0,
    upstream: 'origin/feature', remote: 'origin', ahead: 0, behind: 0,
    dirty: true, scope: 'working', files: [file], stagedFiles: [], unstagedFiles: [file],
    refs: [{ name: 'origin/topic', remote: true, current: false }],
    worktrees: [{ path: '/project', branch: 'feature', head: 'abc' }],
    pullRequest: null, ghAvailable: true, ghAuthenticated: true,
}
const session = {
    id: 'scope-session', active: true, thinking: false,
    metadata: { path: '/project', host: 'local', machineId: 'machine' },
    agentState: {},
} as Session

beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('hapi-lang', 'en')
    navigate.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

function renderControl(send = vi.fn(async (_text: string) => true)) {
    const getGitRepository = vi.fn(async (_id: string, options?: GitReadOptions) => ({
        success: true, stdout: '', stderr: '', exitCode: 0,
        repository: { ...repository, scope: options?.scope ?? 'working', files: options?.scope === 'staged' ? [] : [file] },
    }))
    const runGitAction = vi.fn()
    const api = { getGitRepository, getSessions: async () => ({ sessions: [] }), runGitAction } as unknown as ApiClient
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const result = render(<QueryClientProvider client={queryClient}><I18nProvider><GitChatProvider value={{ preparation: null, disabled: false, send }}><SourceControl api={api} session={session} /></GitChatProvider></I18nProvider></QueryClientProvider>)
    return { ...result, getGitRepository, runGitAction, send }
}

describe('composer Git inspection', () => {
    it('retains an explicitly empty scope through close and remount instead of substituting nonempty working changes', async () => {
        const first = renderControl()
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('tracked.ts')
        fireEvent.change(screen.getByRole('combobox', { name: 'Comparison scope' }), { target: { value: 'staged' } })
        await screen.findByText('No changes in this comparison scope.')
        expect(screen.queryByText('tracked.ts')).toBeNull()
        expect(screen.getByRole('combobox', { name: 'Comparison scope' })).toHaveValue('staged')
        first.unmount()
        renderControl()
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('No changes in this comparison scope.')
        expect(screen.getByRole('combobox', { name: 'Comparison scope' })).toHaveValue('staged')
    })

    it('selects a ref by preparing a separate worktree session, without a Git write in the active checkout', async () => {
        const { runGitAction } = renderControl()
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('tracked.ts')
        fireEvent.click(screen.getByText('Choose branch or workspace'))
        fireEvent.click(screen.getByRole('button', { name: 'origin/topic Remote' }))
        await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/new',
            search: { machineId: 'machine', directory: '/project', sessionType: 'worktree', worktreeStartRef: 'origin/topic' },
        })))
        expect(runGitAction).not.toHaveBeenCalled()
    })

    it('submits a preparation message instead of opening a Git confirmation or writing Git state', async () => {
        const { send, runGitAction } = renderControl()
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('tracked.ts')
        fireEvent.click(screen.getAllByRole('button', { name: 'Commit staged changes' })[0]!)
        await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
        expect(send.mock.calls[0]?.[0]).toMatch(/^\/git commit\n/)
        expect(runGitAction).not.toHaveBeenCalled()
        expect(screen.queryByRole('dialog')).toBeNull()
        await waitFor(() => expect(screen.queryByText('tracked.ts')).toBeNull())
    })

    it('opens an editable Git review when HTTP exposes getRandomValues but not randomUUID', async () => {
        vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
        const { send } = renderControl()
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('tracked.ts')
        fireEvent.click(screen.getAllByRole('button', { name: 'Commit staged changes' })[0]!)
        await waitFor(() => expect(screen.queryByText('tracked.ts')).toBeNull())

        const preparation = getLatestGitPreparation([{
            id: 'http-git-preparation', seq: 1, localId: null, createdAt: 1,
            content: { role: 'user', content: { type: 'text', text: send.mock.calls[0]?.[0] } },
        }])
        render(<I18nProvider><GitChatProvider value={{ preparation, disabled: false, send }}><GitDraftEditor code={JSON.stringify({
            requestId: preparation?.requestId, action: 'commit', paths: ['tracked.ts'], message: 'Fix parser boundary',
        })} /></GitChatProvider></I18nProvider>)
        expect((screen.getByRole('textbox', { name: 'Review Git instruction' }) as HTMLTextAreaElement).value).toContain('Fix parser boundary')
        expect(screen.getByRole('button', { name: 'Send instruction' })).toBeEnabled()
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('keeps the action available with an inline error when the preparation send is rejected', async () => {
        const { send } = renderControl(vi.fn(async (_text: string) => false))
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        await screen.findByText('tracked.ts')
        fireEvent.click(screen.getAllByRole('button', { name: 'Commit staged changes' })[0]!)
        await screen.findByRole('alert')
        expect(screen.getByText('tracked.ts')).toBeVisible()
        expect(send).toHaveBeenCalledTimes(1)
        expect(screen.getAllByRole('button', { name: 'Commit staged changes' })[0]).toBeEnabled()
    })
})
