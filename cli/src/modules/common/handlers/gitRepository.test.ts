import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
    readRepositoryStatus,
    readScopedFileDiff,
    resolveRepositoryContext,
    type RepositoryContext
} from './gitRepository'

const execFileAsync = promisify(execFile)

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0'
        }
    })
    return stdout.toString()
}

async function createRepo(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    roots.push(root)
    await runGit(root, ['init', '-q', '-b', 'main'])
    await runGit(root, ['config', 'user.name', 'HAPI Test'])
    await runGit(root, ['config', 'user.email', 'hapi@example.test'])
    return root
}

async function commitAll(root: string, message: string): Promise<string> {
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', message])
    return (await runGit(root, ['rev-parse', 'HEAD'])).trim()
}

async function contextFor(cwd: string, workingDirectory = cwd): Promise<RepositoryContext> {
    const result = await resolveRepositoryContext(cwd, workingDirectory)
    expect(result.error).toBeUndefined()
    expect(result.context).toBeDefined()
    return result.context as RepositoryContext
}

async function readStatus(
    root: string,
    options: { scope?: 'working' | 'staged' | 'unstaged' | 'branch'; baseRef?: string; workingDirectory?: string } = {}
) {
    const workingDirectory = options.workingDirectory ?? root
    const context = await contextFor(root, workingDirectory)
    const result = await readRepositoryStatus(context, workingDirectory, {
        scope: options.scope,
        baseRef: options.baseRef,
        includeGitHub: false
    })
    expect(result.error).toBeUndefined()
    expect(result.repository).toBeDefined()
    return { repository: result.repository!, context }
}

