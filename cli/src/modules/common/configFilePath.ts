import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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

/**
 * Path the file page can open.
 * Inside the session directory this is the relative path.
 * A real config file outside it is the absolute real path.
 * A symlink whose target leaves its parent directory is omitted.
 */
export function listedConfigFilePath(file: string, cwd: string): string | undefined {
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
