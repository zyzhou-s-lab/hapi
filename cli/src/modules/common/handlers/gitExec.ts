import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_BUFFER_BYTES = 32 * 1024 * 1024

export const READ_TIMEOUT_MS = 15_000
export const LOCAL_WRITE_TIMEOUT_MS = 60_000
export const NETWORK_TIMEOUT_MS = 120_000
export const GH_TIMEOUT_MS = 20_000
export const GH_PROBE_TIMEOUT_MS = 5_000

export type CommandResult = {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    timedOut: boolean
}

const NONINTERACTIVE_ENV: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1'
}

const URL_WITH_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
const SECRET_PAIR = /\b(token|password|passwd|pwd|secret|authorization|bearer|api[_-]?key)\b(\s*[=:]\s*|\s+)\S+/gi
const GITHUB_TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g

/**
 * Removes credentials that a remote URL or a CLI diagnostic may echo back.
 * Only apply this to command diagnostics, never to file content such as diffs.
 */
export function sanitizeGitOutput(value: string): string {
    return value
        .replace(URL_WITH_USERINFO, '$1***@')
        .replace(GITHUB_TOKEN, '***')
        .replace(SECRET_PAIR, (match, key: string) => `${key}=***`)
}

export function truncateOutput(value: string, limit = 20_000): string {
    if (value.length <= limit) return value
    return `${value.slice(0, limit)}\n[output truncated]`
}

function buildEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...NONINTERACTIVE_ENV,
        ...(extra ?? {})
    }
    if (process.platform !== 'win32') {
        if (!env.GIT_SSH_COMMAND) {
            env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes'
        }
        if (!env.SSH_ASKPASS_REQUIRE) {
            env.SSH_ASKPASS_REQUIRE = 'never'
        }
    }
    return env
}

export async function runCommand(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
    try {
        const result = await execFileAsync(command, args, {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            maxBuffer: MAX_BUFFER_BYTES,
            env: buildEnvironment(options.env),
            windowsHide: true,
            encoding: 'utf8'
        }) as { stdout: string; stderr: string }
        return {
            success: true,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            exitCode: 0,
            timedOut: false
        }
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
            stdout?: string | Buffer
            stderr?: string | Buffer
            code?: number | string
            killed?: boolean
            signal?: string
        }
        const stderr = String(failure.stderr ?? '')
        const timedOut = failure.killed === true || failure.code === 'ETIMEDOUT'
        const exitCode = typeof failure.code === 'number' ? failure.code : -1
        const fallback = failure.code === 'ENOENT'
            ? `${command} is not installed or is not available on PATH`
            : timedOut
                ? `${command} timed out after ${Math.round(options.timeoutMs / 1000)}s`
                : `${command} failed`
        return {
            success: false,
            stdout: String(failure.stdout ?? ''),
            stderr: stderr || failure.message || fallback,
            exitCode,
            timedOut
        }
    }
}

export function runGit(args: string[], cwd: string, timeoutMs = READ_TIMEOUT_MS): Promise<CommandResult> {
    return runCommand('git', args, { cwd, timeoutMs })
}
