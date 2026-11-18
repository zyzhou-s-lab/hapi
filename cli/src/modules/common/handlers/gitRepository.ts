import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
    GitChange,
    GitChangesSummary,
    GitPullRequest,
    GitPullRequestChecks,
    GitPullRequestState,
    GitRef,
    GitRepositoryStatus,
    GitScope,
    GitWorktree
} from '@hapi/protocol/sourceControl'
import { validatePath } from '../pathSecurity'
import {
    GH_PROBE_TIMEOUT_MS,
    READ_TIMEOUT_MS,
    runCommand,
    runGit,
    sanitizeGitOutput
} from './gitExec'

export type RepositoryContext = {
    cwd: string
    repoRoot: string
}

export type StatusEntry = {
    path: string
    oldPath?: string
    x: string
    y: string
    kind: 'ordinary' | 'rename' | 'unmerged'
    sub: string
}

export type ParsedStatus = {
    head: string | null
    branch: string | null
    upstream: string | null
    ahead: number
    behind: number
    entries: StatusEntry[]
}

export type Numstat = {
    additions: number | null
    deletions: number | null
    binary: boolean
}

export type ActionState = {
    repoRoot: string
    head: string | null
    branch: string | null
    indexDigest: string
    worktreeDigest: string
    entries: StatusEntry[]
    staged: StatusEntry[]
    unstaged: StatusEntry[]
    untracked: StatusEntry[]
    trackedDirty: boolean
    unmerged: boolean
    upstream: string | null
    ahead: number
    behind: number
    remote: string | null
    remotes: string[]
    defaultBranch: string | null
}

export type GitHubState = {
    available: boolean
    authenticated: boolean
    pullRequest: GitPullRequest | null
    pullRequestError?: string
}

export type RepositoryReadOptions = {
    scope?: GitScope
    baseRef?: string
    timeoutMs?: number
    includeGitHub?: boolean
}

export type ScopedDiffOptions = {
    filePath: string
    scope?: GitScope
    baseRef?: string
    timeoutMs?: number
}

const UNBORN_HEAD = '(initial)'
const DETACHED_HEAD = '(detached)'

async function safeRealpath(path: string): Promise<string | null> {
    try {
        return await realpath(path)
    } catch {
        return null
    }
}

export async function resolveRepositoryContext(
    requestedCwd: string | undefined,
    workingDirectory: string
): Promise<{ context?: RepositoryContext; error?: string }> {
    const cwd = requestedCwd ?? workingDirectory
    const validation = validatePath(cwd, workingDirectory)
    if (!validation.valid) {
        return { error: validation.error ?? 'Invalid working directory' }
    }

    const resolvedCwd = (await safeRealpath(resolve(cwd))) ?? resolve(cwd)
    const topLevel = await runGit(['rev-parse', '--show-toplevel'], resolvedCwd)
    if (!topLevel.success) {
        return { error: sanitizeGitOutput(topLevel.stderr || 'Not a git repository') }
    }
    const rawRoot = topLevel.stdout.trim()
    if (!rawRoot) {
        return { error: 'Not a git repository' }
    }
    const repoRoot = (await safeRealpath(rawRoot)) ?? rawRoot
    return { context: { cwd: resolvedCwd, repoRoot } }
}

export function parsePorcelainV2(output: string): ParsedStatus {
    const tokens = output.split('\0')
    const entries: StatusEntry[] = []
    let head: string | null = null
    let branch: string | null = null
    let upstream: string | null = null
    let ahead = 0
    let behind = 0

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (!token) continue

        if (token.startsWith('# ')) {
            const line = token.slice(2)
            const separator = line.indexOf(' ')
            const key = separator === -1 ? line : line.slice(0, separator)
            const value = separator === -1 ? '' : line.slice(separator + 1)
            if (key === 'branch.oid') {
                head = value === UNBORN_HEAD ? null : value
            } else if (key === 'branch.head') {
                branch = value === DETACHED_HEAD ? null : value
            } else if (key === 'branch.upstream') {
                upstream = value
            } else if (key === 'branch.ab') {
                const match = /^\+(\d+) -(\d+)$/.exec(value)
                if (match) {
                    ahead = Number(match[1])
                    behind = Number(match[2])
                }
            }
            continue
        }

        if (token.startsWith('1 ')) {
            const parts = token.split(' ')
            const xy = parts[1] ?? '..'
            entries.push({
                path: parts.slice(8).join(' '),
                x: xy[0] ?? '.',
                y: xy[1] ?? '.',
                kind: 'ordinary',
                sub: parts[2] ?? '..'
            })
        } else if (token.startsWith('2 ')) {
            const parts = token.split(' ')
            const xy = parts[1] ?? '..'
            entries.push({
                path: parts.slice(9).join(' '),
                oldPath: tokens[index + 1] ?? undefined,
                x: xy[0] ?? '.',
                y: xy[1] ?? '.',
                kind: 'rename',
                sub: parts[2] ?? '..'
            })
            index += 1
        } else if (token.startsWith('u ')) {
            const parts = token.split(' ')
            const xy = parts[1] ?? 'UU'
            entries.push({
                path: parts.slice(10).join(' '),
                x: xy[0] ?? 'U',
                y: xy[1] ?? 'U',
                kind: 'unmerged',
                sub: parts[2] ?? '..'
            })
        } else if (token.startsWith('? ')) {
            entries.push({
                path: token.slice(2),
                x: '?',
                y: '?',
                kind: 'ordinary',
                sub: '..'
            })
        }
    }

    return { head, branch, upstream, ahead, behind, entries }
}

export function parseNumstatZ(output: string): Map<string, Numstat> {
    const tokens = output.split('\0')
    const stats = new Map<string, Numstat>()

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (!token) continue
        const firstTab = token.indexOf('\t')
        const secondTab = firstTab === -1 ? -1 : token.indexOf('\t', firstTab + 1)
        if (firstTab === -1 || secondTab === -1) continue

        const rawAdditions = token.slice(0, firstTab)
        const rawDeletions = token.slice(firstTab + 1, secondTab)
        const additions = /^\d+$/.test(rawAdditions) ? Number(rawAdditions) : null
        const deletions = /^\d+$/.test(rawDeletions) ? Number(rawDeletions) : null
        const rest = token.slice(secondTab + 1)
        let path = rest
        if (rest === '') {
            path = tokens[index + 2] ?? ''
            index += 2
        }
        if (!path) continue
        stats.set(path, {
            additions,
            deletions,
            binary: additions === null || deletions === null
        })
    }

    return stats
}

