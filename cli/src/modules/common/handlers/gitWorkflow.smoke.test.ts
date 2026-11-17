import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitActionResponse, GitRepositoryResponse } from '@hapi/protocol/sourceControl'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerGitHandlers } from './git'

const execFileAsync = promisify(execFile)
const roots: string[] = []
let scopeCounter = 0

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

async function cloneFrom(bare: string, parent: string, name: string): Promise<string> {
    const target = join(parent, name)
    await runGit(parent, ['clone', '-q', bare, target])
    await runGit(target, ['config', 'user.name', 'HAPI Smoke'])
    await runGit(target, ['config', 'user.email', 'hapi@example.test'])
    try {
        await runGit(target, ['remote', 'set-head', 'origin', 'main'])
    } catch {
        // Seed clone has no remote branch yet.
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
    await runGit(seed, ['add', '-A'])
    await runGit(seed, ['commit', '-qm', 'seed'])
    await runGit(seed, ['push', '-q', 'origin', 'main'])
    return { bare, parent }
}

function createRpcClient(workingDirectory: string): (method: string, params?: object) => Promise<unknown> {
    const scope = `git-smoke-${scopeCounter}`
    scopeCounter += 1
    const rpc = new RpcHandlerManager({ scopePrefix: scope })
    registerGitHandlers(rpc, workingDirectory)
    return async (method: string, params: object = {}) => {
        const raw = await rpc.handleRequest({
            method: `${scope}:${method}`,
            params: JSON.stringify(params)
        })
        return JSON.parse(raw) as unknown
    }
}

describe('git workflow smoke over RPC', () => {
    it('stages, commits, pushes and pulls through a local bare remote', async () => {
        const { bare, parent } = await createBareWithMain('hapi-git-smoke-')
        const work = await cloneFrom(bare, parent, 'work')
        const behind = await cloneFrom(bare, parent, 'behind')
        const request = createRpcClient(work)

        const legacy = await request('git-status') as { success: boolean; stdout?: string }
        expect(legacy.success).toBe(true)
        expect(legacy.stdout).toContain('# branch.oid')

        const initial = await request('git-status', { details: true }) as GitRepositoryResponse
        expect(initial.success).toBe(true)
        expect(initial.repository?.branch).toBe('main')
        expect(initial.repository?.head).toBe((await runGit(bare, ['rev-parse', 'main'])).trim())
        expect(initial.repository?.defaultBranch).toBe('origin/main')
        expect(initial.repository?.indexDigest).toMatch(/^[0-9a-f]{64}$/)

        await writeFile(join(work, 'smoke.txt'), 'smoke\n')
        const dirty = await request('git-status', { details: true }) as GitRepositoryResponse
        expect(dirty.repository?.files.map((file) => file.path)).toContain('smoke.txt')

        const staged = await request('git-action', {
            action: 'stage',
            expectedHead: dirty.repository?.head,
            expectedBranch: dirty.repository?.branch,
            expectedIndexDigest: dirty.repository?.indexDigest,
            expectedWorktreeDigest: dirty.repository?.worktreeDigest,
            paths: ['smoke.txt']
        }) as GitActionResponse
        expect(staged.success).toBe(true)
        expect(staged.steps.map((step) => step.action)).toEqual(['stage'])

        const stagedStatus = await request('git-status', { details: true }) as GitRepositoryResponse
        expect(stagedStatus.repository?.stagedFiles.map((file) => file.path)).toEqual(['smoke.txt'])

        const scopedDiff = await request('git-diff-file', {
            filePath: 'smoke.txt',
            scope: 'staged'
        }) as { success: boolean; stdout?: string }
        expect(scopedDiff.success).toBe(true)
        expect(scopedDiff.stdout).toContain('+smoke')

        const legacyDiff = await request('git-diff-file', {
            filePath: 'smoke.txt',
            staged: true
        }) as { success: boolean; stdout?: string }
        expect(legacyDiff.success).toBe(true)
        expect(legacyDiff.stdout).toContain('+smoke')

        const committed = await request('git-action', {
            action: 'commit-push',
            expectedHead: stagedStatus.repository?.head,
            expectedBranch: stagedStatus.repository?.branch,
            expectedIndexDigest: stagedStatus.repository?.indexDigest,
            expectedWorktreeDigest: stagedStatus.repository?.worktreeDigest,
            message: 'smoke commit',
            confirmDefaultBranch: true
        }) as GitActionResponse
        expect(committed.success).toBe(true)
        expect(committed.steps.map((step) => step.action)).toEqual(['commit', 'push'])
        expect((await runGit(bare, ['rev-parse', 'main'])).trim()).toBe(committed.head)

        const behindRequest = createRpcClient(behind)
        await runGit(behind, ['fetch', '-q', 'origin'])
        const behindStatus = await behindRequest('git-status', { details: true }) as GitRepositoryResponse
        expect(behindStatus.repository?.behind).toBe(1)

        const pulled = await behindRequest('git-action', {
            action: 'pull',
            expectedHead: behindStatus.repository?.head,
            expectedBranch: behindStatus.repository?.branch,
            expectedIndexDigest: behindStatus.repository?.indexDigest,
            expectedWorktreeDigest: behindStatus.repository?.worktreeDigest
        }) as GitActionResponse
        expect(pulled.success).toBe(true)
        expect(pulled.steps.map((step) => step.action)).toEqual(['pull'])
        expect((await runGit(behind, ['rev-parse', 'HEAD'])).trim()).toBe(committed.head)
    }, 30_000)
})
