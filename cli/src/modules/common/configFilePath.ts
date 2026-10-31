import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function pathInside(child: string, root: string): boolean {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    return child === root || child.startsWith(prefix)
}

export function tryRealpath(path: string): string | undefined {
    try {
        return realpathSync(path)
    } catch {
        return undefined
    }
}

export type ListedConfigFileOptions = {
    /** When false, a file outside the session directory is not openable. */
    allowOutside?: boolean
    /** Home used for user-config roots. Defaults to HOME or the OS home. */
    home?: string
}

function configHome(home?: string): string {
    const selected = home?.trim() || process.env.HOME || process.env.USERPROFILE || homedir()
    return tryRealpath(selected) ?? resolve(selected)
}

/** User and global config locations. Repo-named files outside these roots stay closed. */
export function isUserConfigRealpath(real: string, home?: string): boolean {
    const base = configHome(home)
    const roots = [
        join(base, '.claude'),
        join(base, '.claude.json'),
        join(base, '.codex'),
        join(base, '.config', 'opencode'),
        join(base, '.agents'),
        join(base, '.cursor'),
        join(base, '.omp'),
        join(base, '.grok'),
        join(base, '.copilot'),
    ]
    for (const env of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.GROK_HOME, process.env.PI_CODING_AGENT_DIR]) {
        if (env?.trim()) roots.push(resolve(env.trim()))
    }
    return roots.some((root) => {
        const realRoot = tryRealpath(root) ?? resolve(root)
        return pathInside(real, realRoot)
    })
}

/**
 * Path the file page can open.
 * Inside the session directory this is the relative path.
 * Outside it, only a real file under a user or global config root.
 * A symlink whose target leaves its parent directory is omitted.
 */
export function listedConfigFilePath(file: string, cwd: string, options: ListedConfigFileOptions = {}): string | undefined {
    let linked: Stats
    try {
        linked = lstatSync(file)
    } catch {
        return undefined
    }
    if (!linked.isFile() && !linked.isSymbolicLink()) return undefined
    const real = tryRealpath(file)
    if (!real) return undefined
    try {
        if (!statSync(real).isFile()) return undefined
    } catch {
        return undefined
    }
    const root = tryRealpath(resolve(cwd)) ?? resolve(cwd)
    if (linked.isSymbolicLink()) {
        const parent = tryRealpath(resolve(file, '..'))
        if (!parent || (!pathInside(real, parent) && !pathInside(real, root))) return undefined
    }
    const rel = relative(root, real)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
    if (options.allowOutside === false) return undefined
    if (!isUserConfigRealpath(real, options.home)) return undefined
    return real.length <= 4096 ? real : undefined
}

export function lineNumberAt(text: string, index: number): number {
    return text.slice(0, Math.max(0, index)).split(/\n/).length
}

export function lineOfJsonKey(text: string, key: string): number | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`"${escaped}"\\s*:`).exec(text)
    if (!match || match.index === undefined) return undefined
    return lineNumberAt(text, match.index)
}

export function lineOfSnippet(text: string, snippet: string): number | undefined {
    if (!snippet) return undefined
    const index = text.indexOf(snippet)
    if (index < 0) return undefined
    return lineNumberAt(text, index)
}
