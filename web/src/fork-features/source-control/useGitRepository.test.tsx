import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { GitRepositoryStatus } from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import {
    gitRepositoryQueryKey,
    useGitRepository
} from './useGitRepository'

const repository: GitRepositoryStatus = {
    repoRoot: '/repo',
    branch: 'feature/git',
    head: 'abc123',
    indexDigest: 'a'.repeat(64),
    worktreeDigest: 'b'.repeat(64),
    defaultBranch: 'main',
    baseRef: 'origin/main',
    mergeBase: 'base123',
    branchChangedFiles: 0,
    upstream: 'origin/feature/git',
    remote: 'origin',
    ahead: 1,
    behind: 0,
    dirty: false,
    scope: 'branch',
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    refs: [],
    worktrees: [],
    pullRequest: null,
    ghAvailable: true,
    ghAuthenticated: true
}

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useGitRepository', () => {
    it('reads details with the requested scope/baseRef through one shared key', async () => {
        const getGitRepository = vi.fn(async () => ({ success: true, repository }))
        const api = { getGitRepository } as unknown as ApiClient
        const { result } = renderHook(
            () => useGitRepository(api, 'session-1', 'branch', 'origin/main'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => expect(result.current.repository).toEqual(repository))

        expect(getGitRepository).toHaveBeenCalledWith('session-1', {
            details: true,
            scope: 'branch',
            baseRef: 'origin/main'
        })
        expect(result.current.error).toBeNull()
        expect(gitRepositoryQueryKey('session-1', 'branch', 'origin/main')).toEqual([
            'git-repository',
            'session-1',
            'branch',
            'origin/main'
        ])
    })

    it('keeps cached repository data when the api is disabled offline', async () => {
        const getGitRepository = vi.fn(async () => ({ success: true, repository }))
        const api = { getGitRepository } as unknown as ApiClient
        const { result, rerender } = renderHook(
            ({ reader }: { reader: ApiClient | null }) => useGitRepository(reader, 'session-1', 'working'),
            { wrapper: createWrapper(), initialProps: { reader: api as ApiClient | null } }
        )

        await waitFor(() => expect(result.current.repository).toEqual(repository))
        rerender({ reader: null })

        expect(result.current.repository).toEqual(repository)
        const callsBeforeRefetch = getGitRepository.mock.calls.length
        let refreshed: GitRepositoryStatus | null = null
        await act(async () => {
            refreshed = await result.current.refetch()
        })
        expect(refreshed).toEqual(repository)
        expect(getGitRepository).toHaveBeenCalledTimes(callsBeforeRefetch)
    })

    it('returns null when a refresh fails instead of authorizing on stale state', async () => {
        const getGitRepository = vi.fn()
            .mockResolvedValueOnce({ success: true, repository })
            .mockResolvedValueOnce({ success: false, error: 'index changed' })
            .mockRejectedValueOnce(new Error('offline'))
        const api = { getGitRepository } as unknown as ApiClient
        const { result } = renderHook(
            () => useGitRepository(api, 'session-1'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => expect(result.current.repository).toEqual(repository))

        let refreshed: GitRepositoryStatus | null = null
        await act(async () => {
            refreshed = await result.current.refetch()
        })
        expect(refreshed).toBeNull()

        await act(async () => {
            refreshed = await result.current.refetch()
        })
        expect(refreshed).toBeNull()
    })

    it('blocks legacy successful status responses until a structured runtime reconnects', async () => {
        const legacyStatus = {
            success: true,
            stdout: '# branch.head feature/git\n1 .M N... 100644 100644 100644 abc abc tracked.ts\n',
            stderr: '',
            exitCode: 0
        }
        const getGitRepository = vi.fn()
            .mockResolvedValueOnce(legacyStatus)
            .mockResolvedValueOnce(legacyStatus)
            .mockResolvedValueOnce({ success: true, repository })
        const api = { getGitRepository } as unknown as ApiClient
        const { result } = renderHook(
            () => useGitRepository(api, 'session-1'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => expect(result.current.error).toBe('git_protocol_mismatch'))
        expect(result.current.repository).toBeNull()

        await act(async () => {
            expect(await result.current.refetch()).toBeNull()
        })
        expect(result.current.error).toBe('git_protocol_mismatch')

        await act(async () => {
            expect(await result.current.refetch()).toEqual(repository)
        })
        await waitFor(() => {
            expect(result.current.error).toBeNull()
            expect(result.current.repository).toEqual(repository)
        })
    })

    it('surfaces response errors without inventing an empty repository', async () => {
        const getGitRepository = vi.fn(async () => ({ success: false, error: 'fatal: not a git repository' }))
        const api = { getGitRepository } as unknown as ApiClient
        const { result } = renderHook(
            () => useGitRepository(api, 'session-1'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => expect(result.current.error).toBe('fatal: not a git repository'))
        expect(result.current.repository).toBeNull()
    })
})
