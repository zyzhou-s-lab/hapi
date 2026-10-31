import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { redactConfigSecrets, type SessionInventory, type SessionPromptItem, type SessionPromptScope } from '@hapi/protocol/schemas'
import { configuration } from '@/configuration'
import { displayedCodexDeveloperInstructions } from '@/codex/utils/appServerConfig'
import { getSystemPrompt } from '@/claude/utils/systemPrompt'
import { getGrokTitleInstruction } from '@/grok/utils/systemPrompt'
import { getOpencodeNativeToolInstruction, getTitleInstruction, PLAN_MODE_INSTRUCTION } from '@/opencode/utils/systemPrompt'

const TEXT_LIMIT = 128 * 1024
const PREVIEW_LIMIT = 120

export type SessionPromptLive = {
    claude?: { custom?: string; append?: string }
    codex?: { collaboration?: 'default' | 'plan'; extra?: string; proactiveMultiAgent?: boolean }
    opencode?: { plan?: boolean; remote?: boolean }
    omp?: { systemPrompt?: string[] }
}

const liveBySession = new Map<string, SessionPromptLive>()

export function setSessionPromptLive(sessionId: string, live: SessionPromptLive): void {
    liveBySession.set(sessionId, live)
}

export function getSessionPromptLive(sessionId: string | undefined): SessionPromptLive | undefined {
    if (!sessionId) return undefined
    return liveBySession.get(sessionId)
}

type Env = NodeJS.ProcessEnv

type CollectInput = {
    flavor: string
    cwd: string
    home?: string
    startingMode?: string | null
    sessionId?: string
    promptLive?: SessionPromptLive
    env?: Env
    hapiHome?: string
}

type Draft = {
    role: 'system' | 'user'
    scope: SessionPromptScope
    title: string
    pathLabel?: string
    load?: 'path' | 'demand'
    match?: string
    note?: string
    hasText?: boolean
    codexCapped?: boolean
    truncated?: boolean
    text?: string
}

type Body = { text: string; truncated: boolean }

type Collected = {
    prompts: NonNullable<SessionInventory['prompts']>
    body(id: string): (Body & { title: string; load?: 'path' | 'demand'; match?: string; note?: string; codexCapped?: boolean }) | null
}

function clip(value: string, max: number): string {
    return value.length <= max ? value : value.slice(0, max)
}

function previewOf(text: string): string | undefined {
    const flat = redactConfigSecrets(text).replace(/\s+/g, ' ').trim()
    if (!flat) return undefined
    return clip(flat, PREVIEW_LIMIT)
}

