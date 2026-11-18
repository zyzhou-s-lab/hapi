import { access } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
    GitActionKind,
    GitActionRequest,
    GitActionResponse,
    GitActionStep
} from '@hapi/protocol/sourceControl'
import { validatePath } from '../pathSecurity'
import {
    GH_PROBE_TIMEOUT_MS,
    GH_TIMEOUT_MS,
    LOCAL_WRITE_TIMEOUT_MS,
    NETWORK_TIMEOUT_MS,
    READ_TIMEOUT_MS,
    runCommand,
    runGit,
    sanitizeGitOutput,
    truncateOutput
} from './gitExec'
import {
    findRemoteForUpstream,
    isWithinWorkingDirectory,
    localBranchName,
    parseGitHubPullRequest,
    readActionState,
    resolveRemoteGitHubSlug,
    resolveRepositoryContext,
    type ActionState,
    type RepositoryContext
} from './gitRepository'

export type GitActionExecutorOptions = {
    cwd?: string
    workingDirectory: string
    ghCommand?: string
}

type StepAction = 'stage' | 'commit' | 'push' | 'pull' | 'pr' | 'checkout' | 'create-branch'

type ActionRun = {
    context: RepositoryContext
    request: GitActionRequest
    workingDirectory: string
    ghCommand: string
    expectedHead: string | null
    expectedBranch: string | null
    expectedIndex: string
    expectedWorktree: string
    state: ActionState
}

type StepOutcome =
    | {
        ok: true
        output: string
        head?: string | null
        branch?: string | null
        indexDigest?: string
        worktreeDigest?: string
        pullRequestUrl?: string
    }
    | { ok: false; error: string }

const repositoryQueues = new Map<string, Promise<void>>()

function withRepositoryLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
    const previous = repositoryQueues.get(repoRoot) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const tail = run.then(() => undefined, () => undefined)
    repositoryQueues.set(repoRoot, tail)
    tail.then(() => {
        if (repositoryQueues.get(repoRoot) === tail) {
            repositoryQueues.delete(repoRoot)
        }
    })
    return run
}

const ACTION_PLANS: Record<GitActionKind, StepAction[]> = {
    stage: ['stage'],
    commit: ['commit'],
    push: ['push'],
    pull: ['pull'],
    pr: ['pr'],
    'push-pr': ['push', 'pr'],
    'commit-push': ['commit', 'push'],
    'commit-push-pr': ['commit', 'push', 'pr'],
    checkout: ['checkout'],
    'create-branch': ['create-branch']
}

function validateExpectedState(state: ActionState, request: GitActionRequest): string | null {
    if (state.head !== request.expectedHead) {
        return `Repository HEAD changed (expected ${request.expectedHead ?? 'no commit'}, found ${state.head ?? 'no commit'}). Refresh and retry.`
    }
    if (state.branch !== request.expectedBranch) {
        return `Repository branch changed (expected ${request.expectedBranch ?? 'detached HEAD'}, found ${state.branch ?? 'detached HEAD'}). Refresh and retry.`
    }
    if (request.expectedIndexDigest && state.indexDigest !== request.expectedIndexDigest) {
        return 'Staged changes changed since they were read. Refresh and retry.'
    }
    if (request.expectedWorktreeDigest && state.worktreeDigest !== request.expectedWorktreeDigest) {
        return 'Working tree changed since it was read. Refresh and retry.'
    }
    return null
}

async function findGitLock(repoRoot: string): Promise<string | null> {
    for (const name of ['index.lock', 'HEAD.lock']) {
        const result = await runGit(['rev-parse', '--git-path', name], repoRoot, READ_TIMEOUT_MS)
        if (!result.success) continue
        const reported = result.stdout.trim()
        if (!reported) continue
        const lockPath = isAbsolute(reported) ? reported : resolve(repoRoot, reported)
        try {
            await access(lockPath)
            return name
        } catch {
            // Lock file absent.
        }
    }
    return null
}

