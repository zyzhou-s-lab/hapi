import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type {
    GitActionKind,
    GitActionRequest,
    GitActionResponse,
    GitRepositoryStatus
} from '@hapi/protocol/sourceControl'
import { READ_TIMEOUT_MS, sanitizeGitOutput } from './gitExec'
import { runGitAction } from './gitActions'
import { readGitHubState, readRepositoryStatus, resolveRepositoryContext } from './gitRepository'

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

async function cloneFrom(bare: string, parent: string, name: string): Promise<string> {
    const target = join(parent, name)
    await runGit(parent, ['clone', '-q', bare, target])
    await runGit(target, ['config', 'user.name', 'HAPI Test'])
    await runGit(target, ['config', 'user.email', 'hapi@example.test'])
    try {
        await runGit(target, ['remote', 'set-head', 'origin', 'main'])
    } catch {
        // The seed clone has no remote branch yet; later clones inherit origin/HEAD from the bare HEAD.
    }
    return target
}

async function createBareWithMain(prefix: string): Promise<{ bare: string; parent: string }> {
    const parent = await mkdtemp(join(tmpdir(), prefix))
    roots.push(parent)
    await runGit(parent, ['init', '-q', '--bare', 'origin.git'])
    const bare = join(parent, 'origin.git')
    await runGit(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const seed = await cloneFrom(bare, parent, 'seed')
    await writeFile(join(seed, 'README.md'), 'seed\n')
    await commitAll(seed, 'seed')
    await runGit(seed, ['push', '-q', 'origin', 'main'])
    return { bare, parent }
}

async function readStatus(root: string, workingDirectory = root): Promise<GitRepositoryStatus> {
    const contextResult = await resolveRepositoryContext(root, workingDirectory)
    if (!contextResult.context) throw new Error(contextResult.error)
    const result = await readRepositoryStatus(contextResult.context, workingDirectory, { includeGitHub: false })
    if (!result.repository) throw new Error(result.error ?? 'repository missing')
    return result.repository
}

function requestFor(
    repository: GitRepositoryStatus,
    action: GitActionKind,
    extra: Partial<GitActionRequest> = {}
): GitActionRequest {
    return {
        action,
        expectedHead: repository.head,
        expectedBranch: repository.branch,
        expectedIndexDigest: repository.indexDigest,
        expectedWorktreeDigest: repository.worktreeDigest,
        ...extra
    }
}

async function act(
    root: string,
    request: GitActionRequest,
    options: { workingDirectory?: string; ghCommand?: string } = {}
): Promise<GitActionResponse> {
    return await runGitAction(request, {
        cwd: options.workingDirectory ?? root,
        workingDirectory: options.workingDirectory ?? root,
        ghCommand: options.ghCommand
    })
}

describe('git actions', () => {
    it('treats selected paths literally and does not broaden staging', async () => {
        const root = await createRepo('hapi-git-literal-')
        await writeFile(join(root, 'file[1].txt'), 'one\n')
        await writeFile(join(root, 'file1.txt'), 'one\n')
        await commitAll(root, 'init')
        await writeFile(join(root, 'file[1].txt'), 'two\n')
        await writeFile(join(root, 'file1.txt'), 'two\n')

        const repository = await readStatus(root)
        const result = await act(root, requestFor(repository, 'stage', { paths: ['file[1].txt'] }))
        expect(result.success).toBe(true)
        expect((await runGit(root, ['diff', '--cached', '--name-only'])).trim()).toBe('file[1].txt')

        const magicRoot = await createRepo('hapi-git-magic-')
        await writeFile(join(magicRoot, 'a.txt'), 'one\n')
        await commitAll(magicRoot, 'init')
        await writeFile(join(magicRoot, 'a.txt'), 'two\n')
        const magicRepository = await readStatus(magicRoot)
        const magic = await act(magicRoot, requestFor(magicRepository, 'stage', { paths: ['*'] }))
        expect(magic.success).toBe(false)
        expect((await runGit(magicRoot, ['diff', '--cached', '--name-only'])).trim()).toBe('')
    })

    it('stages only the selected paths', async () => {
        const root = await createRepo('hapi-git-stage-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await writeFile(join(root, 'b.txt'), 'one\n')
        await commitAll(root, 'init')
        await writeFile(join(root, 'a.txt'), 'two\n')
        await writeFile(join(root, 'b.txt'), 'two\n')

        const repository = await readStatus(root)
        const result = await act(root, requestFor(repository, 'stage', { paths: ['a.txt'] }))

        expect(result.success).toBe(true)
        expect(result.steps.map((step) => step.action)).toEqual(['stage'])
        const staged = (await runGit(root, ['diff', '--cached', '--name-only'])).trim()
        expect(staged).toBe('a.txt')
    })

    it('commits staged content only and leaves unstaged files dirty', async () => {
        const root = await createRepo('hapi-git-commit-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await writeFile(join(root, 'b.txt'), 'one\n')
        await commitAll(root, 'init')

        await writeFile(join(root, 'a.txt'), 'two\n')
        await runGit(root, ['add', 'a.txt'])
        await writeFile(join(root, 'b.txt'), 'two\n')

        const repository = await readStatus(root)
        expect(repository.stagedFiles.map((file) => file.path)).toEqual(['a.txt'])
        expect(repository.unstagedFiles.map((file) => file.path)).toEqual(['b.txt'])

        const result = await act(root, requestFor(repository, 'commit', { message: 'staged only' }))
        expect(result.success).toBe(true)
        expect(result.steps.map((step) => step.action)).toEqual(['commit'])
        expect(result.head).not.toBe(repository.head)

        const committed = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD']))
            .split('\n')
            .filter(Boolean)
        expect(committed).toEqual(['a.txt'])

        const after = await readStatus(root)
        expect(after.stagedFiles).toEqual([])
        expect(after.unstagedFiles.map((file) => file.path)).toEqual(['b.txt'])
    })

    it('rejects stale HEAD, index and worktree state', async () => {
        const headRoot = await createRepo('hapi-git-stale-head-')
        await writeFile(join(headRoot, 'a.txt'), 'one\n')
        await commitAll(headRoot, 'init')
        await writeFile(join(headRoot, 'a.txt'), 'two\n')
        const headRepository = await readStatus(headRoot)
        await commitAll(headRoot, 'external')

        const headResult = await act(headRoot, requestFor(headRepository, 'stage', { paths: ['a.txt'] }))
        expect(headResult.success).toBe(false)
        expect(headResult.steps).toEqual([])
        expect(headResult.error).toContain('HEAD changed')

        const worktreeRoot = await createRepo('hapi-git-stale-worktree-')
        await writeFile(join(worktreeRoot, 'a.txt'), 'one\n')
        await commitAll(worktreeRoot, 'init')
        await writeFile(join(worktreeRoot, 'a.txt'), 'two\n')
        const worktreeRepository = await readStatus(worktreeRoot)
        await writeFile(join(worktreeRoot, 'a.txt'), 'three\n')

        const worktreeResult = await act(worktreeRoot, requestFor(worktreeRepository, 'stage', { paths: ['a.txt'] }))
        expect(worktreeResult.success).toBe(false)
        expect(worktreeResult.error).toContain('Working tree changed')

        const indexRoot = await createRepo('hapi-git-stale-index-')
        await writeFile(join(indexRoot, 'a.txt'), 'one\n')
        await commitAll(indexRoot, 'init')
        await writeFile(join(indexRoot, 'a.txt'), 'two\n')
        const indexRepository = await readStatus(indexRoot)
        await runGit(indexRoot, ['add', 'a.txt'])

        const indexResult = await act(indexRoot, requestFor(indexRepository, 'commit', { message: 'stale index' }))
        expect(indexResult.success).toBe(false)
        expect(indexResult.error).toContain('Staged changes changed')
    })

    it('serializes writes per repository and rejects the stale follower', async () => {
        const root = await createRepo('hapi-git-serialize-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await writeFile(join(root, 'b.txt'), 'one\n')
        await commitAll(root, 'init')
        await writeFile(join(root, 'a.txt'), 'two\n')
        await writeFile(join(root, 'b.txt'), 'two\n')

        const repository = await readStatus(root)
        const results = await Promise.all([
            act(root, requestFor(repository, 'stage', { paths: ['a.txt'] })),
            act(root, requestFor(repository, 'stage', { paths: ['b.txt'] }))
        ])

        expect(results.filter((result) => result.success)).toHaveLength(1)
        const rejected = results.find((result) => !result.success)
        expect(rejected?.error).toContain('Staged changes changed')
    })

    it('rejects operations while a Git lock file exists', async () => {
        const root = await createRepo('hapi-git-lock-')
        await writeFile(join(root, 'a.txt'), 'one\n')
        await commitAll(root, 'init')
        await writeFile(join(root, 'a.txt'), 'two\n')
        const repository = await readStatus(root)
        await writeFile(join(root, '.git', 'index.lock'), '')

        const result = await act(root, requestFor(repository, 'stage', { paths: ['a.txt'] }))
        expect(result.success).toBe(false)
        expect(result.error).toContain('Git is busy')
    })

    it('refuses staged files outside a nested session directory', async () => {
        const root = await createRepo('hapi-git-outside-')
        await mkdir(join(root, 'sub'))
        await writeFile(join(root, 'outside.txt'), 'outside\n')
        await writeFile(join(root, 'sub', 'inside.txt'), 'inside\n')
        const initialHead = await commitAll(root, 'init')

        await writeFile(join(root, 'outside.txt'), 'outside changed\n')
        await runGit(root, ['add', 'outside.txt'])

        const workingDirectory = join(root, 'sub')
        const repository = await readStatus(workingDirectory, workingDirectory)
        expect(repository.stagedFiles).toEqual([])

        const commitResult = await act(
            workingDirectory,
            requestFor(repository, 'commit', { message: 'outside' }),
            { workingDirectory }
        )
        expect(commitResult.success).toBe(false)
        expect(commitResult.error).toContain('outside the session directory')
        expect((await runGit(root, ['rev-parse', 'HEAD'])).trim()).toBe(initialHead)

        const stageResult = await act(
            workingDirectory,
            requestFor(repository, 'stage', { paths: ['outside.txt'] }),
            { workingDirectory }
        )
        expect(stageResult.success).toBe(false)
        expect(stageResult.error).toContain('outside the working directory')
    })

    it('commits before a failed push and allows continuing with only the push', async () => {
        const { bare, parent } = await createBareWithMain('hapi-git-pushfail-')
        const work = await cloneFrom(bare, parent, 'work')
        await writeFile(join(work, 'a.txt'), 'change\n')
        const staged = await readStatus(work)
        const stageResult = await act(work, requestFor(staged, 'stage', { paths: ['a.txt'] }))
        expect(stageResult.success).toBe(true)

        const stagedRepository = await readStatus(work)
        await runGit(work, ['remote', 'set-url', 'origin', join(parent, 'missing-origin.git')])
        const failed = await act(
            work,
            requestFor(stagedRepository, 'commit-push', {
                message: 'commit then fail',
                confirmDefaultBranch: true
            })
        )

        expect(failed.success).toBe(false)
        expect(failed.steps.map((step) => step.action)).toEqual(['commit'])
        expect(failed.head).toBe((await runGit(work, ['rev-parse', 'HEAD'])).trim())
        expect(failed.error).toBeTruthy()
        expect((await runGit(work, ['log', '-1', '--format=%s'])).trim()).toBe('commit then fail')
        expect((await readStatus(work)).stagedFiles).toEqual([])

        await runGit(work, ['remote', 'set-url', 'origin', bare])
        const retryRepository = await readStatus(work)
        const pushed = await act(
            work,
            requestFor(retryRepository, 'push', { confirmDefaultBranch: true })
        )
        expect(pushed.success).toBe(true)
        expect(pushed.steps.map((step) => step.action)).toEqual(['push'])
        expect((await runGit(bare, ['rev-parse', 'main'])).trim()).toBe(failed.head)
    })

    it('requires explicit confirmation to push the default branch', async () => {
        const { bare, parent } = await createBareWithMain('hapi-git-default-')
        const work = await cloneFrom(bare, parent, 'work')
        await writeFile(join(work, 'a.txt'), 'change\n')
        await commitAll(work, 'change')
        const repository = await readStatus(work)
        expect(repository.defaultBranch).toBe('origin/main')

        const blocked = await act(work, requestFor(repository, 'push'))
        expect(blocked.success).toBe(false)
        expect(blocked.error).toContain('requires explicit confirmation')

        const confirmed = await act(work, requestFor(repository, 'push', { confirmDefaultBranch: true }))
        expect(confirmed.success).toBe(true)
        expect((await runGit(bare, ['rev-parse', 'main'])).trim()).toBe(repository.head)
    })

    it('fast-forwards only clean branches and blocks behind or diverged publication', async () => {
        const { bare, parent } = await createBareWithMain('hapi-git-pull-')
        const author = await cloneFrom(bare, parent, 'author')
        const behind = await cloneFrom(bare, parent, 'behind')
        const diverged = await cloneFrom(bare, parent, 'diverged')

        await writeFile(join(author, 'remote.txt'), 'remote\n')
        const remoteHead = await commitAll(author, 'remote change')
        await runGit(author, ['push', '-q', 'origin', 'main'])

        await runGit(behind, ['fetch', '-q', 'origin'])
        await runGit(diverged, ['fetch', '-q', 'origin'])
        await writeFile(join(diverged, 'local.txt'), 'local\n')
        await commitAll(diverged, 'local change')

        const behindRepository = await readStatus(behind)
        expect(behindRepository.behind).toBe(1)
        const blockedPush = await act(behind, requestFor(behindRepository, 'push'))
        expect(blockedPush.success).toBe(false)
        expect(blockedPush.error).toContain('behind')

        await writeFile(join(behind, 'README.md'), 'dirty\n')
        const dirtyRepository = await readStatus(behind)
        const dirtyPull = await act(behind, requestFor(dirtyRepository, 'pull'))
        expect(dirtyPull.success).toBe(false)
        expect(dirtyPull.error).toContain('local changes')

        await runGit(behind, ['checkout', '--', 'README.md'])
        const cleanRepository = await readStatus(behind)
        const pulled = await act(behind, requestFor(cleanRepository, 'pull'))
        expect(pulled.success).toBe(true)
        expect(pulled.head).toBe(remoteHead)

        const divergedRepository = await readStatus(diverged)
        expect(divergedRepository.ahead).toBe(1)
        expect(divergedRepository.behind).toBe(1)
        const divergedPull = await act(diverged, requestFor(divergedRepository, 'pull'))
        expect(divergedPull.success).toBe(false)
        expect(divergedPull.error).toContain('diverged')
    })

    it('reports missing gh and creates a pull request through the owning CLI', async () => {
        const { bare, parent } = await createBareWithMain('hapi-git-pr-')
        const work = await cloneFrom(bare, parent, 'work')
        await runGit(work, ['checkout', '-q', '-b', 'feature'])
        await writeFile(join(work, 'feature.txt'), 'feature\n')
        await commitAll(work, 'feature')

        const tools = await mkdtemp(join(tmpdir(), 'hapi-git-gh-'))
        roots.push(tools)
        const marker = join(tools, 'pr-created')
        const log = join(tools, 'gh.log')
        const fakeGh = join(tools, 'gh')
        await writeFile(fakeGh, `#!/bin/sh
marker="${marker}"
log="${log}"
printf '%s\\n' "$*" >> "$log"
if [ "$1" = "--version" ]; then echo "gh version 9.9.9"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$marker" ]; then
    echo '{"url":"https://example.test/pull/7","number":7,"title":"Feature"}'
    exit 0
  fi
  echo "no pull requests found" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  touch "$marker"
  echo "https://example.test/pull/7"
  exit 0
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`)
        await chmod(fakeGh, 0o755)

        const repository = await readStatus(work)
        const missing = await act(
            work,
            requestFor(repository, 'pr', { title: 'Feature' }),
            { ghCommand: join(tools, 'missing-gh') }
        )
        expect(missing.success).toBe(false)
        expect(missing.error).toContain('not installed')

        const contextResult = await resolveRepositoryContext(work, work)
        expect(contextResult.context).toBeDefined()
        const ghBefore = await readGitHubState(contextResult.context!, READ_TIMEOUT_MS, fakeGh)
        expect(ghBefore).toMatchObject({ available: true, authenticated: true, pullRequest: null })

        const created = await act(
            work,
            requestFor(repository, 'pr', { title: 'Feature PR', body: 'Body' }),
            { ghCommand: fakeGh }
        )
        expect(created.success).toBe(true)
        expect(created.steps.map((step) => step.action)).toEqual(['pr'])
        expect(created.pullRequestUrl).toBe('https://example.test/pull/7')
        expect(await readFile(log, 'utf8')).toContain('pr create --base main --head feature')

        const ghAfter = await readGitHubState(contextResult.context!, READ_TIMEOUT_MS, fakeGh)
        expect(ghAfter.pullRequest?.url).toBe('https://example.test/pull/7')
    })

    it('redacts credentials from command diagnostics', () => {
            const sanitized = sanitizeGitOutput("fatal: unable to access 'https://user:pw-fake@example.test/repo' password=plain-secret ghp_0123456789abcdef0123")
            expect(sanitized).not.toContain('pw-fake')
            expect(sanitized).not.toContain('plain-secret')
            expect(sanitized).not.toContain('ghp_0123456789abcdef0123')
            expect(sanitized).toContain('https://***@example.test/repo')
        })
})