function parseNameStatusZ(output: string): StatusEntry[] {
    const tokens = output.split('\0')
    const entries: StatusEntry[] = []

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (!token) continue
        const code = token[0] ?? 'M'
        if (code === 'R' || code === 'C') {
            const oldPath = tokens[index + 1] ?? ''
            const path = tokens[index + 2] ?? ''
            index += 2
            if (path) {
                entries.push({ path, oldPath, x: code, y: '.', kind: 'rename', sub: '..' })
            }
        } else {
            const path = tokens[index + 1] ?? ''
            index += 1
            if (path) {
                entries.push({ path, x: code, y: '.', kind: 'ordinary', sub: '..' })
            }
        }
    }

    return entries
}

async function readStatus(repoRoot: string, timeoutMs: number): Promise<{ status?: ParsedStatus; error?: string }> {
    const result = await runGit(
        ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        repoRoot,
        timeoutMs
    )
    if (!result.success) {
        return { error: sanitizeGitOutput(result.stderr || 'Unable to read git status') }
    }
    return { status: parsePorcelainV2(result.stdout) }
}

async function readHead(repoRoot: string, timeoutMs: number): Promise<string | null> {
    const result = await runGit(['rev-parse', '--verify', 'HEAD'], repoRoot, timeoutMs)
    if (!result.success) return null
    const head = result.stdout.trim()
    return head || null
}

async function readNumstat(
    repoRoot: string,
    args: string[],
    timeoutMs: number
): Promise<{ stats?: Map<string, Numstat>; error?: string }> {
    const result = await runGit([...args, '--numstat', '-z'], repoRoot, timeoutMs)
    if (!result.success) {
        return { error: sanitizeGitOutput(result.stderr || 'Unable to read git diff statistics') }
    }
    return { stats: parseNumstatZ(result.stdout) }
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return []
    const results = new Array<R>(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = cursor
            cursor += 1
            if (index >= items.length) return
            results[index] = await task(items[index])
        }
    })
    await Promise.all(workers)
    return results
}

async function countAgainstEmpty(repoRoot: string, repoRelativePath: string, timeoutMs: number): Promise<Numstat> {
    const absolutePath = resolve(repoRoot, repoRelativePath)
    const result = await runGit(
        ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', basename(absolutePath)],
        dirname(absolutePath),
        timeoutMs
    )
    if (result.exitCode === 0) {
        return { additions: 0, deletions: 0, binary: false }
    }
    const stats = parseNumstatZ(result.stdout)
    const first = stats.values().next().value as Numstat | undefined
    if (first) return first
    return { additions: null, deletions: null, binary: false }
}

async function countUntracked(
    repoRoot: string,
    paths: string[],
    timeoutMs: number
): Promise<Map<string, Numstat>> {
    const entries = await mapWithConcurrency(paths, 8, async (path) => {
        const stat = await countAgainstEmpty(repoRoot, path, timeoutMs)
        return [path, stat] as const
    })
    return new Map(entries)
}

function mergeStats(base: Map<string, Numstat>, extra: Map<string, Numstat>): Map<string, Numstat> {
    if (extra.size === 0) return base
    const merged = new Map(base)
    for (const [path, stat] of extra) {
        if (!merged.has(path)) merged.set(path, stat)
    }
    return merged
}

export function isWithinWorkingDirectory(
    repoRoot: string,
    relativePath: string,
    workingDirectory: string
): boolean {
    const absolutePath = resolve(repoRoot, relativePath)
    return validatePath(absolutePath, workingDirectory).valid
}

function statusLabel(entry: StatusEntry): GitChange['status'] {
    if (entry.x === '?') return 'untracked'
    if (entry.kind === 'unmerged' || entry.x === 'U' || entry.y === 'U') return 'conflicted'
    const code = entry.x !== '.' && entry.x !== ' ' ? entry.x : entry.y
    switch (code) {
        case 'A':
            return 'added'
        case 'D':
            return 'deleted'
        case 'R':
        case 'C':
            return 'renamed'
        case 'M':
        default:
            return 'modified'
    }
}

function buildChange(
    entry: StatusEntry,
    stats: Map<string, Numstat>,
    flags: { staged: boolean; unstaged: boolean; untracked: boolean },
    binaryFallback = false
): GitChange {
    const stat = stats.get(entry.path)
    const unknown = stat === undefined && entry.sub.startsWith('S')
    return {
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        status: statusLabel(entry),
        staged: flags.staged,
        unstaged: flags.unstaged,
        untracked: flags.untracked,
        binary: stat?.binary ?? binaryFallback,
        additions: stat ? stat.additions : unknown ? null : 0,
        deletions: stat ? stat.deletions : unknown ? null : 0
    }
}

function uniqueChanges(changes: GitChange[]): GitChange[] {
    const byPath = new Map<string, GitChange>()
    for (const change of changes) {
        const existing = byPath.get(change.path)
        if (!existing) {
            byPath.set(change.path, change)
            continue
        }
        existing.staged = existing.staged || change.staged
        existing.unstaged = existing.unstaged || change.unstaged
        existing.untracked = existing.untracked || change.untracked
    }
    return [...byPath.values()]
}

export async function listRemotes(repoRoot: string, timeoutMs = READ_TIMEOUT_MS): Promise<string[]> {
    const result = await runGit(['remote'], repoRoot, timeoutMs)
    if (!result.success) return []
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
}

export function findRemoteForUpstream(upstream: string | null, remotes: string[]): string | null {
    if (!upstream) return null
    const ordered = [...remotes].sort((a, b) => b.length - a.length)
    for (const remote of ordered) {
        if (upstream === remote || upstream.startsWith(`${remote}/`)) return remote
    }
    return null
}