async function refreshState(run: ActionRun): Promise<{ state?: ActionState; error?: string }> {
    const result = await readActionState(run.context)
    if (!result.state) {
        return { error: result.error ?? 'Unable to re-read repository state' }
    }
    const state = result.state
    if (state.branch !== run.expectedBranch) {
        return { error: 'Repository branch changed during the Git operation. Refresh and retry.' }
    }
    if (state.head !== run.expectedHead) {
        return { error: 'Repository HEAD changed during the Git operation. Refresh and retry.' }
    }
    if (state.indexDigest !== run.expectedIndex) {
        return { error: 'Staged changes changed during the Git operation. Refresh and retry.' }
    }
    if (state.worktreeDigest !== run.expectedWorktree) {
        return { error: 'Working tree changed during the Git operation. Refresh and retry.' }
    }
    run.state = state
    return { state }
}

function resolveSelectedPaths(
    repoRoot: string,
    workingDirectory: string,
    paths: string[]
): { pathspecs?: string[]; error?: string } {
    const pathspecs = new Set<string>()
    for (const requested of paths) {
        const candidates = isAbsolute(requested)
            ? [requested]
            : [resolve(repoRoot, requested)]
        let accepted: string | null = null
        for (const candidate of candidates) {
            if (!validatePath(candidate, workingDirectory).valid) continue
            const repoRelative = relative(repoRoot, candidate)
            if (!repoRelative || repoRelative.startsWith('..') || isAbsolute(repoRelative)) continue
            accepted = repoRelative.split(sep).join('/')
            break
        }
        if (!accepted) {
            return { error: `Access denied: Path '${requested}' is outside the working directory` }
        }
        pathspecs.add(accepted)
    }
    return { pathspecs: [...pathspecs] }
}

function outsideStagedPaths(state: ActionState, workingDirectory: string): string[] {
    const outside = new Set<string>()
    for (const entry of state.staged) {
        if (!isWithinWorkingDirectory(state.repoRoot, entry.path, workingDirectory)) {
            outside.add(entry.path)
        }
        if (entry.oldPath && !isWithinWorkingDirectory(state.repoRoot, entry.oldPath, workingDirectory)) {
            outside.add(entry.oldPath)
        }
    }
    return [...outside]
}

function selectRemote(state: ActionState, requested: string | undefined): { remote?: string; error?: string } {
    if (state.remotes.length === 0) {
        return { error: 'No git remote is configured for this repository.' }
    }
    const remote = requested ?? state.remote ?? (state.remotes.length === 1 ? state.remotes[0] : undefined)
    if (!remote) {
        return { error: 'Select a remote first; this repository has more than one remote.' }
    }
    if (!state.remotes.includes(remote)) {
        return { error: `Remote '${remote}' is not configured for this repository.` }
    }
    return { remote }
}

function commandOutput(result: { stdout: string; stderr: string }): string {
    return [result.stdout, result.stderr]
        .filter((part) => part.trim().length > 0)
        .join('\n')
        .trim()
}

