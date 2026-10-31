import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { redactConfigSecrets, sessionConfigLock, type SessionConfigDetail, type SessionConfigItemSelector } from '@hapi/protocol/schemas'
import { findSkill, skillWriteRoots, type SkillWriteRoot } from '@/modules/common/skills'
import { commandBasename } from './sessionInventory'
import { readSessionPromptDetail, type SessionPromptLive } from './sessionPrompts'
import {
    collectJsonObjects,
    jsonStringField,
    setFrontmatterBoolean,
    setJsonBoolean,
    removeJsonField,
    setTomlBoolean,
    writeTextAtomic,
} from './sessionConfigEdit'

const MAX_TEXT = 1_000_000
const SCRIPT_LIMIT = 32 * 1024
const NOT_FOUND = 'Config entry not found'
const LOCKED = 'This item cannot be changed'
const UNSUPPORTED = 'This agent does not honor a per-item switch'

type DetailInput = {
    cwd: string
    flavor?: string | null
    sessionId?: string
    tools?: readonly string[]
    selector: SessionConfigItemSelector
    enabled: boolean
    startingMode?: string | null
    promptLive?: SessionPromptLive
}

function lockError(flavor: string, kind: 'mcp' | 'skill' | 'hook' | 'prompt', source: string | undefined): string | null {
    const lock = sessionConfigLock(flavor, kind, source)
    if (lock === 'source') return LOCKED
    if (lock === 'unsupported') return UNSUPPORTED
    return null
}
function skillMarkdownPath(path: string, roots: readonly SkillWriteRoot[]): string | null {
    try {
        if (lstatSync(path).isSymbolicLink()) return null
        const real = realpathSync(path)
        if (basename(real) !== 'SKILL.md' || !statSync(real).isFile()) return null
        const allowed = roots.some(({ root, anchor }) => {
            try {
                const rootInfo = lstatSync(root)
                if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false
                const realRoot = realpathSync(root)
                const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
                if (!real.startsWith(prefix)) return false
                if (!anchor) return true
                const realAnchor = realpathSync(anchor)
                const anchorPrefix = realAnchor.endsWith(sep) ? realAnchor : `${realAnchor}${sep}`
                return realRoot.startsWith(anchorPrefix)
            } catch {
                return false
            }
        })
        return allowed ? real : null
    } catch {
        return null
    }
}

function readText(path: string): string | null {
    try {
        const info = statSync(path)
        if (!info.isFile() || info.size > MAX_TEXT) return null
        return readFileSync(path, 'utf8')
    } catch {
        return null
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function claudeJsonPath(): string {
    // HAPI_CLAUDE_JSON is for tests only. A real session reads ~/.claude.json.
    return process.env.HAPI_CLAUDE_JSON?.trim() || join(homedir(), '.claude.json')
}

function claudeSettingsPath(): string {
    return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'settings.json')
}

function codexConfigPath(): string {
    return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml')
}

function cursorMcpPath(): string {
    return join(homedir(), '.cursor', 'mcp.json')
}

function projectMcpFiles(cwd: string): string[] {
    const paths: string[] = []
    let current = cwd
    const seen = new Set<string>()
    while (!seen.has(current)) {
        seen.add(current)
        if (current === homedir()) break
        paths.push(join(current, '.mcp.json'))
        if (existsSync(join(current, '.git'))) break
        const parent = join(current, '..')
        if (parent === current) break
        current = parent
    }
    return paths
}

function skillBody(markdown: string): string {
    const fence = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
    return fence && fence.index === 0 ? markdown.slice(fence[0].length) : markdown
}

function jsonServer(text: string, name: string): { enabled: boolean; command?: string; args?: string[]; url?: string } | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return null
    }
    const entry = asRecord(asRecord(asRecord(parsed).mcpServers)[name])
    if (Object.keys(entry).length === 0) return null
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined
    return {
        enabled: entry.disabled !== true,
        ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
        ...(args ? { args } : {}),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    }
}
function jsonAt(text: string, path: string[]): { enabled: boolean; command?: string; args?: string[]; url?: string } | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return null
    }
    let current: unknown = parsed
    for (const key of path) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return null
        current = (current as Record<string, unknown>)[key]
    }
    const entry = asRecord(current)
    if (Object.keys(entry).length === 0) return null
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined
    return {
        enabled: entry.disabled !== true,
        ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
        ...(args ? { args } : {}),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    }
}