function promptId(draft: Draft, index: number): string {
    const raw = `${draft.role}:${draft.scope}:${draft.title}:${draft.pathLabel ?? ''}:${index}`
    let hash = 2166136261
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return `p${(hash >>> 0).toString(16)}`
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readJson(path: string): unknown {
    const body = readBody(path)
    if (!body) return null
    try {
        return JSON.parse(body.text) as unknown
    } catch {
        return null
    }
}

function readBody(path: string): Body | null {
    let linked
    try {
        linked = lstatSync(path)
    } catch {
        return null
    }
    if (linked.isSymbolicLink() || !linked.isFile()) return null
    let fd: number | null = null
    try {
        const info = statSync(path)
        if (!info.isFile()) return null
        const bytes = Math.min(info.size, TEXT_LIMIT + 1)
        const buffer = Buffer.alloc(bytes)
        fd = openSync(path, 'r')
        const read = readSync(fd, buffer, 0, bytes, 0)
        const text = buffer.subarray(0, read).toString('utf8')
        const truncated = info.size > TEXT_LIMIT
        return { text: truncated ? text.slice(0, TEXT_LIMIT) : text, truncated }
    } catch {
        return null
    } finally {
        if (fd !== null) closeSync(fd)
    }
}

function hasImport(text: string): boolean {
    const withoutFences = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    return /(^|\s)@[^\s`]+/.test(withoutFences)
}

function displayPath(file: string, cwd: string, home: string): string {
    const abs = resolve(file)
    if (abs.startsWith('/Library/Application Support/ClaudeCode') || abs.startsWith('/etc/claude-code') || /^[A-Za-z]:\\Program Files\\ClaudeCode/.test(abs)) {
        return abs
    }
    const homeAbs = resolve(home)
    if (abs === homeAbs || abs.startsWith(homeAbs + sep)) {
        return `~${abs.slice(homeAbs.length).split(sep).join('/')}`
    }
    const rel = relative(cwd, abs).split(sep).join('/')
    return rel && !rel.startsWith('/') ? rel : abs.split(sep).pop() || abs
}

function gitRoot(cwd: string, home: string): string {
    let current = resolve(cwd)
    const seen = new Set<string>()
    while (!seen.has(current)) {
        seen.add(current)
        if (current === resolve(home)) break
        try {
            if (lstatSync(join(current, '.git')).isDirectory() || lstatSync(join(current, '.git')).isFile()) return current
        } catch {
            // keep walking
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return resolve(cwd)
}

function upward(start: string, stopAt: string): string[] {
    const out: string[] = []
    let current = resolve(start)
    const seen = new Set<string>()
    const stop = resolve(stopAt)
    while (!seen.has(current)) {
        seen.add(current)
        out.push(current)
        if (current === stop) break
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return out
}

function listFiles(dir: string, accept: (name: string) => boolean, recursive: boolean): string[] {
    const out: string[] = []
    const walk = (current: string, depth: number) => {
        if (depth > 6 || out.length >= 200) return
        let linked
        try {
            linked = lstatSync(current)
        } catch {
            return
        }
        if (linked.isSymbolicLink() || !linked.isDirectory()) return
        let names: string[] = []
        try {
            names = readdirSync(current)
        } catch {
            return
        }
        for (const name of names.sort()) {
            if (out.length >= 200) return
            const path = join(current, name)
            let info
            try {
                info = lstatSync(path)
            } catch {
                continue
            }
            if (info.isSymbolicLink()) continue
            if (info.isDirectory()) {
                if (recursive) walk(path, depth + 1)
                continue
            }
            if (info.isFile() && accept(name)) out.push(path)
        }
    }
    walk(dir, 0)
    return out
}

type Matter = { values: Record<string, string>; lists: Record<string, string[]>; body: string }

function matter(text: string): Matter {
    const values: Record<string, string> = {}
    const lists: Record<string, string[]> = {}
    if (!text.startsWith('---')) return { values, lists, body: text }
    const end = text.indexOf('\n---', 3)
    if (end < 0) return { values, lists, body: text }
    const raw = text.slice(text.indexOf('\n', 0) + 1, end)
    let listKey: string | null = null
    for (const line of raw.split(/\r?\n/)) {
        const item = /^\s*-\s*(.*)$/.exec(line)
        if (item && listKey) {
            const value = item[1].trim().replace(/^['"]|['"]$/g, '')
            if (value) lists[listKey].push(value)
            continue
        }
        const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
        if (!field) {
            listKey = null
            continue
        }
        const key = field[1]
        const value = field[2].trim().replace(/^['"]|['"]$/g, '')
        if (!value) {
            listKey = key
            lists[key] = []
            continue
        }
        listKey = null
        values[key] = value
    }
    const body = text.slice(end + 4).replace(/^\r?\n/, '')
    return { values, lists, body }
}

function fieldList(parsed: Matter, key: string): string[] {
    if (parsed.lists[key]?.length) return parsed.lists[key]
    const raw = parsed.values[key]
    if (!raw) return []
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '')
    return inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function enabled(parsed: Matter): boolean {
    return parsed.values.enabled !== 'false'
}

function globMatch(pattern: string, filePath: string): boolean {
    const target = filePath.replace(/\\/g, '/')
    const source = pattern.replace(/\\/g, '/')
    const expression = `^${source
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DS::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DS::/g, '.*')}$`
    return new RegExp(expression).test(target)
}

function pushFile(drafts: Draft[], input: {
    role?: 'user'
    scope: SessionPromptScope
    title: string
    path: string
    cwd: string
    home: string
    load?: 'path' | 'demand'
    match?: string
    note?: string
    codexCapped?: boolean
}): void {
    const body = readBody(input.path)
    if (!body || !body.text.trim()) return
    const parsed = matter(body.text)
    drafts.push({
        role: 'user',
        scope: input.scope,
        title: input.title,
        pathLabel: displayPath(input.path, input.cwd, input.home),
        ...(input.load ? { load: input.load } : {}),
        ...(input.match ? { match: input.match } : {}),
        note: hasImport(body.text) ? 'no-import' : input.note,
        truncated: body.truncated,
        ...(input.codexCapped ? { codexCapped: true } : {}),
        text: redactConfigSecrets(body.text),
    })
}

function finish(drafts: Draft[], note?: string): { items: SessionPromptItem[]; bodies: Map<string, Body & { title: string; load?: 'path' | 'demand'; match?: string; note?: string; codexCapped?: boolean }> } {
    const bodies = new Map<string, Body & { title: string; load?: 'path' | 'demand'; match?: string; note?: string; codexCapped?: boolean }>()
    const items: SessionPromptItem[] = []
    for (const [index, draft] of drafts.slice(0, 400).entries()) {
        const id = promptId(draft, index)
        const preview = draft.text ? previewOf(draft.text) : undefined
        const item: SessionPromptItem = {
            id,
            role: draft.role,
            scope: draft.scope,
            title: clip(draft.title, 200),
            ...(draft.pathLabel ? { pathLabel: clip(draft.pathLabel, 300) } : {}),
            ...(preview ? { preview } : {}),
            ...(draft.truncated ? { truncated: true } : {}),
            ...(draft.load ? { load: draft.load } : {}),
            ...(draft.match ? { match: clip(draft.match, 300) } : {}),
            ...(draft.note ? { note: clip(draft.note, 80) } : {}),
            ...(draft.hasText === false ? { hasText: false } : {}),
            ...(draft.codexCapped ? { codexCapped: true } : {}),
        }
        items.push(item)
        if (draft.hasText !== false && draft.text !== undefined) {
            bodies.set(id, {
                text: draft.text.slice(0, TEXT_LIMIT),
                truncated: draft.truncated === true,
                title: item.title,
                ...(draft.load ? { load: draft.load } : {}),
                ...(draft.match ? { match: clip(draft.match, 300) } : {}),
                ...(draft.note ? { note: draft.note } : {}),
                ...(draft.codexCapped ? { codexCapped: true } : {}),
            })
        }
    }
    return { items, bodies }
}

function block(items: SessionPromptItem[], note?: string): NonNullable<SessionInventory['prompts']>['system'] {
    if (items.length === 0) {
        return { availability: 'none', ...(note ? { note } : {}), items: [] }
    }
    return { availability: 'listed', ...(note ? { note } : {}), items }
}

function claudeSettings(path: string): Record<string, unknown> {
    return asRecord(readJson(path))
}

function instructionMode(userSettings: Record<string, unknown>, managed: Record<string, unknown>): string {
    const from = (settings: Record<string, unknown>): string | undefined => {
        const plugins = asRecord(settings.pluginConfigs)
        const current = asRecord(asRecord(plugins['cc-plugin-agents-md@builtin']).options).instructionFiles
        const legacy = asRecord(asRecord(plugins['agents-md@builtin']).options).instructionFiles
        const value = typeof current === 'string' ? current : typeof legacy === 'string' ? legacy : undefined
        return value
    }
    return from(managed) || from(userSettings) || 'claude-md-or-agents-md'
}

function excludes(settingsList: Record<string, unknown>[]): string[] {
    const out: string[] = []
    for (const settings of settingsList) {
        const value = settings.claudeMdExcludes
        if (!Array.isArray(value)) continue
        for (const pattern of value) {
            if (typeof pattern === 'string' && pattern.trim()) out.push(pattern.trim())
        }
    }
    return out
}

function excluded(patterns: string[], file: string): boolean {
    const abs = resolve(file).replace(/\\/g, '/')
    return patterns.some((pattern) => globMatch(pattern, abs))
}

function collectClaude(input: CollectInput, live: SessionPromptLive | undefined): Collected {
    const home = input.home ?? homedir()
    const cwd = resolve(input.cwd)
    const claudeDir = input.env?.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
    const userSettings = claudeSettings(join(claudeDir, 'settings.json'))
    const managedPath = process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : process.platform === 'win32'
            ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
            : '/etc/claude-code/managed-settings.json'
    const managed = claudeSettings(managedPath)
    const mode = instructionMode(userSettings, managed)
    const projectSettings = upward(cwd, sep).flatMap((dir) => [
        claudeSettings(join(dir, '.claude', 'settings.json')),
        claudeSettings(join(dir, '.claude', 'settings.local.json')),
    ])
    const skip = excludes([managed, userSettings, ...projectSettings])
    const systemText = claudeSystemText(input.startingMode, live)
    const systemDraft: Draft = {
        role: 'system',
        scope: 'injected',
        title: systemText.title,
        text: redactConfigSecrets(systemText.text),
    }
    const user: Draft[] = []
    if (mode !== 'managed-only') {
        const userFile = join(claudeDir, 'CLAUDE.md')
        if (!excluded(skip, userFile)) pushFile(user, { scope: 'user', title: 'CLAUDE.md', path: userFile, cwd, home })
        for (const path of listFiles(join(claudeDir, 'rules'), (name) => name.endsWith('.md'), true)) {
            if (excluded(skip, path)) continue
            const body = readBody(path)
            if (!body) continue
            const parsed = matter(body.text)
            const paths = fieldList(parsed, 'paths')
            pushFile(user, {
                scope: 'user',
                title: path.split(sep).pop() || 'rule.md',
                path,
                cwd,
                home,
                ...(paths.length > 0 ? { load: 'path', match: paths.join(', ') } : {}),
            })
        }
    }
    const managedFile = process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
        : process.platform === 'win32'
            ? 'C:\\Program Files\\ClaudeCode\\CLAUDE.md'
            : '/etc/claude-code/CLAUDE.md'
    pushFile(user, { scope: 'managed', title: 'CLAUDE.md', path: managedFile, cwd, home })
    const claudeMd = managed.claudeMd
    if (typeof claudeMd === 'string' && claudeMd.trim()) {
        user.push({
            role: 'user',
            scope: 'managed',
            title: 'claudeMd',
            pathLabel: displayPath(managedPath, cwd, home),
            text: redactConfigSecrets(claudeMd),
        })
    }
    if (mode !== 'managed-only') {
        const chain = upward(cwd, sep).reverse()
        const projectClaude = chain.some((dir) => (
            readBody(join(dir, 'CLAUDE.md'))
            || readBody(join(dir, '.claude', 'CLAUDE.md'))
            || readBody(join(dir, 'CLAUDE.local.md'))
        ))
        const includeAgents = mode === 'claude-md-and-agents-md' || (mode === 'claude-md-or-agents-md' && !projectClaude)
        for (const dir of chain) {
            for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
                const path = join(dir, name)
                if (excluded(skip, path)) continue
                pushFile(user, { scope: 'project', title: name.split(sep).pop() || name, path, cwd, home })
            }
            for (const path of listFiles(join(dir, '.claude', 'rules'), (name) => name.endsWith('.md'), true)) {
                if (excluded(skip, path)) continue
                const body = readBody(path)
                if (!body) continue
                const paths = fieldList(matter(body.text), 'paths')
                pushFile(user, {
                    scope: 'project',
                    title: path.split(sep).pop() || 'rule.md',
                    path,
                    cwd,
                    home,
                    ...(paths.length > 0 ? { load: 'path', match: paths.join(', ') } : {}),
                })
            }
            if (includeAgents) {
                for (const name of ['AGENTS.md', join('.claude', 'AGENTS.md')]) {
                    const path = join(dir, name)
                    if (excluded(skip, path)) continue
                    pushFile(user, {
                        scope: 'project',
                        title: name.split(sep).pop() || name,
                        path,
                        cwd,
                        home,
                        note: 'agents-inferred',
                    })
                }
            }
        }
    }
    const system = finish([systemDraft])
    const users = finish(user)
    const bodies = new Map([...system.bodies, ...users.bodies])
    return {
        prompts: { system: block(system.items, 'claude-builtin'), user: block(users.items) },
        body: (id) => bodies.get(id) ?? null,
    }
}

function claudeSystemText(startingMode: string | null | undefined, live: SessionPromptLive | undefined): { title: string; text: string } {
    const hapi = getSystemPrompt()
    if (startingMode === 'remote') {
        const custom = live?.claude?.custom?.trim()
        if (custom) return { title: 'system-prompt', text: `${custom}\n\n${hapi}` }
        const append = live?.claude?.append?.trim()
        return { title: 'append-system-prompt', text: append ? `${append}\n\n${hapi}` : hapi }
    }
    return { title: 'append-system-prompt', text: hapi }
}

function codexFallbacks(text: string): { maxBytes: number; names: string[] } {
    const maxMatch = /(?:^|\n)\s*project_doc_max_bytes\s*=\s*(\d+)/.exec(text)
    const maxBytes = maxMatch ? Number(maxMatch[1]) : 32 * 1024
    const array = /(?:^|\n)\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/.exec(text)
    const names: string[] = []
    if (array) {
        for (const match of array[1].matchAll(/"([^"]+)"|'([^']+)'/g)) {
            const name = match[1] || match[2]
            if (name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..') names.push(name)
        }
    }
    return { maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024, names }
}

function pickCodex(dir: string, names: string[]): { path: string; size: number } | null {
    for (const name of names) {
        const path = join(dir, name)
        const body = readBody(path)
        if (!body?.text.trim()) continue
        let size = Buffer.byteLength(body.text)
        try {
            const info = statSync(path)
            if (info.isFile()) size = info.size
        } catch {
            // the bytes we managed to read still count
        }
        return { path, size }
    }
    return null
}

function collectCodex(input: CollectInput, live: SessionPromptLive | undefined): Collected {
    const home = input.home ?? homedir()
    const cwd = resolve(input.cwd)
    const codexHome = input.env?.CODEX_HOME?.trim() || join(home, '.codex')
    const configText = readFileIfRegular(join(codexHome, 'config.toml'))
    const settings = codexFallbacks(configText)
    const local = input.startingMode === 'local'
    const plan = !local && live?.codex?.collaboration === 'plan'
    const text = displayedCodexDeveloperInstructions({
        local,
        plan,
        extra: live?.codex?.extra,
        proactiveMultiAgent: live?.codex?.proactiveMultiAgent,
    })
    const systemDrafts: Draft[] = text ? [{
        role: 'system',
        scope: 'injected',
        title: 'developer_instructions',
        text: redactConfigSecrets(text),
    }] : []
    const chosen: { path: string; size: number; scope: SessionPromptScope }[] = []
    const global = pickCodex(codexHome, ['AGENTS.override.md', 'AGENTS.md'])
    if (global) chosen.push({ ...global, scope: 'user' })
    const root = gitRoot(cwd, home)
    const dirs = upward(cwd, root).reverse()
    for (const dir of dirs) {
        const file = pickCodex(dir, ['AGENTS.override.md', 'AGENTS.md', ...settings.names.filter((name) => name !== 'AGENTS.override.md' && name !== 'AGENTS.md')])
        if (file) chosen.push({ ...file, scope: 'project' })
    }
    let used = 0
    const user: Draft[] = []
    for (const file of chosen) {
        const capped = used >= settings.maxBytes || used + file.size > settings.maxBytes
        used += file.size
        pushFile(user, {
            scope: file.scope,
            title: file.path.split(sep).pop() || 'AGENTS.md',
            path: file.path,
            cwd,
            home,
            ...(capped ? { codexCapped: true } : {}),
        })
    }
    const system = finish(systemDrafts)
    const users = finish(user)
    const bodies = new Map([...system.bodies, ...users.bodies])
    return {
        prompts: {
            system: block(system.items, plan ? 'codex-plan' : undefined),
            user: block(users.items),
        },
        body: (id) => bodies.get(id) ?? null,
    }
}

function readFileIfRegular(path: string): string {
    const body = readBody(path)
    return body?.text ?? ''
}

function cursorRules(dir: string): Draft[] {
    const drafts: Draft[] = []
    for (const path of listFiles(dir, (name) => name.endsWith('.mdc'), true)) {
        const body = readBody(path)
        if (!body?.text.trim()) continue
        const parsed = matter(body.text)
        if (!enabled(parsed)) continue
        const always = parsed.values.alwaysApply === 'true'
        const globs = fieldList(parsed, 'globs')
        drafts.push({
            role: 'user',
            scope: 'project',
            title: path.split(sep).pop() || 'rule.mdc',
            pathLabel: path,
            text: redactConfigSecrets(body.text),
            truncated: body.truncated,
            ...(always && globs.length === 0 ? {} : globs.length > 0
                ? { load: 'path' as const, match: globs.join(', ') }
                : { load: 'demand' as const }),
            ...(hasImport(body.text) ? { note: 'no-import' } : {}),
        })
    }
    return drafts
}

function collectCursor(input: CollectInput, demandOnly: boolean): Draft[] {
    const home = input.home ?? homedir()
    const cwd = resolve(input.cwd)
    const root = gitRoot(cwd, home)
    const dirs = new Set<string>([join(root, '.cursor', 'rules'), join(cwd, '.cursor', 'rules')])
    if (demandOnly) dirs.add(join(home, '.cursor', 'rules'))
    const drafts: Draft[] = []
    for (const dir of dirs) {
        for (const draft of cursorRules(dir)) {
            if (demandOnly && !draft.load) continue
            const abs = draft.pathLabel || ''
            const insideProject = abs === root || abs.startsWith(`${root}${sep}`) || abs === cwd || abs.startsWith(`${cwd}${sep}`)
            drafts.push({
                ...draft,
                pathLabel: displayPath(abs, cwd, home),
                scope: insideProject ? 'project' : 'user',
                ...(demandOnly ? { load: 'demand' as const } : {}),
            })
        }
    }
    if (!demandOnly) {
        for (const dir of upward(cwd, root).reverse()) {
            pushFile(drafts, { scope: 'project', title: 'AGENTS.md', path: join(dir, 'AGENTS.md'), cwd, home })
        }
        drafts.push({
            role: 'user',
            scope: 'user',
            title: 'cursor-account',
            hasText: false,
            note: 'cursor-account',
        })
    }
    return drafts
}

function collectOpencode(input: CollectInput, live: SessionPromptLive | undefined): Collected {
    const home = input.home ?? homedir()
    const cwd = resolve(input.cwd)
    const remote = live?.opencode?.remote ?? input.startingMode !== 'local'
    const plan = live?.opencode?.plan === true
    const system: Draft[] = []
    if (remote) {
        system.push({
            role: 'system',
            scope: 'injected',
            title: 'first-message',
            text: redactConfigSecrets(getOpencodeNativeToolInstruction()),
        })
        if (plan) {
            system.push({
                role: 'system',
                scope: 'injected',
                title: 'plan-mode',
                text: redactConfigSecrets(PLAN_MODE_INSTRUCTION),
            })
        }
    } else {
        const configDir = input.env?.OPENCODE_CONFIG_DIR?.trim()
            || (input.sessionId ? join(input.hapiHome || configuration.happyHomeDir, 'tmp', 'opencode', input.sessionId, '.opencode') : '')
        const file = configDir ? join(configDir, 'hapi-instructions.md') : ''
        const body = file ? readBody(file) : null
        system.push({
            role: 'system',
            scope: 'injected',
            title: 'hapi-instructions.md',
            ...(file && body ? { pathLabel: displayPath(file, cwd, home) } : {}),
            text: redactConfigSecrets(body?.text ?? getTitleInstruction()),
            ...(body?.truncated ? { truncated: true } : {}),
        })
    }
    const user: Draft[] = []
    const disableClaude = input.env?.OPENCODE_DISABLE_CLAUDE_CODE === '1' || input.env?.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT === '1'
    const globalAgents = join(home, '.config', 'opencode', 'AGENTS.md')
    const globalClaude = join(home, '.claude', 'CLAUDE.md')
    if (readBody(globalAgents)) pushFile(user, { scope: 'user', title: 'AGENTS.md', path: globalAgents, cwd, home })
    else if (!disableClaude) pushFile(user, { scope: 'user', title: 'CLAUDE.md', path: globalClaude, cwd, home })
    const root = gitRoot(cwd, home)
    for (const dir of upward(cwd, root).reverse()) {
        const agents = join(dir, 'AGENTS.md')
        const claude = join(dir, 'CLAUDE.md')
        if (readBody(agents)) pushFile(user, { scope: 'project', title: 'AGENTS.md', path: agents, cwd, home })
        else pushFile(user, { scope: 'project', title: 'CLAUDE.md', path: claude, cwd, home })
    }
    const hapiRoot = resolve(input.hapiHome || configuration.happyHomeDir)
    const configs = [
        join(cwd, 'opencode.json'),
        join(home, '.config', 'opencode', 'opencode.json'),
    ]
    for (const configPath of configs) {
        if (resolve(configPath).startsWith(join(hapiRoot, 'tmp', 'opencode'))) continue
        const parsed = readJson(configPath)
        const instructions = asRecord(parsed).instructions
        if (!Array.isArray(instructions)) continue
        instructions.forEach((entry, index) => {
            if (typeof entry !== 'string') return
            if (/^https?:\/\//i.test(entry)) {
                user.push({ role: 'user', scope: 'project', title: 'remote-url', hasText: false, note: 'remote-url', match: String(index + 1) })
                return
            }
            if (entry.includes('..') || entry.endsWith('hapi-instructions.md')) return
            const base = dirname(configPath)
            if (entry.includes('*')) {
                const star = entry.indexOf('*')
                const folder = star <= 0 ? base : join(base, entry.slice(0, star))
                for (const path of listFiles(folder, () => true, true)) {
                    const rel = relative(base, path).split(sep).join('/')
                    if (!globMatch(entry, rel)) continue
                    const abs = resolve(path)
                    const baseAbs = resolve(base)
                    const cwdAbs = resolve(cwd)
                    if (abs !== baseAbs && !abs.startsWith(`${baseAbs}${sep}`) && abs !== cwdAbs && !abs.startsWith(`${cwdAbs}${sep}`)) continue
                    pushFile(user, { scope: 'project', title: path.split(sep).pop() || 'instruction.md', path, cwd, home })
                }
                return
            }
            const path = join(base, entry)
            if (!resolve(path).startsWith(resolve(base)) && !resolve(path).startsWith(cwd)) return
            pushFile(user, { scope: 'project', title: path.split(sep).pop() || 'instruction.md', path, cwd, home })
        })
    }
    const systemDone = finish(system)
    const userDone = finish(user)
    const bodies = new Map([...systemDone.bodies, ...userDone.bodies])
    return {
        prompts: { system: block(systemDone.items), user: block(userDone.items) },
        body: (id) => bodies.get(id) ?? null,
    }
}

function collectOmp(input: CollectInput, live: SessionPromptLive | undefined): Collected {
    const home = input.home ?? homedir()
    const cwd = resolve(input.cwd)
    const system: Draft[] = (live?.omp?.systemPrompt ?? []).filter((part) => part.trim()).map((part, index) => ({
        role: 'system' as const,
        scope: 'injected' as const,
        title: 'system-prompt',
        pathLabel: String(index + 1),
        text: redactConfigSecrets(part),
    }))
    const user: Draft[] = []
    for (const draft of collectCursor({ ...input, home, cwd }, true)) {
        user.push(draft)
    }
    const copilotDirs = [
        join(cwd, '.github', 'instructions'),
        ...(input.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '').split(',').map((dir) => dir.trim()).filter(Boolean),
    ]
    for (const dir of copilotDirs) {
        for (const path of listFiles(dir, (name) => name.endsWith('.instructions.md'), true)) {
            const body = readBody(path)
            if (!body?.text.trim()) continue
            const parsed = matter(body.text)
            if (!enabled(parsed)) continue
            const applyTo = fieldList(parsed, 'applyTo')
            const single = parsed.values.applyTo
            const match = applyTo.length > 0 ? applyTo.join(', ') : single
            if (!match) continue
            user.push({
                role: 'user',
                scope: resolve(path).startsWith(resolve(home) + sep) && !resolve(path).startsWith(cwd) ? 'user' : 'project',
                title: path.split(sep).pop() || 'instructions.md',
                pathLabel: displayPath(path, cwd, home),
                load: 'demand',
                match,
                text: redactConfigSecrets(body.text),
                truncated: body.truncated,
                ...(hasImport(body.text) ? { note: 'no-import' } : {}),
            })
        }
    }
    for (const dir of upward(cwd, gitRoot(cwd, home))) {
        const rules = join(dir, '.clinerules')
        let linked
        try {
            linked = lstatSync(rules)
        } catch {
            continue
        }
        if (linked.isSymbolicLink()) break
        if (linked.isFile()) {
            pushFile(user, { scope: 'project', title: 'clinerules', path: rules, cwd, home, load: 'demand' })
        } else if (linked.isDirectory()) {
            for (const path of listFiles(rules, (name) => name.endsWith('.md'), false)) {
                const body = readBody(path)
                const globs = body ? fieldList(matter(body.text), 'globs') : []
                pushFile(user, {
                    scope: 'project',
                    title: path.split(sep).pop() || 'rule.md',
                    path,
                    cwd,
                    home,
                    load: 'demand',
                    ...(globs.length > 0 ? { match: globs.join(', ') } : {}),
                })
            }
        }
        break
    }
    const codexHome = input.env?.CODEX_HOME?.trim() || join(home, '.codex')
    const configText = readFileIfRegular(join(codexHome, 'config.toml'))
    const names = ['AGENTS.override.md', 'AGENTS.md', ...codexFallbacks(configText).names]
    const global = pickCodex(codexHome, ['AGENTS.override.md', 'AGENTS.md'])
    if (global) pushFile(user, { scope: 'user', title: global.path.split(sep).pop() || 'AGENTS.md', path: global.path, cwd, home, load: 'demand' })
    for (const dir of upward(cwd, gitRoot(cwd, home)).reverse()) {
        const file = pickCodex(dir, names)
        if (!file) continue
        pushFile(user, { scope: 'project', title: file.path.split(sep).pop() || 'AGENTS.md', path: file.path, cwd, home, load: 'demand' })
        for (const folder of ['.agent', '.agents']) {
            const agents = join(dir, folder, 'AGENTS.md')
            pushFile(user, { scope: 'project', title: 'AGENTS.md', path: agents, cwd, home, load: 'demand' })
        }
    }
    const agentDir = input.env?.PI_CODING_AGENT_DIR?.trim() || join(home, '.omp', 'agent')
    const ruleDirs = [join(cwd, '.omp', 'rules'), join(agentDir, 'rules')]
    try {
        const ompDir = lstatSync(join(cwd, '.omp'))
        if (ompDir.isSymbolicLink() || !ompDir.isDirectory() || readdirSync(join(cwd, '.omp')).length === 0) ruleDirs.shift()
    } catch {
        ruleDirs.shift()
    }
    for (const dir of ruleDirs) {
        for (const path of listFiles(dir, (name) => name.endsWith('.md') || name.endsWith('.mdc'), false)) {
            const body = readBody(path)
            if (!body?.text.trim()) continue
            const parsed = matter(body.text)
            if (!enabled(parsed)) continue
            const triggers = [...fieldList(parsed, 'condition'), ...fieldList(parsed, 'ttsr_trigger')]
            const single = parsed.values.condition || parsed.values.ttsr_trigger
            if (single && !triggers.includes(single)) triggers.unshift(single)
            if (triggers.length === 0) continue
            user.push({
                role: 'user',
                scope: dir.startsWith(cwd) ? 'project' : 'user',
                title: path.split(sep).pop() || 'rule.md',
                pathLabel: displayPath(path, cwd, home),
                load: 'demand',
                match: triggers.join(' | '),
                text: redactConfigSecrets(body.text),
                truncated: body.truncated,
            })
        }
    }
    const systemDone = finish(system)
    const userDone = finish(user)
    const bodies = new Map([...systemDone.bodies, ...userDone.bodies])
    return {
        prompts: { system: block(systemDone.items), user: block(userDone.items) },
        body: (id) => bodies.get(id) ?? null,
    }
}

function nonePair(systemNote?: string): Collected {
    return {
        prompts: {
            system: block([], systemNote),
            user: block([]),
        },
        body: () => null,
    }
}

export function collectSessionPrompts(input: CollectInput): Collected {
    const flavor = input.flavor.trim().toLowerCase()
    const live = { ...getSessionPromptLive(input.sessionId), ...input.promptLive }
    const home = input.home ?? homedir()
    const cwd = input.cwd
    if (flavor === 'claude') return collectClaude({ ...input, home, cwd }, live)
    if (flavor === 'codex') return collectCodex({ ...input, home, cwd }, live)
    if (flavor === 'cursor') {
        const users = finish(collectCursor({ ...input, home, cwd }, false).map((draft) => (
            draft.pathLabel && !draft.pathLabel.startsWith('~') && !draft.pathLabel.startsWith('/')
                ? draft
                : draft
        )))
        return {
            prompts: { system: block([], 'no-hapi-system'), user: block(users.items) },
            body: (id) => users.bodies.get(id) ?? null,
        }
    }
    if (flavor === 'opencode') return collectOpencode({ ...input, home, cwd }, live)
    if (flavor === 'grok') {
        const system = finish([{
            role: 'system',
            scope: 'injected',
            title: 'first-message',
            text: redactConfigSecrets(getGrokTitleInstruction()),
        }])
        return { prompts: { system: block(system.items), user: block([]) }, body: (id) => system.bodies.get(id) ?? null }
    }
    if (flavor === 'kimi') return nonePair('no-hapi-system')
    if (flavor === 'omp') return collectOmp({ ...input, home, cwd }, live)
    if (flavor === 'pi' || flavor === 'dsh' || flavor === 'agy' || flavor === 'copilot' || flavor === '') return nonePair()
    return nonePair()
}

export function readSessionPromptDetail(input: CollectInput & { id: string }): {
    id: string
    title: string
    markdown: string
    truncated: boolean
    load?: 'path' | 'demand'
    match?: string
    note?: string
    codexCapped?: boolean
} | { error: string } {
    const found = collectSessionPrompts(input).body(input.id)
    if (!found) return { error: 'Config entry not found' }
    return {
        id: input.id,
        title: found.title,
        markdown: found.text,
        truncated: found.truncated,
        ...(found.load ? { load: found.load } : {}),
        ...(found.match ? { match: found.match } : {}),
        ...(found.note ? { note: found.note } : {}),
        ...(found.codexCapped ? { codexCapped: true } : {}),
    }
}