async function stageStep(run: ActionRun): Promise<StepOutcome> {
    const paths = run.request.paths ?? []
    if (paths.length === 0) {
        return { ok: false, error: 'Select at least one file to stage.' }
    }
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const before = verified.state

    const selected = resolveSelectedPaths(
        run.context.repoRoot,
        run.workingDirectory,
        paths
    )
    if (!selected.pathspecs || selected.pathspecs.length === 0) {
        return { ok: false, error: selected.error ?? 'Select at least one file to stage.' }
    }

    if (run.request.action !== 'stage') {
        const selectedSet = new Set(selected.pathspecs)
        const toUnstage = new Set<string>()
        for (const entry of before.staged) {
            if (!isWithinWorkingDirectory(run.context.repoRoot, entry.path, run.workingDirectory)) continue
            const isSelected = selectedSet.has(entry.path)
                || (entry.oldPath !== undefined && selectedSet.has(entry.oldPath))
            if (!isSelected) {
                toUnstage.add(entry.path)
                if (entry.oldPath && isWithinWorkingDirectory(run.context.repoRoot, entry.oldPath, run.workingDirectory)) {
                    toUnstage.add(entry.oldPath)
                }
            }
        }
        if (toUnstage.size > 0) {
            const unstageArgs = before.head
                ? ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...toUnstage]
                : ['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...toUnstage]
            const unstageResult = await runGit(unstageArgs, run.context.repoRoot, LOCAL_WRITE_TIMEOUT_MS)
            if (!unstageResult.success) {
                return { ok: false, error: sanitizeGitOutput(commandOutput(unstageResult) || 'Unable to unstage deselected files') }
            }
        }
    }

    const result = await runGit(
        ['--literal-pathspecs', 'add', '--', ...selected.pathspecs],
        run.context.repoRoot,
        LOCAL_WRITE_TIMEOUT_MS
    )
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git add failed') }
    }

    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after staging' }
    }
    const stagedPaths = new Set<string>()
    for (const entry of after.state.staged) {
        stagedPaths.add(entry.path)
        if (entry.oldPath) stagedPaths.add(entry.oldPath)
    }
    const expectedDirty = new Set(before.entries.map((entry) => entry.path))
    const missing = selected.pathspecs.filter((path) => expectedDirty.has(path) && !stagedPaths.has(path))
    if (missing.length > 0) {
        return { ok: false, error: `Git did not stage: ${missing.join(', ')}` }
    }

    run.state = after.state
    return {
        ok: true,
        output: `Staged ${selected.pathspecs.length} path(s).`,
        indexDigest: after.state.indexDigest,
        worktreeDigest: after.state.worktreeDigest
    }
}

async function readCurrentHead(context: RepositoryContext): Promise<string | null> {
    const result = await runGit(['rev-parse', '--verify', 'HEAD'], context.repoRoot, READ_TIMEOUT_MS)
    if (!result.success) return null
    return result.stdout.trim() || null
}

async function commitStep(run: ActionRun): Promise<StepOutcome> {
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state

    if (!state.branch) {
        return { ok: false, error: 'Detached HEAD: checkout a branch before committing.' }
    }
    if (state.unmerged) {
        return { ok: false, error: 'Unresolved merge conflicts block the commit.' }
    }
    const message = run.request.message?.trim()
    if (!message) {
        return { ok: false, error: 'Enter a commit message.' }
    }
    if (state.staged.length === 0) {
        return { ok: false, error: 'No staged changes to commit. Stage the files you want to include.' }
    }
    const outside = outsideStagedPaths(state, run.workingDirectory)
    if (outside.length > 0) {
        const listed = outside.slice(0, 5).join(', ')
        const suffix = outside.length > 5 ? ', …' : ''
        return { ok: false, error: `Refusing to commit staged files outside the session directory: ${listed}${suffix}` }
    }

    const result = await runGit(
        ['commit', '-m', message],
        run.context.repoRoot,
        LOCAL_WRITE_TIMEOUT_MS
    )
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git commit failed') }
    }

    const head = await readCurrentHead(run.context)
    if (!head || head === state.head) {
        return { ok: false, error: 'git commit completed without creating a new commit.' }
    }
    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after committing' }
    }
    if (after.state.branch !== run.expectedBranch) {
        return { ok: false, error: 'Repository branch changed during the commit. Refresh and retry.' }
    }

    run.state = after.state
    return {
        ok: true,
        output: sanitizeGitOutput(commandOutput(result) || 'Committed staged changes.'),
        head,
        indexDigest: after.state.indexDigest,
        worktreeDigest: after.state.worktreeDigest
    }
}