function claudeProjectKey(text: string, cwd: string, name: string): string | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return null
    }
    const projects = asRecord(asRecord(parsed).projects)
    const resolvedCwd = resolve(cwd)
    let best: { key: string; length: number } | null = null
    for (const key of Object.keys(projects)) {
        const project = resolve(key)
        const prefix = project.endsWith(sep) ? project : `${project}${sep}`
        if (project !== resolvedCwd && !resolvedCwd.startsWith(prefix)) continue
        const servers = asRecord(asRecord(projects[key]).mcpServers)
        if (!Object.prototype.hasOwnProperty.call(servers, name)) continue
        if (!best || project.length > best.length) best = { key, length: project.length }
    }
    return best?.key ?? null
}


function toolsFromNames(serverName: string, tools: readonly string[] | undefined): Array<{ name: string; description?: string }> {
    const prefix = `mcp__${serverName}__`
    const names = (tools ?? []).flatMap((tool) => {
        if (!tool.startsWith(prefix)) return []
        const name = tool.slice(prefix.length)
        return name && name.length <= 200 ? [name] : []
    })
    return [...new Set(names)].slice(0, 200).map((name) => ({ name }))
}


function reportedTools(serverName: string, tools: readonly string[] | undefined): { tools: Array<{ name: string }>; toolsUnavailable?: boolean } {
    const names = toolsFromNames(serverName, tools)
    return names.length > 0 ? { tools: names } : { tools: [], toolsUnavailable: true }
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.sh', '.bash', '.zsh', '.py', '.rb', '.pl'])

function withinRoot(real: string, root: string): boolean {
    return real === root || real.startsWith(root + sep)
}

function scriptFile(command: string, cwd: string): string | null {
    const tokens = command.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
    let home = homedir()
    let root = cwd
    try { home = realpathSync(home) } catch { /* keep the raw home */ }
    try { root = realpathSync(root) } catch { /* keep the raw cwd */ }
    for (const token of tokens) {
        if (!(isAbsolute(token) || token.startsWith('.'))) continue
        const candidate = isAbsolute(token) ? token : resolve(cwd, token)
        if (!existsSync(candidate)) continue
        let real = candidate
        try { real = realpathSync(candidate) } catch { continue }
        if (!withinRoot(real, home) && !withinRoot(real, root)) continue
        const info = statSync(real)
        if (!info.isFile() || info.size > MAX_TEXT) continue
        if ((info.mode & 0o111) === 0 && !SCRIPT_EXTENSIONS.has(extname(real).toLowerCase())) continue
        return real
    }
    return null
}

function scriptText(command: string, cwd: string): { script: string; truncated: boolean } {
    const file = scriptFile(command, cwd)
    let raw = command
    if (file) {
        try { raw = readFileSync(file, 'utf8') } catch { raw = command }
    }
    const redacted = redactConfigSecrets(raw)
    if (redacted.length <= SCRIPT_LIMIT) return { script: redacted, truncated: false }
    return { script: redacted.slice(0, SCRIPT_LIMIT), truncated: true }
}

function claudeHookObjects(text: string, event: string, matcher: string | undefined, commandName: string | undefined) {
    const objects = collectJsonObjects(text)
    return objects.filter((object) => {
        const raw = text.slice(object.start, object.end)
        const command = jsonStringField(raw, 'command')
        if (object.path[1] !== event || !command) return false
        if (commandName && commandBasename(command) !== commandName) return false
        if (!matcher) return true
        return objects.some((parent) => (
            parent.start <= object.start
            && parent.end >= object.end
            && jsonStringField(text.slice(parent.start, parent.end), 'matcher') === matcher
        ))
    })
}

function editClaudeHooks(text: string, event: string, matcher: string | undefined, commandName: string | undefined, index: number, disabled: boolean): string {
    const hit = claudeHookObjects(text, event, matcher, commandName)[index]
    if (!hit) throw new Error(NOT_FOUND)
    const updated = setJsonBoolean(text.slice(hit.start, hit.end), [], 'disabled', disabled)
    return `${text.slice(0, hit.start)}${updated}${text.slice(hit.end)}`
}

export async function readSessionConfigDetail(input: Omit<DetailInput, 'enabled'>): Promise<SessionConfigDetail | { error: string }> {
    const selector = input.selector
    const flavor = (input.flavor ?? '').trim().toLowerCase()
    if (selector.kind === 'prompt') {
        if (!selector.id) return { error: NOT_FOUND }
        const detail = readSessionPromptDetail({
            flavor,
            cwd: input.cwd,
            sessionId: input.sessionId,
            startingMode: input.startingMode,
            promptLive: input.promptLive,
            id: selector.id,
        })
        if ('error' in detail) return detail
        return { kind: 'prompt', ...detail }
    }
    if (selector.kind === 'skill') {
        if (!selector.name) return { error: NOT_FOUND }
        const skill = await findSkill(selector.name, input.cwd, { flavor: flavor || undefined })
        if (!skill) return { error: NOT_FOUND }
        const source = selector.source ?? skill.source
        return {
            kind: 'skill',
            name: skill.name,
            ...(source ? { source } : {}),
            enabled: skill.enabled,
            mutable: lockError(flavor, 'skill', source) === null,
            markdown: skillBody(skill.markdown),
            truncated: skill.truncated,
        }
    }
    if (selector.kind === 'mcp') {
        if (!selector.name || !selector.source) return { error: NOT_FOUND }
        if (selector.source === 'tool') {
            const toolName = selector.name.includes('__') ? selector.name.split('__').at(-1) ?? selector.name : selector.name
            return {
                kind: 'mcp',
                name: selector.name,
                source: selector.source,
                enabled: true,
                mutable: false,
                tools: toolName ? [{ name: toolName }] : [],
            }
        }
        const located = locateMcp(input.cwd, flavor, selector.name, selector.source, input.sessionId)
        const listed = reportedTools(selector.name, input.tools)
        return {
            kind: 'mcp',
            name: selector.name,
            source: selector.source,
            enabled: located?.enabled ?? true,
            mutable: lockError(flavor, 'mcp', selector.source) === null,
            ...listed,
        }
    }
    if (!selector.event || !selector.source) return { error: NOT_FOUND }
    const hook = locateHook(input.cwd, flavor, selector.source, selector.event, selector.matcher, selector.commandName, selector.index ?? 0)
    const script = scriptText(hook?.command ?? selector.commandName ?? '', input.cwd)
    return {
        kind: 'hook',
        event: selector.event,
        ...(selector.matcher ? { matcher: selector.matcher } : {}),
        ...(selector.commandName ? { commandName: selector.commandName } : {}),
        source: selector.source,
        enabled: hook?.enabled ?? true,
        mutable: lockError(flavor, 'hook', selector.source) === null,
        ...script,
    }
}

export async function writeSessionConfigEnabled(input: DetailInput): Promise<{ enabled: boolean } | { error: string }> {
    const flavor = (input.flavor ?? '').trim().toLowerCase()
    const refused = lockError(flavor, input.selector.kind, input.selector.source)
    if (refused) return { error: refused }
    try {
        if (input.selector.kind === 'skill') {
            if (!input.selector.name) return { error: NOT_FOUND }
            const skill = await findSkill(input.selector.name, input.cwd, { flavor: (input.flavor ?? '').trim().toLowerCase() || undefined })
            if (!skill || skill.source !== input.selector.source) return { error: NOT_FOUND }
            if (skill.truncated) return { error: 'Skill is too large to update' }
            const real = skill.source === 'user' || skill.source === 'project'
                ? skillMarkdownPath(skill.filePath, skillWriteRoots(input.cwd, skill.source))
                : null
            if (!real) return { error: 'Only a SKILL.md frontmatter disabled field can be changed' }
            const text = readText(real)
            if (text === null) return { error: NOT_FOUND }
            writeTextAtomic(real, setFrontmatterBoolean(text, 'disabled', !input.enabled))
            return { enabled: input.enabled }
        }
        if (input.selector.kind === 'mcp') {
            if (!input.selector.name || !input.selector.source) return { error: NOT_FOUND }
            const target = mcpEditTarget(input.cwd, (input.flavor ?? '').trim().toLowerCase(), input.selector.name, input.selector.source)
            if (!target) return { error: NOT_FOUND }
            const text = readText(target.file)
            if (text === null) return { error: NOT_FOUND }
            const next = target.format === 'toml'
                ? setTomlBoolean(text, target.header, 'enabled', input.enabled)
                : input.enabled
                    ? removeJsonField(text, target.path, 'disabled')
                    : setJsonBoolean(text, target.path, 'disabled', true)
            writeTextAtomic(target.file, next)
            return { enabled: input.enabled }
        }
        if (!input.selector.event) return { error: NOT_FOUND }
        const target = hookEditTarget(input.cwd, flavor, input.selector.source ?? 'user', input.selector.event)
        if (!target) return { error: NOT_FOUND }
        const text = readText(target.file)
        if (text === null) return { error: NOT_FOUND }
        let hookMatchCount = 0
        const next = target.format === 'toml'
            ? setTomlBoolean(text, target.header, 'enabled', input.enabled, (section) => {
                const command = /command\s*=\s*"([^"]*)"/.exec(section)?.[1]
                if (!command || (input.selector.commandName && commandBasename(command) !== input.selector.commandName)) return false
                const current = hookMatchCount
                hookMatchCount += 1
                return current === (input.selector.index ?? 0)
            })
            : editClaudeHooks(text, input.selector.event, input.selector.matcher, input.selector.commandName, input.selector.index ?? 0, !input.enabled)
        writeTextAtomic(target.file, next)
        return { enabled: input.enabled }
    } catch (error) {
        return { error: writeFailure(error) }
    }
}