export async function detectDefaultBranch(
    repoRoot: string,
    remotes: string[],
    trackingRemote: string | null,
    timeoutMs = READ_TIMEOUT_MS,
    options?: { currentBranch?: string | null; upstream?: string | null }
): Promise<string | null> {
    if (remotes.length === 0) return null
    const result = await runGit(
        ['for-each-ref', '--format=%(refname)%00%(symref)%00%(upstream:short)', 'refs/remotes', 'refs/heads/main', 'refs/heads/master'],
        repoRoot,
        timeoutMs
    )
    if (!result.success) return null

    const candidates: Array<{ remote: string; target: string }> = []
    const remoteBranches = new Set<string>()
    const localUpstreams = new Map<string, string>()
    for (const line of result.stdout.split('\n')) {
        if (!line) continue
        const [refname, symref, upstreamShort] = line.split('\0')
        if (!refname) continue
        if (refname.startsWith('refs/heads/')) {
            if (upstreamShort) {
                localUpstreams.set(refname.slice('refs/heads/'.length), upstreamShort)
            }
            continue
        }
        if (refname.startsWith('refs/remotes/') && !refname.endsWith('/HEAD')) {
            remoteBranches.add(refname.slice('refs/remotes/'.length))
        }
        if (!symref) continue
        const match = /^refs\/remotes\/(.+)\/HEAD$/.exec(refname)
        if (!match) continue
        const target = symref.startsWith('refs/remotes/')
            ? symref.slice('refs/remotes/'.length)
            : symref
        candidates.push({ remote: match[1], target })
    }

    const preferred = candidates.find((candidate) => candidate.remote === trackingRemote)
        ?? candidates.find((candidate) => candidate.remote === 'origin')
        ?? candidates[0]
    if (preferred?.target) return preferred.target

    const remotePriority: string[] = []
    for (const candidate of [trackingRemote, 'origin', ...remotes]) {
        if (candidate && remotes.includes(candidate) && !remotePriority.includes(candidate)) {
            remotePriority.push(candidate)
        }
    }
    if (
        (options?.currentBranch === 'main' || options?.currentBranch === 'master')
        && options.upstream
        && remoteBranches.has(options.upstream)
    ) {
        return options.upstream
    }
    if (!trackingRemote) {
        for (const branchName of ['main', 'master']) {
            const localUpstream = localUpstreams.get(branchName)
            if (localUpstream && remoteBranches.has(localUpstream)) {
                return localUpstream
            }
        }
    }
    for (const branchName of ['main', 'master']) {
        for (const remote of remotePriority) {
            const ref = `${remote}/${branchName}`
            if (remoteBranches.has(ref)) return ref
        }
    }
    return null
}

export function resolvePreferredRemote(
    remotes: string[],
    trackingRemote: string | null,
    defaultBranch: string | null
): string | null {
    if (remotes.length === 0) return null
    return trackingRemote
        ?? findRemoteForUpstream(defaultBranch, remotes)
        ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null)
}

async function listRefs(
    repoRoot: string,
    remotes: string[],
    currentBranch: string | null,
    timeoutMs: number
): Promise<GitRef[]> {
    const result = await runGit(
        ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
        repoRoot,
        timeoutMs
    )
    if (!result.success) return []

    const locals: GitRef[] = []
    const remoteRefs: GitRef[] = []
    for (const line of result.stdout.split('\n')) {
        const refname = line.trim()
        if (!refname) continue
        if (refname.startsWith('refs/heads/')) {
            const name = refname.slice('refs/heads/'.length)
            locals.push({ name, remote: false, current: name === currentBranch })
        } else if (refname.startsWith('refs/remotes/')) {
            if (refname.endsWith('/HEAD')) continue
            const name = refname.slice('refs/remotes/'.length)
            if (!name) continue
            remoteRefs.push({ name, remote: true, current: false })
        }
    }
    const sortedLocals = locals.sort((a, b) => a.name.localeCompare(b.name))
    const sortedRemotes = remoteRefs.sort((a, b) => a.name.localeCompare(b.name))
    if (remotes.length === 0) return sortedLocals
    return [...sortedLocals, ...sortedRemotes]
}

async function listWorktrees(repoRoot: string, timeoutMs: number): Promise<GitWorktree[]> {
    const result = await runGit(['worktree', 'list', '--porcelain'], repoRoot, timeoutMs)
    if (!result.success) return []

    const worktrees: GitWorktree[] = []
    for (const block of result.stdout.split(/\n\s*\n/)) {
        const lines = block.split('\n').filter(Boolean)
        if (lines.length === 0) continue
        let path: string | null = null
        let head: string | null = null
        let branch: string | null = null
        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                path = line.slice('worktree '.length)
            } else if (line.startsWith('HEAD ')) {
                head = line.slice('HEAD '.length)
            } else if (line.startsWith('branch refs/heads/')) {
                branch = line.slice('branch refs/heads/'.length)
            }
        }
        if (path) worktrees.push({ path, branch, head })
    }
    return worktrees
}

export async function computeStateDigests(
    repoRoot: string,
    entries: StatusEntry[],
    timeoutMs = READ_TIMEOUT_MS
): Promise<{ indexDigest: string; worktreeDigest: string } | { error: string }> {
    const index = await runGit(['ls-files', '-s', '-z'], repoRoot, timeoutMs)
    if (!index.success) {
        return { error: sanitizeGitOutput(index.stderr || 'Unable to read the git index') }
    }
    const unstaged = await runGit(['diff', '--name-only', '-z', '--no-ext-diff'], repoRoot, timeoutMs)
    if (!unstaged.success) {
        return { error: sanitizeGitOutput(unstaged.stderr || 'Unable to read the worktree diff') }
    }

    const changedPaths = new Set(unstaged.stdout.split('\0').filter(Boolean))
    for (const entry of entries) {
        if (entry.x === '?') changedPaths.add(entry.path)
    }
    const identities = await mapWithConcurrency([...changedPaths].sort(), 8, async (path) => {
        const hash = await runGit(['hash-object', '--', path], repoRoot, timeoutMs)
        return hash.success ? `${path}\0${hash.stdout.trim()}` : `${path}\0missing`
    })

    const worktreeHash = createHash('sha256')
    worktreeHash.update(identities.join('\0'))

    return {
        indexDigest: createHash('sha256').update(index.stdout).digest('hex'),
        worktreeDigest: worktreeHash.digest('hex')
    }
}

export function localBranchName(defaultBranch: string | null, remotes: string[]): string | null {
    if (!defaultBranch) return null
    const ordered = [...remotes].sort((a, b) => b.length - a.length)
    for (const remote of ordered) {
        if (defaultBranch.startsWith(`${remote}/`)) return defaultBranch.slice(remote.length + 1)
    }
    return defaultBranch
}