async function pushStep(run: ActionRun): Promise<StepOutcome> {
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state

    if (!state.branch) {
        return { ok: false, error: 'Detached HEAD: checkout a branch before pushing.' }
    }
    const remoteResult = selectRemote(state, run.request.remote)
    if (!remoteResult.remote) {
        return { ok: false, error: remoteResult.error ?? 'No git remote is configured.' }
    }
    if (state.behind > 0) {
        return {
            ok: false,
            error: `Branch is behind ${state.upstream ?? 'its upstream'} by ${state.behind} commit(s). Pull before publishing.`
        }
    }
    const defaultLocal = localBranchName(state.defaultBranch, state.remotes)
    if (defaultLocal && state.branch === defaultLocal && run.request.confirmDefaultBranch !== true) {
        return {
            ok: false,
            error: `Pushing to the default branch '${state.branch}' requires explicit confirmation.`
        }
    }

    const remote = remoteResult.remote
    const refspec = `HEAD:refs/heads/${state.branch}`
    const args = state.upstream
        ? ['push', remote, refspec]
        : ['push', '--set-upstream', remote, refspec]
    const result = await runGit(args, run.context.repoRoot, NETWORK_TIMEOUT_MS)
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git push failed') }
    }

    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after pushing' }
    }
    if (after.state.branch !== run.expectedBranch) {
        return { ok: false, error: 'Repository branch changed during the push. Refresh and retry.' }
    }
    if (after.state.upstream && after.state.behind > 0) {
        return { ok: false, error: 'Push completed but the branch is still behind its upstream. Refresh and retry.' }
    }

    let output = sanitizeGitOutput(commandOutput(result) || 'Push completed.')
    const headChanged = after.state.head !== run.expectedHead
    if (headChanged) {
        output += '\nRepository HEAD changed during the push; refresh before continuing.'
    }
    run.state = after.state
    return {
        ok: true,
        output,
        ...(headChanged
            ? {}
            : {
                head: after.state.head,
                indexDigest: after.state.indexDigest,
                worktreeDigest: after.state.worktreeDigest
            })
    }
}

async function pullStep(run: ActionRun): Promise<StepOutcome> {
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state

    if (!state.branch) {
        return { ok: false, error: 'Detached HEAD: checkout a branch before pulling.' }
    }
    if (state.trackedDirty) {
        return { ok: false, error: 'Refusing to pull: the working tree has local changes.' }
    }
    if (state.ahead > 0 && state.behind > 0) {
        return { ok: false, error: 'Branch has diverged from its upstream; fast-forward pull is not possible.' }
    }

    const remoteResult = selectRemote(state, run.request.remote)
    if (!remoteResult.remote && !state.upstream) {
        return { ok: false, error: 'No upstream branch is configured for a fast-forward pull.' }
    }
    if (state.upstream && state.behind === 0) {
        return { ok: true, output: 'Already up to date.' }
    }

    const remote = remoteResult.remote
    const args = remote
        ? ['pull', '--ff-only', remote, run.request.baseRef ?? state.branch]
        : ['pull', '--ff-only']
    const result = await runGit(args, run.context.repoRoot, NETWORK_TIMEOUT_MS)
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git pull failed') }
    }

    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after pulling' }
    }
    if (after.state.branch !== run.expectedBranch) {
        return { ok: false, error: 'Repository branch changed during the pull. Refresh and retry.' }
    }
    if (after.state.behind > 0) {
        return { ok: false, error: 'Pull completed but the branch is still behind its upstream. Refresh and retry.' }
    }

    run.state = after.state
    return {
        ok: true,
        output: sanitizeGitOutput(commandOutput(result) || 'Fast-forward pull completed.'),
        head: after.state.head,
        indexDigest: after.state.indexDigest,
        worktreeDigest: after.state.worktreeDigest
    }
}

function pullRequestBase(baseRef: string, remotes: string[]): string {
    const ordered = [...remotes].sort((a, b) => b.length - a.length)
    for (const remote of ordered) {
        if (baseRef.startsWith(`${remote}/`)) return baseRef.slice(remote.length + 1)
    }
    return baseRef
}

