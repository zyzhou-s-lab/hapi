import { z } from 'zod'
import type { CommandResponse } from './apiTypes'

export const GitScopeSchema = z.enum(['working', 'staged', 'unstaged', 'branch'])
export type GitScope = z.infer<typeof GitScopeSchema>

export const GitReadOptionsSchema = z.object({
    scope: GitScopeSchema.optional(),
    baseRef: z.string().min(1).max(256).optional(),
    details: z.boolean().optional()
})
export type GitReadOptions = z.infer<typeof GitReadOptionsSchema>

export type GitChange = {
    path: string
    oldPath?: string
    status: string
    staged: boolean
    unstaged: boolean
    untracked: boolean
    binary: boolean
    additions: number | null
    deletions: number | null
}

export type GitRef = { name: string; remote: boolean; current: boolean }
export type GitWorktree = { path: string; branch: string | null; head: string | null }
export type GitPullRequest = { url: string; number: number; title: string }

export type GitRepositoryStatus = {
    repoRoot: string
    branch: string | null
    head: string | null
    /** SHA-256 of `git ls-files -s -z`: exact index identity, used to reject stale confirmations. */
    indexDigest: string
    /** SHA-256 of content hashes for every unstaged and untracked path. */
    worktreeDigest: string
    defaultBranch: string | null
    baseRef: string | null
    mergeBase: string | null
    /** Unique paths changed from merge-base(baseRef, HEAD) to HEAD; null when no base ref is known. */
    branchChangedFiles: number | null
    upstream: string | null
    remote: string | null
    ahead: number
    behind: number
    dirty: boolean
    scope: GitScope
    files: GitChange[]
    stagedFiles: GitChange[]
    unstagedFiles: GitChange[]
    refs: GitRef[]
    worktrees: GitWorktree[]
    pullRequest: GitPullRequest | null
    ghAvailable: boolean
    ghAuthenticated: boolean
    pullRequestError?: string
    blockedReason?: string
}

export type GitRepositoryResponse = CommandResponse & { repository?: GitRepositoryStatus }

export const GitActionKindSchema = z.enum([
    'stage', 'commit', 'push', 'pull', 'pr', 'commit-push', 'commit-push-pr'
])
export type GitActionKind = z.infer<typeof GitActionKindSchema>

export const GitActionRequestSchema = z.object({
    action: GitActionKindSchema,
    expectedHead: z.string().nullable(),
    expectedBranch: z.string().nullable(),
    expectedIndexDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    expectedWorktreeDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    paths: z.array(z.string().min(1)).max(1000).optional(),
    message: z.string().max(100_000).optional(),
    remote: z.string().min(1).max(256).optional(),
    baseRef: z.string().min(1).max(256).optional(),
    title: z.string().max(1000).optional(),
    body: z.string().max(100_000).optional(),
    confirmDefaultBranch: z.boolean().optional()
})
export type GitActionRequest = z.infer<typeof GitActionRequestSchema>
export type GitActionStep = {
    action: 'stage' | 'commit' | 'push' | 'pull' | 'pr'
    success: boolean
    output: string
}
export type GitActionResponse = {
    success: boolean
    steps: GitActionStep[]
    error?: string
    head?: string | null
    pullRequestUrl?: string
}