const FAILING_CHECK_CONCLUSIONS = new Set([
    'FAILURE',
    'TIMED_OUT',
    'CANCELLED',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE'
])
const FAILING_CHECK_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_CHECK_STATES = new Set(['PENDING', 'EXPECTED'])
const PR_VIEW_FIELDS = 'url,number,title,state,isDraft,baseRefName,headRefName,statusCheckRollup'
const PR_LIST_FIELDS = `${PR_VIEW_FIELDS},mergeCommit`
const PR_NOT_FOUND_PATTERN = /no pull requests? found|could not find a pull request|no open pull requests/i

export function parseGitHubRepoSlug(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim()
    if (!trimmed || trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.startsWith('.') || trimmed.startsWith('file://')) {
        return null
    }
    let host: string | undefined
    let path: string | undefined
    const urlMatch = /^https?:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(trimmed)
    if (urlMatch) {
        host = urlMatch[1]
        path = urlMatch[2]
    } else {
        const sshSchemeMatch = /^ssh:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(trimmed)
        if (sshSchemeMatch) {
            host = sshSchemeMatch[1]
            path = sshSchemeMatch[2]
        } else {
            const scpMatch = /^(?:[^/@]+@)?([^/:]+):([^/].*?)(?:\.git)?\/?$/.exec(trimmed)
            if (scpMatch) {
                host = scpMatch[1]
                path = scpMatch[2]
            }
        }
    }
    if (!host || !path || !host.includes('.')) return null
    const segments = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean)
    if (segments.length < 2) return null
    const slug = segments.slice(0, 2).join('/')
    return host.toLowerCase() === 'github.com' ? slug : `${host}/${slug}`
}

export async function resolveRemoteGitHubSlug(
    repoRoot: string,
    remote: string,
    timeoutMs = READ_TIMEOUT_MS
): Promise<string | null> {
    const urlResult = await runGit(['remote', 'get-url', remote], repoRoot, timeoutMs)
    if (!urlResult.success) return null
    return parseGitHubRepoSlug(urlResult.stdout)
}

export function classifyGitHubChecks(rollup: unknown): GitPullRequestChecks {
    if (!Array.isArray(rollup) || rollup.length === 0) return null
    let hasPending = false
    for (const item of rollup) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : null
        const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : null
        const state = typeof entry.state === 'string' ? entry.state.toUpperCase() : null

        if ((conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) || (state && FAILING_CHECK_STATES.has(state))) {
            return 'failing'
        }
        const isCheckRun = entry.__typename === 'CheckRun' || 'status' in entry || 'conclusion' in entry
        if (isCheckRun) {
            if (status !== 'COMPLETED' || !conclusion) {
                hasPending = true
            }
        } else if (state && PENDING_CHECK_STATES.has(state)) {
            hasPending = true
        }
    }
    return hasPending ? 'pending' : 'passing'
}

function normalizePullRequestState(value: unknown): GitPullRequestState | undefined {
    if (typeof value !== 'string') return undefined
    const upper = value.toUpperCase()
    if (upper === 'OPEN') return 'open'
    if (upper === 'MERGED') return 'merged'
    if (upper === 'CLOSED') return 'closed'
    return undefined
}

export function normalizeGitHubPullRequest(parsed: unknown): GitPullRequest | null {
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.url !== 'string' || typeof record.number !== 'number' || typeof record.title !== 'string') {
        return null
    }
    const state = normalizePullRequestState(record.state) ?? 'open'
    const checks = classifyGitHubChecks(record.statusCheckRollup)
    return {
        url: record.url,
        number: record.number,
        title: record.title,
        state,
        ...(typeof record.isDraft === 'boolean' ? { isDraft: record.isDraft } : {}),
        checks,
        ...(typeof record.baseRefName === 'string' && record.baseRefName ? { baseRefName: record.baseRefName } : {}),
        ...(typeof record.headRefName === 'string' && record.headRefName ? { headRefName: record.headRefName } : {})
    }
}

export function parseGitHubPullRequest(raw: string): GitPullRequest | null {
    try {
        return normalizeGitHubPullRequest(JSON.parse(raw))
    } catch {
        return null
    }
}

async function resolveCandidateGitHubSlugs(
    repoRoot: string,
    options: { remotes?: string[]; preferredRemote?: string | null; defaultBranch?: string | null },
    timeoutMs: number
): Promise<string[]> {
    const remotes = options.remotes ?? []
    if (remotes.length === 0) return []
    const defaultRemote = findRemoteForUpstream(options.defaultBranch ?? null, remotes)
    const orderedRemotes: string[] = []
    for (const candidate of [options.preferredRemote, defaultRemote, 'origin', ...remotes]) {
        if (candidate && remotes.includes(candidate) && !orderedRemotes.includes(candidate)) {
            orderedRemotes.push(candidate)
        }
    }
    const slugs: string[] = []
    for (const remote of orderedRemotes) {
        const slug = await resolveRemoteGitHubSlug(repoRoot, remote, timeoutMs)
        if (slug && !slugs.includes(slug)) {
            slugs.push(slug)
        }
    }
    return slugs
}

function findMergedPrForHead(raw: string, head: string): GitPullRequest | null {
    try {
        const list = JSON.parse(raw) as unknown
        if (!Array.isArray(list)) return null
        for (const item of list) {
            if (!item || typeof item !== 'object') continue
            const mergeCommit = (item as { mergeCommit?: { oid?: unknown } | null }).mergeCommit
            if (mergeCommit && mergeCommit.oid === head) {
                return normalizeGitHubPullRequest(item)
            }
        }
        return null
    } catch {
        return null
    }
}