async function pullRequestStep(run: ActionRun): Promise<StepOutcome> {
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state

    if (!state.branch) {
        return { ok: false, error: 'Detached HEAD: checkout a branch before creating a pull request.' }
    }

    const version = await runCommand(run.ghCommand, ['--version'], {
        cwd: run.context.repoRoot,
        timeoutMs: GH_PROBE_TIMEOUT_MS
    })
    if (!version.success) {
        return {
            ok: false,
            error: 'GitHub CLI (gh) is not installed on the machine running this session. Install gh and authenticate it there.'
        }
    }
    const auth = await runCommand(run.ghCommand, ['auth', 'status'], {
        cwd: run.context.repoRoot,
        timeoutMs: GH_PROBE_TIMEOUT_MS
    })
    if (!auth.success) {
        return {
            ok: false,
            error: 'GitHub CLI is not authenticated on the machine running this session. Run `gh auth login` there.'
        }
    }

    if (state.behind > 0) {
        return {
            ok: false,
            error: `Branch is behind ${state.upstream ?? 'its upstream'} by ${state.behind} commit(s). Pull before publishing.`
        }
    }
    const defaultLocal = localBranchName(state.defaultBranch, state.remotes)
    if (defaultLocal && state.branch === defaultLocal) {
        return {
            ok: false,
            error: `Cannot create a pull request from the default branch '${state.branch}'.`
        }
    }

    const remoteResult = selectRemote(state, run.request.remote)
    const pushSlug = remoteResult.remote
        ? await resolveRemoteGitHubSlug(run.context.repoRoot, remoteResult.remote, READ_TIMEOUT_MS)
        : null
    const baseRef = run.request.baseRef ?? state.defaultBranch
    const baseRemote = baseRef ? findRemoteForUpstream(baseRef, state.remotes) : null
    const baseSlug = baseRemote && baseRemote !== remoteResult.remote
        ? await resolveRemoteGitHubSlug(run.context.repoRoot, baseRemote, READ_TIMEOUT_MS)
        : null
    const targetSlug = baseSlug ?? pushSlug
    const pushOwner = pushSlug?.split('/').slice(-2, -1)[0]
    const headArg = baseSlug && pushSlug && baseSlug !== pushSlug && pushOwner
        ? `${pushOwner}:${state.branch}`
        : state.branch
    const viewArgs = targetSlug
        ? ['pr', 'view', headArg, '-R', targetSlug, '--json', 'url,number,title']
        : ['pr', 'view', '--json', 'url,number,title']

    const view = await runCommand(run.ghCommand, viewArgs, {
        cwd: run.context.repoRoot,
        timeoutMs: GH_TIMEOUT_MS
    })
    if (view.success) {
        const pullRequest = parseGitHubPullRequest(view.stdout)
        if (pullRequest) {
            return { ok: true, output: `Pull request already exists: ${pullRequest.url}`, pullRequestUrl: pullRequest.url }
        }
    } else if (!/no pull requests? found|could not find a pull request|no open pull requests/i.test(view.stderr)) {
        return {
            ok: false,
            error: sanitizeGitOutput(view.stderr || 'Unable to read the pull request')
        }
    }

    if (!baseRef) {
        return {
            ok: false,
            error: 'Select a base branch: no remote default branch was identified.'
        }
    }
    const base = pullRequestBase(baseRef, state.remotes)
    if (base === state.branch) {
        return {
            ok: false,
            error: `Cannot create a pull request from the base branch '${base}' itself.`
        }
    }
    const title = run.request.title?.trim()
    if (!title) {
        return { ok: false, error: 'Enter a pull request title.' }
    }

    const createArgs = [
        'pr', 'create',
        ...(targetSlug ? ['-R', targetSlug] : []),
        '--base', base,
        '--head', headArg,
        '--title', title,
        '--body', run.request.body ?? ''
    ]
    const create = await runCommand(
        run.ghCommand,
        createArgs,
        { cwd: run.context.repoRoot, timeoutMs: GH_TIMEOUT_MS }
    )
    if (!create.success) {
        return {
            ok: false,
            error: sanitizeGitOutput(commandOutput(create) || 'gh pr create failed')
        }
    }

    const postView = await runCommand(run.ghCommand, viewArgs, {
        cwd: run.context.repoRoot,
        timeoutMs: GH_TIMEOUT_MS
    })
    const createdUrl = postView.success
        ? parseGitHubPullRequest(postView.stdout)?.url
        : undefined
    const createdFromOutput = /(https?:\/\/\S+\/pull\/\d+)/.exec(create.stdout)?.[1]
    const url = createdUrl ?? createdFromOutput
    if (!url) {
        return { ok: true, output: sanitizeGitOutput(commandOutput(create) || 'Pull request created.') }
    }
    return { ok: true, output: `Created pull request: ${url}`, pullRequestUrl: url }
}