function writeFailure(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = String(error.code)
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Could not update session config: permission denied'
        if (code === 'ENOSPC') return 'Could not update session config: no space'
    }
    const message = error instanceof Error ? error.message : ''
    if (message === NOT_FOUND || message === 'Skill has no frontmatter') return message === NOT_FOUND ? NOT_FOUND : 'Skill has no frontmatter'
    const redacted = redactConfigSecrets(message)
        .replace(/(^|\s)(?:~|\/)\S*/g, '$1')
        .replace(/(^|\s)[A-Za-z]:\\[^\s]*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    return redacted ? `Could not update session config: ${redacted}` : 'Could not update session config'
}

function locateMcp(cwd: string, flavor: string, name: string, source: string, sessionId?: string): { enabled: boolean; command?: string; args?: string[]; url?: string } | null {
    if (flavor === 'codex' && source === 'user') {
        const text = readText(codexConfigPath()) ?? ''
        const section = codexSection(text, `mcp_servers.${name}`)
        if (!section) return null
        return {
            enabled: !/^enabled\s*=\s*false\b/m.test(section),
            command: /command\s*=\s*"([^"]*)"/.exec(section)?.[1],
            url: /url\s*=\s*"([^"]*)"/.exec(section)?.[1],
        }
    }
    if (source === 'project' && flavor !== 'cursor') {
        const file = projectMcpFiles(cwd).find((path) => {
            const text = readText(path)
            return Boolean(text && jsonServer(text, name))
        })
        if (file) return jsonServer(readText(file) ?? '', name)
        const claude = readText(claudeJsonPath())
        const key = claude ? claudeProjectKey(claude, cwd, name) : null
        return key ? jsonAt(claude ?? '', ['projects', key, 'mcpServers', name]) : null
    }
    const file = flavor === 'cursor' ? cursorMcpPath() : claudeJsonPath()
    const text = readText(file)
    if (!text) return null
    const server = jsonServer(text, name)
    if (!server) return null
    if (flavor === 'cursor' && sessionId && name === `hapi-${sessionId}`) return { ...server, enabled: true }
    return server
}