export async function readGitHubState(
    context: RepositoryContext,
    timeoutMs = READ_TIMEOUT_MS,
    ghCommand = 'gh',
    options?: {
        branch?: string | null
        head?: string | null
        isDefaultBranch?: boolean
        remotes?: string[]
        preferredRemote?: string | null
        defaultBranch?: string | null
    }
): Promise<GitHubState> {
    const version = await runCommand(ghCommand, ['--version'], {
        cwd: context.repoRoot,
        timeoutMs: GH_PROBE_TIMEOUT_MS
    })
    if (!version.success) {
        return { available: false, authenticated: false, pullRequest: null }
    }

    const auth = await runCommand(ghCommand, ['auth', 'status'], {
        cwd: context.repoRoot,
        timeoutMs: GH_PROBE_TIMEOUT_MS
    })
    if (!auth.success) {
        return {
            available: true,
            authenticated: false,
            pullRequest: null,
            ...(auth.timedOut ? { pullRequestError: sanitizeGitOutput(auth.stderr) } : {})
        }
    }

    const probeTimeout = Math.min(timeoutMs, GH_PROBE_TIMEOUT_MS)
    const slugs = await resolveCandidateGitHubSlugs(context.repoRoot, options ?? {}, timeoutMs)
    if (slugs.length === 0) {
        const view = await runCommand(ghCommand, ['pr', 'view', '--json', PR_VIEW_FIELDS], {
            cwd: context.repoRoot,
            timeoutMs: probeTimeout
        })
        if (view.success) {
            return {
                available: true,
                authenticated: true,
                pullRequest: parseGitHubPullRequest(view.stdout)
            }
        }
        if (PR_NOT_FOUND_PATTERN.test(view.stderr)) {
            return { available: true, authenticated: true, pullRequest: null }
        }
        return {
            available: true,
            authenticated: true,
            pullRequest: null,
            pullRequestError: sanitizeGitOutput(view.stderr || 'Unable to read the pull request')
        }
    }

    let lastError: string | undefined
    if (options?.branch) {
        for (const slug of slugs) {
            const view = await runCommand(ghCommand, ['pr', 'view', options.branch, '-R', slug, '--json', PR_VIEW_FIELDS], {
                cwd: context.repoRoot,
                timeoutMs: probeTimeout
            })
            if (view.success) {
                const pullRequest = parseGitHubPullRequest(view.stdout)
                if (pullRequest) {
                    return { available: true, authenticated: true, pullRequest }
                }
            } else if (!PR_NOT_FOUND_PATTERN.test(view.stderr)) {
                lastError = sanitizeGitOutput(view.stderr || 'Unable to read the pull request')
            }
        }
    }

    if (options?.head && options.isDefaultBranch) {
        for (const slug of slugs) {
            const list = await runCommand(
                ghCommand,
                ['pr', 'list', '-R', slug, '--state', 'merged', '--search', options.head, '--limit', '5', '--json', PR_LIST_FIELDS],
                { cwd: context.repoRoot, timeoutMs: probeTimeout }
            )
            if (list.success) {
                const matched = findMergedPrForHead(list.stdout, options.head)
                if (matched) {
                    return { available: true, authenticated: true, pullRequest: matched }
                }
            } else {
                lastError = lastError ?? sanitizeGitOutput(list.stderr || 'Unable to list pull requests')
            }
        }
    }

    return {
        available: true,
        authenticated: true,
        pullRequest: null,
        ...(lastError ? { pullRequestError: lastError } : {})
    }
}

async function readBranchEntries(
    repoRoot: string,
    mergeBase: string,
    timeoutMs: number
): Promise<{ entries?: StatusEntry[]; error?: string }> {
    const nameStatus = await runGit(
        ['diff', '--name-status', '-z', '--no-ext-diff', mergeBase, 'HEAD'],
        repoRoot,
        timeoutMs
    )
    if (!nameStatus.success) {
        return { error: sanitizeGitOutput(nameStatus.stderr || 'Unable to compare branches') }
    }
    return { entries: parseNameStatusZ(nameStatus.stdout) }
}

async function readBranchStats(
    repoRoot: string,
    mergeBase: string,
    timeoutMs: number
): Promise<{ stats?: Map<string, Numstat>; error?: string }> {
    const stats = await readNumstat(repoRoot, ['diff', '--no-ext-diff', mergeBase, 'HEAD'], timeoutMs)
    if (stats.error) return { error: stats.error }
    return { stats: stats.stats ?? new Map() }
}

function sumVisibleStats(
    stats: Map<string, Numstat>,
    repoRoot: string,
    workingDirectory: string
): { insertions: number; deletions: number; unknown: boolean } {
    let insertions = 0
    let deletions = 0
    let unknown = false
    for (const [path, stat] of stats) {
        if (!isWithinWorkingDirectory(repoRoot, path, workingDirectory)) continue
        if (stat.additions !== null && stat.deletions !== null) {
            insertions += stat.additions
            deletions += stat.deletions
        } else if (!stat.binary) {
            unknown = true
        }
    }
    return { insertions, deletions, unknown }
}

async function computeChangesSummary(input: {
    repoRoot: string
    workingDirectory: string
    timeoutMs: number
    scope: GitScope
    status: ParsedStatus
    mergeBase: string | null
    baseRef: string | null
    scopeStatsMap?: Map<string, Numstat>
    untrackedStats: Map<string, Numstat>
}): Promise<GitChangesSummary> {
    if (input.baseRef && input.mergeBase) {
        const branchTree = await readNumstat(
            input.repoRoot,
            ['diff', '--no-ext-diff', input.mergeBase],
            input.timeoutMs
        )
        if (!branchTree.error && branchTree.stats) {
            const combined = mergeStats(branchTree.stats, input.untrackedStats)
            const totals = sumVisibleStats(combined, input.repoRoot, input.workingDirectory)
            return {
                insertions: totals.insertions,
                deletions: totals.deletions,
                baseRef: input.baseRef,
                ...(totals.unknown ? { unknown: true } : {})
            }
        }
    }

    const workingStats = input.scope === 'working'
        ? input.scopeStatsMap
        : (await loadScopeStats({
            repoRoot: input.repoRoot,
            timeoutMs: input.timeoutMs,
            scope: 'working',
            status: input.status,
            mergeBase: input.mergeBase,
            baseRef: input.baseRef,
            untrackedStats: input.untrackedStats
        })).stats
    const totals = sumVisibleStats(workingStats ?? new Map(), input.repoRoot, input.workingDirectory)
    return {
        insertions: totals.insertions,
        deletions: totals.deletions,
        baseRef: null,
        ...(totals.unknown ? { unknown: true } : {})
    }
}