async function hasLocalBranch(repoRoot: string, name: string): Promise<boolean> {
    const check = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoRoot, READ_TIMEOUT_MS)
    return check.success
}

async function checkoutStep(run: ActionRun): Promise<StepOutcome> {
    const targetRef = run.request.targetRef?.trim()
    if (!targetRef || targetRef.startsWith('-')) {
        return { ok: false, error: 'Enter a valid branch name.' }
    }
    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state

    if (state.unmerged) {
        return { ok: false, error: 'Unresolved merge conflicts block switching branches.' }
    }
    if (state.trackedDirty) {
        return { ok: false, error: 'Commit or discard local changes before switching branches.' }
    }

    let args: string[]
    if (await hasLocalBranch(run.context.repoRoot, targetRef)) {
        args = ['switch', targetRef]
    } else {
        const matchedRemote = findRemoteForUpstream(targetRef, state.remotes)
        if (matchedRemote) {
            const localName = targetRef.slice(matchedRemote.length + 1)
            if (localName && await hasLocalBranch(run.context.repoRoot, localName)) {
                args = ['switch', localName]
            } else {
                args = ['switch', '--track', targetRef]
            }
        } else {
            args = ['switch', targetRef]
        }
    }

    const result = await runGit(args, run.context.repoRoot, LOCAL_WRITE_TIMEOUT_MS)
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git switch failed') }
    }

    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after switching branches' }
    }
    run.state = after.state
    return {
        ok: true,
        output: sanitizeGitOutput(commandOutput(result) || `Switched to ${after.state.branch ?? targetRef}.`),
        head: after.state.head,
        branch: after.state.branch,
        indexDigest: after.state.indexDigest,
        worktreeDigest: after.state.worktreeDigest
    }
}

async function createBranchStep(run: ActionRun): Promise<StepOutcome> {
    const targetRef = run.request.targetRef?.trim()
    if (!targetRef || targetRef.startsWith('-')) {
        return { ok: false, error: 'Enter a valid branch name.' }
    }
    const checkFormat = await runGit(['check-ref-format', '--branch', targetRef], run.context.repoRoot, READ_TIMEOUT_MS)
    if (!checkFormat.success) {
        return { ok: false, error: `Invalid branch name '${targetRef}'.` }
    }
    const startPoint = run.request.startPoint?.trim()
    if (startPoint && startPoint.startsWith('-')) {
        return { ok: false, error: 'Invalid start point reference.' }
    }

    const verified = await refreshState(run)
    if (!verified.state) return { ok: false, error: verified.error ?? 'Unable to verify repository state' }
    const state = verified.state
    if (state.unmerged) {
        return { ok: false, error: 'Unresolved merge conflicts block creating a branch.' }
    }

    const args = startPoint ? ['switch', '-c', targetRef, startPoint] : ['switch', '-c', targetRef]
    const result = await runGit(args, run.context.repoRoot, LOCAL_WRITE_TIMEOUT_MS)
    if (!result.success) {
        return { ok: false, error: sanitizeGitOutput(commandOutput(result) || 'git switch -c failed') }
    }

    const after = await readActionState(run.context)
    if (!after.state) {
        return { ok: false, error: after.error ?? 'Unable to read repository state after creating branch' }
    }
    run.state = after.state
    return {
        ok: true,
        output: sanitizeGitOutput(commandOutput(result) || `Created and switched to ${after.state.branch ?? targetRef}.`),
        head: after.state.head,
        branch: after.state.branch,
        indexDigest: after.state.indexDigest,
        worktreeDigest: after.state.worktreeDigest
    }
}

