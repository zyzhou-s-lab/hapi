import { execFile, type ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import type { CommandResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    GitActionRequestSchema,
    GitReadOptionsSchema,
    type GitActionRequest,
    type GitActionResponse,
    type GitRepositoryResponse,
    type GitScope
} from '@hapi/protocol/sourceControl'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { rpcError } from '../rpcResponses'
import { runGitAction } from './gitActions'
import { readRepositoryStatus, readScopedFileDiff, resolveRepositoryContext } from './gitRepository'

const execFileAsync = promisify(execFile)

interface GitStatusRequest {
    cwd?: string
    timeout?: number
    details?: boolean
    scope?: GitScope
    baseRef?: string
}

interface GitDiffNumstatRequest {
    cwd?: string
    staged?: boolean
    timeout?: number
}

interface GitDiffFileRequest {
    cwd?: string
    filePath: string
    staged?: boolean
    scope?: GitScope
    baseRef?: string
    timeout?: number
}

type GitActionRpcRequest = GitActionRequest & { cwd?: string }

type GitCommandResponse = CommandResponse

function resolveCwd(requestedCwd: string | undefined, workingDirectory: string): { cwd: string; error?: string } {
    const cwd = requestedCwd ?? workingDirectory
    const validation = validatePath(cwd, workingDirectory)
    if (!validation.valid) {
        return { cwd, error: validation.error ?? 'Invalid working directory' }
    }
    return { cwd }
}

function validateFilePath(filePath: string, workingDirectory: string): string | null {
    const validation = validatePath(filePath, workingDirectory)
    if (!validation.valid) {
        return validation.error ?? 'Invalid file path'
    }
    return null
}

async function runGitCommand(
    args: string[],
    cwd: string,
    timeout?: number
): Promise<GitCommandResponse> {
    try {
        const options: ExecFileOptions = {
            cwd,
            timeout: timeout ?? 10_000
        }
        const { stdout, stderr } = await execFileAsync('git', args, options)
        return {
            success: true,
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : '',
            exitCode: 0
        }
    } catch (error) {
        const execError = error as NodeJS.ErrnoException & {
            stdout?: string
            stderr?: string
            code?: number | string
            killed?: boolean
        }

        if (execError.code === 'ETIMEDOUT' || execError.killed) {
            return rpcError('Command timed out', {
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : '',
                exitCode: typeof execError.code === 'number' ? execError.code : -1
            })
        }

        return rpcError(execError.message || 'Command failed', {
            stdout: execError.stdout ? execError.stdout.toString() : '',
            stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
            exitCode: typeof execError.code === 'number' ? execError.code : 1
        })
    }
}

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusRequest, GitRepositoryResponse>(RPC_METHODS.GitStatus, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        if (!data.details) {
            return await runGitCommand(
                ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
                resolved.cwd,
                data.timeout
            )
        }

        const readOptions = GitReadOptionsSchema.safeParse({
            scope: data.scope,
            baseRef: data.baseRef,
            details: data.details
        })
        if (!readOptions.success) {
            return rpcError('Invalid Git read options')
        }

        const contextResult = await resolveRepositoryContext(resolved.cwd, workingDirectory)
        if (!contextResult.context) {
            return rpcError(contextResult.error ?? 'Unable to resolve git repository')
        }

        const result = await readRepositoryStatus(contextResult.context, workingDirectory, {
            scope: readOptions.data.scope,
            baseRef: readOptions.data.baseRef,
            timeoutMs: data.timeout
        })
        if (!result.repository) {
            return rpcError(result.error ?? 'Unable to read git status')
        }

        return {
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
            repository: result.repository
        }
    })

    rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>(RPC_METHODS.GitDiffNumstat, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        const args = data.staged
            ? ['diff', '--cached', '--numstat']
            : ['diff', '--numstat']
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })

    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>(RPC_METHODS.GitDiffFile, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }

        const scoped = data.scope !== undefined || data.baseRef !== undefined
        if (!scoped) {
            const fileError = validateFilePath(data.filePath, workingDirectory)
            if (fileError) {
                return rpcError(fileError)
            }

            const args = data.staged
                ? ['diff', '--cached', '--no-ext-diff', '--', data.filePath]
                : ['diff', '--no-ext-diff', '--', data.filePath]
            return await runGitCommand(args, resolved.cwd, data.timeout)
        }

        const readOptions = GitReadOptionsSchema.safeParse({
            scope: data.scope,
            baseRef: data.baseRef
        })
        if (!readOptions.success) {
            return rpcError('Invalid Git read options')
        }

        const contextResult = await resolveRepositoryContext(resolved.cwd, workingDirectory)
        if (!contextResult.context) {
            return rpcError(contextResult.error ?? 'Unable to resolve git repository')
        }

        const result = await readScopedFileDiff(contextResult.context, workingDirectory, {
            filePath: data.filePath,
            scope: readOptions.data.scope,
            baseRef: readOptions.data.baseRef,
            timeoutMs: data.timeout
        })
        return result
    })

    rpcHandlerManager.registerHandler<GitActionRpcRequest, GitActionResponse>(RPC_METHODS.GitAction, async (data) => {
        const request = (data ?? {}) as GitActionRpcRequest
        const { cwd, ...payload } = request
        const parsed = GitActionRequestSchema.safeParse(payload)
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path.join('.')
            return {
                success: false,
                steps: [],
                error: field ? `Invalid Git action request (${field})` : 'Invalid Git action request'
            }
        }

        const resolved = resolveCwd(cwd, workingDirectory)
        if (resolved.error) {
            return { success: false, steps: [], error: resolved.error }
        }

        return await runGitAction(parsed.data, {
            cwd: resolved.cwd,
            workingDirectory
        })
    })
}