export async function readRepositoryStatus(
    context: RepositoryContext,
    workingDirectory: string,
    options: RepositoryReadOptions = {}
): Promise<{ repository?: GitRepositoryStatus; error?: string }> {
    const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
    const statusResult = await readStatus(context.repoRoot, timeoutMs)
    if (!statusResult.status) {
        return { error: statusResult.error ?? 'Unable to read git status' }
    }
    const status = statusResult.status
    const repoRoot = context.repoRoot
    const scope: GitScope = options.scope ?? 'working'

    const remotes = await listRemotes(repoRoot, timeoutMs)
    const trackingRemote = findRemoteForUpstream(status.upstream, remotes)
    const defaultBranch = await detectDefaultBranch(repoRoot, remotes, trackingRemote, timeoutMs, {
        currentBranch: status.branch,
        upstream: status.upstream
    })
    const remote = resolvePreferredRemote(remotes, trackingRemote, defaultBranch)
    const baseRef = options.baseRef ?? defaultBranch
    const defaultLocal = localBranchName(defaultBranch, remotes)
    const isDefaultBranch = Boolean(
        status.branch
        && (defaultLocal
            ? status.branch === defaultLocal
            : remotes.length > 0 && (status.branch === 'main' || status.branch === 'master'))
    )

    const visibleEntries = status.entries.filter((entry) => (
        isWithinWorkingDirectory(repoRoot, entry.path, workingDirectory)
    ))
    const visibleUntracked = visibleEntries.filter((entry) => entry.x === '?').map((entry) => entry.path)
    const visibleStagedEntries = visibleEntries.filter((entry) => entry.x !== '.' && entry.x !== '?')
    const visibleUnstagedEntries = visibleEntries.filter((entry) => entry.y !== '.' && entry.x !== '?')

    let mergeBase: string | null = null
    if (baseRef) {
        const mergeBaseResult = await runGit(['merge-base', baseRef, 'HEAD'], repoRoot, timeoutMs)
        if (mergeBaseResult.success) {
            mergeBase = mergeBaseResult.stdout.trim() || null
        }
    }

    let branchEntries: StatusEntry[] | undefined
    let branchChangedFiles: number | null = null
    if (baseRef && mergeBase) {
        const branchResult = await readBranchEntries(repoRoot, mergeBase, timeoutMs)
        if (branchResult.entries) {
            branchEntries = branchResult.entries
            branchChangedFiles = branchEntries.length
        } else if (scope === 'branch') {
            return { error: branchResult.error ?? 'Unable to compare branches' }
        }
    }

    const indexLayer = await loadIndexLayerStats(repoRoot, timeoutMs, visibleUntracked)
    if (indexLayer.error) {
        return { error: indexLayer.error }
    }

    const scopeStats = await loadScopeStats({
        repoRoot,
        timeoutMs,
        scope,
        status,
        mergeBase,
        baseRef,
        branchEntries,
        untrackedStats: indexLayer.untrackedStats
    })
    if (scopeStats.error) {
        return { error: scopeStats.error }
    }

    const stagedFiles = uniqueChanges(visibleStagedEntries.map((entry) => buildChange(entry, indexLayer.stagedStats, {
        staged: true,
        unstaged: false,
        untracked: false
    })))
    const unstagedFiles = uniqueChanges([
        ...visibleUnstagedEntries.map((entry) => buildChange(entry, indexLayer.unstagedStats, {
            staged: false,
            unstaged: true,
            untracked: false
        })),
        ...visibleEntries
            .filter((entry) => entry.x === '?')
            .map((entry) => buildChange(entry, indexLayer.unstagedStats, {
                staged: false,
                unstaged: true,
                untracked: true
            }))
    ])

    let files: GitChange[]
    if (scope === 'branch') {
        files = (scopeStats.branchChanges ?? []).filter((change) => (
            isWithinWorkingDirectory(repoRoot, change.path, workingDirectory)
        ))
    } else if (scope === 'staged') {
        files = stagedFiles
    } else if (scope === 'unstaged') {
        files = unstagedFiles
    } else {
        files = uniqueChanges([
            ...visibleEntries
                .filter((entry) => entry.x !== '?')
                .map((entry) => buildChange(entry, scopeStats.stats ?? new Map(), {
                    staged: entry.x !== '.' && entry.x !== ' ',
                    unstaged: entry.y !== '.' && entry.y !== ' ',
                    untracked: false
                }, indexLayer.stagedStats.get(entry.path)?.binary === true
                    || indexLayer.unstagedStats.get(entry.path)?.binary === true)),
            ...visibleEntries
                .filter((entry) => entry.x === '?')
                .map((entry) => buildChange(entry, scopeStats.stats ?? new Map(), {
                    staged: false,
                    unstaged: true,
                    untracked: true
                }))
        ])
    }

    const [refs, worktrees, digests, github, changesSummary] = await Promise.all([
        listRefs(repoRoot, remotes, status.branch, timeoutMs),
        listWorktrees(repoRoot, timeoutMs),
        computeStateDigests(repoRoot, status.entries, timeoutMs),
        options.includeGitHub === false
            ? Promise.resolve<GitHubState>({ available: false, authenticated: false, pullRequest: null })
            : readGitHubState(context, timeoutMs, 'gh', {
                branch: status.branch,
                head: status.head,
                isDefaultBranch,
                remotes,
                preferredRemote: remote,
                defaultBranch
            }),
        computeChangesSummary({
            repoRoot,
            workingDirectory,
            timeoutMs,
            scope,
            status,
            mergeBase,
            baseRef,
            scopeStatsMap: scopeStats.stats,
            untrackedStats: indexLayer.untrackedStats
        })
    ])

    if ('error' in digests) {
        return { error: digests.error }
    }

    const unmerged = status.entries.some((entry) => entry.kind === 'unmerged')
    let blockedReason: string | undefined
    if (status.branch === null) {
        blockedReason = 'Detached HEAD: checkout a branch before publishing.'
    } else if (unmerged) {
        blockedReason = 'Unresolved merge conflicts block commit and publication.'
    } else if (status.ahead > 0 && status.behind > 0) {
        blockedReason = 'Branch has diverged from its upstream; sync manually before publishing.'
    }

    const repository: GitRepositoryStatus = {
        repoRoot,
        branch: status.branch,
        head: status.head,
        indexDigest: digests.indexDigest,
        worktreeDigest: digests.worktreeDigest,
        defaultBranch,
        baseRef,
        mergeBase,
        branchChangedFiles,
        upstream: status.upstream,
        remote,
        remotes,
        isDefaultBranch,
        ahead: status.ahead,
        behind: status.behind,
        dirty: visibleEntries.length > 0,
        scope,
        files,
        stagedFiles,
        unstagedFiles,
        changesSummary,
        refs,
        worktrees,
        pullRequest: github.pullRequest,
        ghAvailable: github.available,
        ghAuthenticated: github.authenticated,
        ...(github.pullRequestError ? { pullRequestError: github.pullRequestError } : {}),
        ...(blockedReason ? { blockedReason } : {})
    }

    return { repository }
}