describe('git repository status and scoped diffs', () => {
    it('deduplicates a staged and unstaged path and keeps a zero-net dirty file', async () => {
        const root = await createRepo('hapi-git-zero-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await commitAll(root, 'init')

        await writeFile(join(root, 'a.txt'), 'two\n')
        await runGit(root, ['add', 'a.txt'])
        await writeFile(join(root, 'a.txt'), 'one\n')

        const { repository } = await readStatus(root)
        const entries = repository.files.filter((file) => file.path === 'a.txt')
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            staged: true,
            unstaged: true,
            untracked: false,
            additions: 0,
            deletions: 0
        })
        expect(repository.dirty).toBe(true)

        const staged = repository.stagedFiles.filter((file) => file.path === 'a.txt')
        expect(staged).toHaveLength(1)
        expect(staged[0]).toMatchObject({ staged: true, additions: 1, deletions: 1 })

        const unstaged = repository.unstagedFiles.filter((file) => file.path === 'a.txt')
        expect(unstaged).toHaveLength(1)
        expect(unstaged[0]).toMatchObject({ staged: false, additions: 1, deletions: 1 })
    })

    it('reports untracked text and binary content without fake line counts', async () => {
        const root = await createRepo('hapi-git-untracked-')
        await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\n')
        await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))

        const { repository, context } = await readStatus(root)
        const notes = repository.files.find((file) => file.path === 'notes.txt')
        const blob = repository.files.find((file) => file.path === 'blob.bin')

        expect(notes).toMatchObject({
            untracked: true,
            staged: false,
            unstaged: true,
            binary: false,
            additions: 2,
            deletions: 0
        })
        expect(blob).toMatchObject({
            untracked: true,
            binary: true,
            additions: null,
            deletions: null
        })
        expect(repository.unstagedFiles.map((file) => file.path).sort()).toEqual(['blob.bin', 'notes.txt'])

        const diff = await readScopedFileDiff(context, root, {
            filePath: 'blob.bin',
            scope: 'working'
        })
        expect(diff.success).toBe(true)
        expect(diff.stdout).toContain('Binary files')
    })

    it('preserves rename identity and counts a rename once', async () => {
        const root = await createRepo('hapi-git-rename-')
        await writeFile(join(root, 'old.txt'), 'keep\n')
        await commitAll(root, 'init')

        await runGit(root, ['mv', 'old.txt', 'new.txt'])

        const { repository } = await readStatus(root)
        const renamed = repository.files.filter((file) => file.path === 'new.txt')
        expect(renamed).toHaveLength(1)
        expect(renamed[0]).toMatchObject({
            oldPath: 'old.txt',
            status: 'renamed',
            staged: true,
            unstaged: false,
            additions: 0,
            deletions: 0
        })
        expect(repository.stagedFiles).toHaveLength(1)
        expect(repository.stagedFiles[0]).toMatchObject({ path: 'new.txt', oldPath: 'old.txt' })
        expect(repository.files).toHaveLength(1)
    })

    it('uses the selected merge base for branch scope and excludes uncommitted work', async () => {
        const root = await createRepo('hapi-git-branch-')
        await writeFile(join(root, 'base.txt'), 'base\n')
        const baseHead = await commitAll(root, 'base')

        await runGit(root, ['checkout', '-q', '-b', 'feature'])
        await writeFile(join(root, 'feature.txt'), 'feature\n')
        await commitAll(root, 'feature')

        await runGit(root, ['checkout', '-q', 'main'])
        await writeFile(join(root, 'main.txt'), 'main\n')
        await commitAll(root, 'main')
        await runGit(root, ['checkout', '-q', 'feature'])

        await writeFile(join(root, 'feature.txt'), 'feature\nuncommitted\n')
        await writeFile(join(root, 'untracked.txt'), 'u\n')

        const { repository, context } = await readStatus(root, { scope: 'branch', baseRef: 'main' })
        expect(repository.mergeBase).toBe(baseHead)
        expect(repository.branchChangedFiles).toBe(1)
        expect(repository.files.map((file) => file.path)).toEqual(['feature.txt'])
        expect(repository.files[0]).toMatchObject({
            staged: false,
            unstaged: false,
            untracked: false,
            additions: 1,
            deletions: 0
        })

        const working = await readStatus(root, { scope: 'working', baseRef: 'main' })
        expect(working.repository.branchChangedFiles).toBe(1)
        expect(working.repository.files.map((file) => file.path).sort()).toEqual(['feature.txt', 'untracked.txt'])

        const staged = await readStatus(root, { scope: 'staged', baseRef: 'main' })
        expect(staged.repository.branchChangedFiles).toBe(1)
        expect(staged.repository.files).toEqual([])

        const diff = await readScopedFileDiff(context, root, {
            filePath: 'feature.txt',
            scope: 'branch',
            baseRef: 'main'
        })
        expect(diff.success).toBe(true)
        expect(diff.stdout).toContain('+feature')
        expect(diff.stdout).not.toContain('uncommitted')
    })

    it('keeps scoped files and diffs inside a nested session directory', async () => {
        const root = await createRepo('hapi-git-boundary-')
        await mkdir(join(root, 'sub'))
        await writeFile(join(root, 'outside.txt'), 'outside\n')
        await writeFile(join(root, 'sub', 'inside.txt'), 'inside\n')
        await commitAll(root, 'init')

        await writeFile(join(root, 'outside.txt'), 'outside changed\n')
        await writeFile(join(root, 'sub', 'inside.txt'), 'inside changed\n')

        const workingDirectory = join(root, 'sub')
        const { repository, context } = await readStatus(workingDirectory, { workingDirectory })
        expect(repository.repoRoot).toBe(await runGit(root, ['rev-parse', '--show-toplevel']).then((value) => value.trim()))
        expect(repository.files.map((file) => file.path)).toEqual(['sub/inside.txt'])
        expect(repository.stagedFiles).toEqual([])
        expect(repository.unstagedFiles.map((file) => file.path)).toEqual(['sub/inside.txt'])

        const outsideDiff = await readScopedFileDiff(context, workingDirectory, {
            filePath: 'outside.txt',
            scope: 'working'
        })
        expect(outsideDiff.success).toBe(false)
        expect(outsideDiff.error).toContain('outside the working directory')

        const insideDiff = await readScopedFileDiff(context, workingDirectory, {
            filePath: 'sub/inside.txt',
            scope: 'working'
        })
        expect(insideDiff.success).toBe(true)
        expect(insideDiff.stdout).toContain('+inside changed')
    })

    it('reads per-file diffs with literal pathspecs', async () => {
        const root = await createRepo('hapi-git-diff-literal-')
        await writeFile(join(root, 'a[1].txt'), 'one\n')
        await writeFile(join(root, 'a1.txt'), 'one\n')
        await commitAll(root, 'init')
        await writeFile(join(root, 'a[1].txt'), 'two\n')
        await writeFile(join(root, 'a1.txt'), 'two\n')

        const { context } = await readStatus(root)
        const working = await readScopedFileDiff(context, root, {
            filePath: 'a[1].txt',
            scope: 'working'
        })
        expect(working.success).toBe(true)
        expect(working.stdout).toContain('a/a[1].txt')
        expect(working.stdout).not.toContain('a/a1.txt')

        await runGit(root, ['add', 'a[1].txt'])
        const staged = await readScopedFileDiff(context, root, {
            filePath: 'a[1].txt',
            scope: 'staged'
        })
        expect(staged.success).toBe(true)
        expect(staged.stdout).toContain('a/a[1].txt')
        expect(staged.stdout).not.toContain('a/a1.txt')
    })

    it('keeps working, staged and unstaged layer diffs distinct', async () => {
        const root = await createRepo('hapi-git-diff-')
        await writeFile(join(root, 'a.txt'), 'line1\nline2\n')
        await commitAll(root, 'init')

        await writeFile(join(root, 'a.txt'), 'line1\nchange\n')
        await runGit(root, ['add', 'a.txt'])
        await writeFile(join(root, 'a.txt'), 'line1\nchange\nmore\n')

        const { context } = await readStatus(root)
        const staged = await readScopedFileDiff(context, root, { filePath: 'a.txt', scope: 'staged' })
        expect(staged.stdout).toContain('-line2')
        expect(staged.stdout).toContain('+change')
        expect(staged.stdout).not.toContain('+more')

        const unstaged = await readScopedFileDiff(context, root, { filePath: 'a.txt', scope: 'unstaged' })
        expect(unstaged.stdout).toContain('+more')
        expect(unstaged.stdout).not.toContain('+change')

        const working = await readScopedFileDiff(context, root, { filePath: 'a.txt', scope: 'working' })
        expect(working.stdout).toContain('-line2')
        expect(working.stdout).toContain('+change')
        expect(working.stdout).toContain('+more')
    })

    it('reports unborn and detached HEAD states explicitly', async () => {
        const unborn = await createRepo('hapi-git-unborn-')
        await writeFile(join(unborn, 'first.txt'), 'first\n')
        await runGit(unborn, ['add', 'first.txt'])
        const unbornStatus = await readStatus(unborn)
        expect(unbornStatus.repository.head).toBeNull()
        expect(unbornStatus.repository.branch).toBe('main')
        expect(unbornStatus.repository.files.map((file) => file.path)).toEqual(['first.txt'])
        expect(unbornStatus.repository.files[0]).toMatchObject({ staged: true, additions: 1, deletions: 0 })
        expect(unbornStatus.repository.blockedReason).toBeUndefined()

        const detached = await createRepo('hapi-git-detached-')
        await writeFile(join(detached, 'a.txt'), 'a\n')
        await commitAll(detached, 'init')
        await runGit(detached, ['checkout', '-q', '--detach'])
        const detachedStatus = await readStatus(detached)
        expect(detachedStatus.repository.branch).toBeNull()
        expect(detachedStatus.repository.head).not.toBeNull()
        expect(detachedStatus.repository.blockedReason).toContain('Detached HEAD')
    })

    it('never guesses a default branch and reports a missing base explicitly', async () => {
        const root = await createRepo('hapi-git-nobase-')
        await writeFile(join(root, 'a.txt'), 'a\n')
        await commitAll(root, 'init')

        const { repository, context } = await readStatus(root)
        expect(repository.defaultBranch).toBeNull()
        expect(repository.baseRef).toBeNull()
        expect(repository.mergeBase).toBeNull()
        expect(repository.branchChangedFiles).toBeNull()

        const branchResult = await readRepositoryStatus(context, root, {
            scope: 'branch',
            includeGitHub: false
        })
        expect(branchResult.repository).toBeUndefined()
        expect(branchResult.error).toContain('No base branch selected')
    })

    it('changes index and worktree digests only when the corresponding state changes', async () => {
        const root = await createRepo('hapi-git-digest-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await commitAll(root, 'init')

        const first = await readStatus(root)
        const second = await readStatus(root)
        expect(first.repository.indexDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(first.repository.worktreeDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(second.repository.indexDigest).toBe(first.repository.indexDigest)
        expect(second.repository.worktreeDigest).toBe(first.repository.worktreeDigest)

        await writeFile(join(root, 'a.txt'), 'two\n')
        const edited = await readStatus(root)
        expect(edited.repository.worktreeDigest).not.toBe(first.repository.worktreeDigest)
        expect(edited.repository.indexDigest).toBe(first.repository.indexDigest)

        await runGit(root, ['add', 'a.txt'])
        const staged = await readStatus(root)
        expect(staged.repository.indexDigest).not.toBe(edited.repository.indexDigest)
        expect(staged.repository.indexDigest).not.toBe(first.repository.indexDigest)
    })
})