function mcpEditTarget(cwd: string, flavor: string, name: string, source: string): { file: string; format: 'json' | 'toml'; header: string; path: string[] } | null {
    if (flavor === 'codex') return { file: codexConfigPath(), format: 'toml', header: `mcp_servers.${name}`, path: [] }
    if (flavor === 'cursor') return { file: cursorMcpPath(), format: 'json', header: '', path: ['mcpServers', name] }
    if (source === 'project') {
        const file = projectMcpFiles(cwd).find((path) => {
            const text = readText(path)
            return Boolean(text && jsonServer(text, name))
        })
        if (file) return { file, format: 'json', header: '', path: ['mcpServers', name] }
        const claude = claudeJsonPath()
        const text = readText(claude)
        const key = text ? claudeProjectKey(text, cwd, name) : null
        return key ? { file: claude, format: 'json', header: '', path: ['projects', key, 'mcpServers', name] } : null
    }
    return { file: claudeJsonPath(), format: 'json', header: '', path: ['mcpServers', name] }
}

function codexSection(text: string, header: string): string | null {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === `[${header}]` || line.trim() === `[[${header}]]`)
    if (start === -1) return null
    let end = start + 1
    while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[end])) end++
    return lines.slice(start, end).join('\n')
}

function hookSettingsPath(cwd: string, flavor: string, source: string): string {
    if (source === 'project') {
        return flavor === 'codex' ? join(cwd, '.codex', 'config.toml') : join(cwd, '.claude', 'settings.json')
    }
    return flavor === 'codex' ? codexConfigPath() : claudeSettingsPath()
}