type ScopeStatsInput = {
    repoRoot: string
    timeoutMs: number
    scope: GitScope
    status: ParsedStatus
    mergeBase: string | null
    baseRef: string | null
    branchEntries?: StatusEntry[]
    untrackedStats: Map<string, Numstat>
}

type ScopeStats = {
    stats?: Map<string, Numstat>
    branchChanges?: GitChange[]
    error?: string
}

async function loadScopeStats(input: ScopeStatsInput): Promise<ScopeStats> {
    if (input.scope === 'branch') {
        if (!input.baseRef) {
            return { error: 'No base branch selected and no remote default branch was identified' }
        }
        if (!input.mergeBase) {
            return { error: `Cannot compare with base ref '${input.baseRef}': no merge base with HEAD` }
        }
        if (!input.branchEntries) {
            return { error: 'Unable to compare branches' }
        }
        const branchStats = await readBranchStats(input.repoRoot, input.mergeBase, input.timeoutMs)
        const branchStatsMap = branchStats.stats
        if (!branchStatsMap) {
            return { error: branchStats.error ?? 'Unable to compare branches' }
        }
        const branchChanges = input.branchEntries.map((entry) => buildChange(entry, branchStatsMap, {
            staged: false,
            unstaged: false,
            untracked: false
        }))
        return { stats: branchStatsMap, branchChanges }
    }

    if (input.scope === 'staged') {
        const staged = await readNumstat(input.repoRoot, ['diff', '--cached'], input.timeoutMs)
        if (staged.error) return { error: staged.error }
        return { stats: staged.stats }
    }

    if (input.scope === 'unstaged') {
        const unstaged = await readNumstat(input.repoRoot, ['diff'], input.timeoutMs)
        if (unstaged.error) return { error: unstaged.error }
        return { stats: mergeStats(unstaged.stats ?? new Map(), input.untrackedStats) }
    }

    if (input.status.head) {
        const working = await readNumstat(input.repoRoot, ['diff', 'HEAD'], input.timeoutMs)
        if (working.error) return { error: working.error }
        return { stats: mergeStats(working.stats ?? new Map(), input.untrackedStats) }
    }

    const trackedPaths = input.status.entries
        .filter((entry) => entry.x !== '?')
        .map((entry) => entry.path)
    const counts = await mapWithConcurrency(trackedPaths, 8, async (path) => {
        const absolutePath = resolve(input.repoRoot, path)
        try {
            await lstat(absolutePath)
        } catch {
            return [path, { additions: 0, deletions: 0, binary: false } satisfies Numstat] as const
        }
        return [path, await countAgainstEmpty(input.repoRoot, path, input.timeoutMs)] as const
    })
    return { stats: mergeStats(new Map(counts), input.untrackedStats) }
}

type IndexLayerStats = {
    stagedStats: Map<string, Numstat>
    unstagedStats: Map<string, Numstat>
    untrackedStats: Map<string, Numstat>
    error?: string
}

async function loadIndexLayerStats(
    repoRoot: string,
    timeoutMs: number,
    untrackedPaths: string[]
): Promise<IndexLayerStats> {
    const staged = await readNumstat(repoRoot, ['diff', '--cached'], timeoutMs)
    if (staged.error) {
        return { stagedStats: new Map(), unstagedStats: new Map(), untrackedStats: new Map(), error: staged.error }
    }
    const unstaged = await readNumstat(repoRoot, ['diff'], timeoutMs)
    if (unstaged.error) {
        return { stagedStats: new Map(), unstagedStats: new Map(), untrackedStats: new Map(), error: unstaged.error }
    }

    const untrackedStats = await countUntracked(repoRoot, untrackedPaths, timeoutMs)
    return {
        stagedStats: staged.stats ?? new Map(),
        unstagedStats: mergeStats(unstaged.stats ?? new Map(), untrackedStats),
        untrackedStats
    }
}

export async function readActionState(context: RepositoryContext): Promise<{ state?: ActionState; error?: string }> {
    const statusResult = await readStatus(context.repoRoot, READ_TIMEOUT_MS)
    if (!statusResult.status) {
        return { error: statusResult.error ?? 'Unable to read git status' }
    }
    const status = statusResult.status
    const digests = await computeStateDigests(context.repoRoot, status.entries, READ_TIMEOUT_MS)
    if ('error' in digests) return { error: digests.error }

    const remotes = await listRemotes(context.repoRoot)
    const trackingRemote = findRemoteForUpstream(status.upstream, remotes)
    const defaultBranch = await detectDefaultBranch(context.repoRoot, remotes, trackingRemote, READ_TIMEOUT_MS, {
        currentBranch: status.branch,
        upstream: status.upstream
    })
    const staged = status.entries.filter((entry) => entry.x !== '.' && entry.x !== '?')
    const unstaged = status.entries.filter((entry) => entry.y !== '.' && entry.x !== '?')
    const untracked = status.entries.filter((entry) => entry.x === '?')

    return {
        state: {
            repoRoot: context.repoRoot,
            head: status.head,
            branch: status.branch,
            indexDigest: digests.indexDigest,
            worktreeDigest: digests.worktreeDigest,
            entries: status.entries,
            staged,
            unstaged,
            untracked,
            trackedDirty: staged.length > 0 || unstaged.length > 0,
            unmerged: status.entries.some((entry) => entry.kind === 'unmerged'),
            upstream: status.upstream,
            ahead: status.ahead,
            behind: status.behind,
            remote: resolvePreferredRemote(remotes, trackingRemote, defaultBranch),
            remotes,
            defaultBranch
        }
    }
}

function resolveFileWithinBoundary(
    repoRoot: string,
    workingDirectory: string,
    filePath: string
): { repoRelativePath?: string; error?: string } {
    const candidates = isAbsolute(filePath)
        ? [filePath]
        : [resolve(repoRoot, filePath)]

    for (const candidate of candidates) {
        if (!validatePath(candidate, workingDirectory).valid) continue
        const repoRelativePath = relative(repoRoot, candidate)
        if (!repoRelativePath || repoRelativePath.startsWith('..') || isAbsolute(repoRelativePath)) continue
        return { repoRelativePath: repoRelativePath.split(sep).join('/') }
    }
    return { error: `Access denied: Path '${filePath}' is outside the working directory` }
}