async function executeStep(action: StepAction, run: ActionRun): Promise<StepOutcome> {
    switch (action) {
        case 'stage':
            return await stageStep(run)
        case 'commit':
            return await commitStep(run)
        case 'push':
            return await pushStep(run)
        case 'pull':
            return await pullStep(run)
        case 'pr':
            return await pullRequestStep(run)
        case 'checkout':
            return await checkoutStep(run)
        case 'create-branch':
            return await createBranchStep(run)
    }
}

export async function runGitAction(
    request: GitActionRequest,
    options: GitActionExecutorOptions
): Promise<GitActionResponse> {
    const resolved = await resolveRepositoryContext(options.cwd, options.workingDirectory)
    if (!resolved.context) {
        return { success: false, steps: [], error: resolved.error ?? 'Unable to resolve repository' }
    }
    const context = resolved.context

    return await withRepositoryLock(context.repoRoot, async () => {
        const stateResult = await readActionState(context)
        if (!stateResult.state) {
            return {
                success: false,
                steps: [],
                error: stateResult.error ?? 'Unable to read repository state'
            }
        }
        const initialState = stateResult.state
        const expectedError = validateExpectedState(initialState, request)
        if (expectedError) {
            return { success: false, steps: [], error: expectedError, head: initialState.head }
        }

        const lockName = await findGitLock(context.repoRoot)
        if (lockName) {
            return {
                success: false,
                steps: [],
                error: `Git is busy: ${lockName} exists. Wait for the running Git operation, then refresh.`,
                head: initialState.head
            }
        }

        const run: ActionRun = {
            context,
            request,
            workingDirectory: options.workingDirectory,
            ghCommand: options.ghCommand ?? 'gh',
            expectedHead: initialState.head,
            expectedBranch: initialState.branch,
            expectedIndex: initialState.indexDigest,
            expectedWorktree: initialState.worktreeDigest,
            state: initialState
        }

        const steps: GitActionStep[] = []
        let pullRequestUrl: string | undefined
        let branch: string | null | undefined

        const basePlan = ACTION_PLANS[request.action]
        const stepsPlan: StepAction[] = (
            (request.action === 'commit' || request.action === 'commit-push' || request.action === 'commit-push-pr')
            && request.paths !== undefined
        )
            ? ['stage', ...basePlan]
            : basePlan

        for (const action of stepsPlan) {
            const outcome = await executeStep(action, run)
            if (!outcome.ok) {
                const head = await readCurrentHead(context)
                return { success: false, steps, error: outcome.error, head }
            }
            steps.push({
                action,
                success: true,
                output: truncateOutput(outcome.output)
            })
            if (outcome.head !== undefined) {
                run.expectedHead = outcome.head
            }
            if (outcome.branch !== undefined) {
                run.expectedBranch = outcome.branch
                branch = outcome.branch
            }
            if (outcome.indexDigest) {
                run.expectedIndex = outcome.indexDigest
            }
            if (outcome.worktreeDigest) {
                run.expectedWorktree = outcome.worktreeDigest
            }
            if (outcome.pullRequestUrl) {
                pullRequestUrl = outcome.pullRequestUrl
            }
        }

        const head = await readCurrentHead(context)
        return {
            success: true,
            steps,
            head,
            ...(branch !== undefined ? { branch } : {}),
            ...(pullRequestUrl ? { pullRequestUrl } : {})
        }
    })
}