function locateHook(cwd: string, flavor: string, source: string, event: string, matcher: string | undefined, commandName: string | undefined, index: number): { command: string; enabled: boolean } | null {
    const file = hookSettingsPath(cwd, flavor, source)
    if (flavor === 'codex') {
        const text = readText(file) ?? ''
        const sections = text.split(/\n(?=\[\[)/).filter((part) => part.includes(`[[hooks.${event}]]`) && (!commandName || commandBasename(/command\s*=\s*"([^"]*)"/.exec(part)?.[1] ?? '') === commandName))
        const section = sections[index]
        if (!section) return null
        return {
            command: /command\s*=\s*"([^"]*)"/.exec(section)?.[1] ?? '',
            enabled: !/^enabled\s*=\s*false\b/m.test(section),
        }
    }
    const text = readText(file)
    if (!text) return null
    const hit = claudeHookObjects(text, event, matcher, commandName)[index]
    if (!hit) return null
    const objectText = text.slice(hit.start, hit.end)
    return {
        command: jsonStringField(objectText, 'command') ?? '',
        enabled: !/"disabled"\s*:\s*true/.test(objectText),
    }
}

function hookEditTarget(cwd: string, flavor: string, source: string, event: string): { file: string; format: 'json' | 'toml'; header: string } | null {
    return {
        file: hookSettingsPath(cwd, flavor, source),
        format: flavor === 'codex' ? 'toml' : 'json',
        header: `hooks.${event}`,
    }
}