async function readMergeBase(
    repoRoot: string,
    baseRef: string,
    timeoutMs: number
): Promise<{ mergeBase?: string; error?: string }> {
    const result = await runGit(['merge-base', baseRef, 'HEAD'], repoRoot, timeoutMs)
    if (!result.success) {
        return { error: sanitizeGitOutput(result.stderr || `Unable to resolve merge base for '${baseRef}'`) }
    }
    const mergeBase = result.stdout.trim()
    if (!mergeBase) return { error: `Unable to resolve merge base for '${baseRef}'` }
    return { mergeBase }
}

async function diffAgainstEmpty(basePath: string, repoRelativePath: string, timeoutMs: number): Promise<{
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    error?: string
}> {
    const absolutePath = resolve(basePath, repoRelativePath)
    const result = await runGit(
        ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', basename(absolutePath)],
        dirname(absolutePath),
        timeoutMs
    )
    if (result.success) {
        return { success: true, stdout: result.stdout, stderr: '', exitCode: 0 }
    }
    if (result.exitCode === 1 && result.stdout.length > 0) {
        return { success: true, stdout: result.stdout, stderr: '', exitCode: 0 }
    }
    return {
        success: false,
        stdout: result.stdout,
        stderr: sanitizeGitOutput(result.stderr || 'Unable to read the file diff'),
        exitCode: result.exitCode,
        error: sanitizeGitOutput(result.stderr || 'Unable to read the file diff')
    }
}

export async function readScopedFileDiff(
    context: RepositoryContext,
    workingDirectory: string,
    options: ScopedDiffOptions
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number; error?: string }> {
    const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
    const scope: GitScope = options.scope ?? (options.baseRef ? 'branch' : 'working')
    const resolved = resolveFileWithinBoundary(
        context.repoRoot,
        workingDirectory,
        options.filePath
    )
    if (!resolved.repoRelativePath) {
        return {
            success: false,
            stdout: '',
            stderr: resolved.error ?? 'Invalid file path',
            exitCode: 1,
            error: resolved.error ?? 'Invalid file path'
        }
    }
    const repoRelativePath = resolved.repoRelativePath

    if (scope === 'branch') {
        const remotes = await listRemotes(context.repoRoot, timeoutMs)
        const baseRef = options.baseRef
            ?? await detectDefaultBranch(context.repoRoot, remotes, null, timeoutMs)
        if (!baseRef) {
            const error = 'No base branch selected and no remote default branch was identified'
            return { success: false, stdout: '', stderr: error, exitCode: 1, error }
        }
        const mergeBaseResult = await readMergeBase(context.repoRoot, baseRef, timeoutMs)
        if (!mergeBaseResult.mergeBase) {
            const error = mergeBaseResult.error ?? `Unable to resolve merge base for '${baseRef}'`
            return { success: false, stdout: '', stderr: error, exitCode: 1, error }
        }
        const result = await runGit(
            ['--literal-pathspecs', 'diff', '--no-ext-diff', mergeBaseResult.mergeBase, 'HEAD', '--', repoRelativePath],
            context.repoRoot,
            timeoutMs
        )
        if (result.success) {
            return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
        }
        return {
            success: false,
            stdout: result.stdout,
            stderr: sanitizeGitOutput(result.stderr || 'Unable to read the branch diff'),
            exitCode: result.exitCode,
            error: sanitizeGitOutput(result.stderr || 'Unable to read the branch diff')
        }
    }

    if (scope === 'staged') {
        const result = await runGit(
            ['--literal-pathspecs', 'diff', '--cached', '--no-ext-diff', '--', repoRelativePath],
            context.repoRoot,
            timeoutMs
        )
        return result.success
            ? { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
            : {
                success: false,
                stdout: result.stdout,
                stderr: sanitizeGitOutput(result.stderr || 'Unable to read the staged diff'),
                exitCode: result.exitCode,
                error: sanitizeGitOutput(result.stderr || 'Unable to read the staged diff')
            }
    }

    if (scope === 'unstaged') {
        const result = await runGit(
            ['--literal-pathspecs', 'diff', '--no-ext-diff', '--', repoRelativePath],
            context.repoRoot,
            timeoutMs
        )
        if (result.success && result.stdout.length > 0) {
            return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
        }
        if (!result.success) {
            return {
                success: false,
                stdout: result.stdout,
                stderr: sanitizeGitOutput(result.stderr || 'Unable to read the unstaged diff'),
                exitCode: result.exitCode,
                error: sanitizeGitOutput(result.stderr || 'Unable to read the unstaged diff')
            }
        }
        const tracked = await runGit(
            ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', repoRelativePath],
            context.repoRoot,
            timeoutMs
        )
        if (!tracked.success) {
            const absolutePath = resolve(context.repoRoot, repoRelativePath)
            try {
                await lstat(absolutePath)
            } catch {
                return { success: true, stdout: '', stderr: '', exitCode: 0 }
            }
            return await diffAgainstEmpty(context.repoRoot, repoRelativePath, timeoutMs)
        }
        return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    }

    const head = await readHead(context.repoRoot, timeoutMs)
    if (!head) {
        const absolutePath = resolve(context.repoRoot, repoRelativePath)
        try {
            await lstat(absolutePath)
        } catch {
            return { success: true, stdout: '', stderr: '', exitCode: 0 }
        }
        return await diffAgainstEmpty(context.repoRoot, repoRelativePath, timeoutMs)
    }

    const result = await runGit(
        ['--literal-pathspecs', 'diff', 'HEAD', '--no-ext-diff', '--', repoRelativePath],
        context.repoRoot,
        timeoutMs
    )
    if (result.success && result.stdout.length > 0) {
        return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    }
    if (!result.success) {
        return {
            success: false,
            stdout: result.stdout,
            stderr: sanitizeGitOutput(result.stderr || 'Unable to read the working diff'),
            exitCode: result.exitCode,
            error: sanitizeGitOutput(result.stderr || 'Unable to read the working diff')
        }
    }

    const tracked = await runGit(
        ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', repoRelativePath],
        context.repoRoot,
        timeoutMs
    )
    if (!tracked.success) {
        const absolutePath = resolve(context.repoRoot, repoRelativePath)
        try {
            await lstat(absolutePath)
        } catch {
            return { success: true, stdout: '', stderr: '', exitCode: 0 }
        }
        return await diffAgainstEmpty(context.repoRoot, repoRelativePath, timeoutMs)
    }
    return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
}
