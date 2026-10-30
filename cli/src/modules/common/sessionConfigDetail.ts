import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { redactConfigSecrets, type SessionConfigDetail, type SessionConfigItemSelector } from '@hapi/protocol/schemas'
import { findSkill } from '@/modules/common/skills'
import { commandBasename } from './sessionInventory'
import {
    collectJsonObjects,
    jsonStringField,
    setFrontmatterBoolean,
    setJsonBoolean,
    setTomlBoolean,
    writeTextAtomic,
} from './sessionConfigEdit'

const MAX_TEXT = 1_000_000
const SCRIPT_LIMIT = 32 * 1024
const NOT_FOUND = 'Config entry not found'
const LOCKED = 'This item cannot be changed'

type DetailInput = {
    cwd: string
    flavor?: string | null
    sessionId?: string
    tools?: readonly string[]
    selector: SessionConfigItemSelector
    enabled: boolean
}

function mutable(source: string | undefined): boolean {
    return source === 'user' || source === 'project'
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
    return join(homedir(), '.claude.json')
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

function toolsFromNames(serverName: string, tools: readonly string[] | undefined): Array<{ name: string; description?: string }> {
    const prefix = `mcp__${serverName}__`
    const names = (tools ?? []).flatMap((tool) => {
        if (!tool.startsWith(prefix)) return []
        const name = tool.slice(prefix.length)
        return name && name.length <= 200 ? [name] : []
    })
    return [...new Set(names)].slice(0, 200).map((name) => ({ name }))
}

function toolsFromRpc(payload: unknown): Array<{ name: string; description?: string }> {
    const result = asRecord(asRecord(payload).result)
    const tools = Array.isArray(result.tools) ? result.tools : []
    const items: Array<{ name: string; description?: string }> = []
    for (const tool of tools) {
        const record = asRecord(tool)
        if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 200) continue
        const description = typeof record.description === 'string'
            ? redactConfigSecrets(record.description).replace(/\s+/g, ' ').trim().slice(0, 500)
            : ''
        items.push({
            name: record.name,
            ...(description ? { description } : {}),
        })
        if (items.length >= 200) break
    }
    return items
}

function frame(message: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(message))
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}
async function requestMcpTools(entry: { command?: string; args?: string[]; url?: string }): Promise<unknown> {
    if (entry.url) {
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hapi', version: '1' } } }
        const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
        await fetch(entry.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init), signal: AbortSignal.timeout(5000) })
        const response = await fetch(entry.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list), signal: AbortSignal.timeout(5000) })
        return await response.json() as unknown
    }
    if (!entry.command) throw new Error('no transport')
    const command = entry.command
    const args = entry.args ?? []
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
        child.kill()
        reject(new Error('timeout'))
    }, 5000)
    let buffer = Buffer.alloc(0)
    const finish = (value: unknown) => {
        clearTimeout(timer)
        child.kill()
        resolve(value)
    }
    child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
    })
    child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString('utf8')
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) return
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + length) return
        try {
            const message: unknown = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString('utf8'))
            if (asRecord(message).id === 2) finish(message)
        } catch {
            reject(new Error('bad response'))
        }
    })
    child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hapi', version: '1' } } }))
    child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    return await promise
}

async function mcpTools(entry: { command?: string; args?: string[]; url?: string } | null, reported: Array<{ name: string }>): Promise<{ tools: Array<{ name: string; description?: string }>; toolsUnavailable?: boolean }> {
    if (!entry?.command && !entry?.url) {
        return reported.length > 0 ? { tools: reported } : { tools: [], toolsUnavailable: true }
    }
    try {
        const tools = toolsFromRpc(await requestMcpTools(entry))
        return tools.length > 0 ? { tools } : { tools: reported, ...(reported.length === 0 ? { toolsUnavailable: true } : {}) }
    } catch {
        return reported.length > 0 ? { tools: reported } : { tools: [], toolsUnavailable: true }
    }
}

function scriptText(command: string): { script: string; truncated: boolean } {
    const tokens = command.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
    const file = [...tokens].reverse().find((token) => (isAbsolute(token) || token.includes('/')) && existsSync(token) && statSync(token).isFile())
    const raw = file ? readFileSync(file, 'utf8') : command
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

function editClaudeHooks(text: string, event: string, matcher: string | undefined, commandName: string | undefined, disabled: boolean): string {
    const done = new Set<string>()
    let next = text
    for (let guard = 0; guard < 100; guard++) {
        const hit = claudeHookObjects(next, event, matcher, commandName)
            .find((object) => !done.has(object.path.map(String).join('\0')))
        if (!hit) {
            if (done.size === 0) throw new Error(NOT_FOUND)
            return next
        }
        done.add(hit.path.map(String).join('\0'))
        const updated = setJsonBoolean(next.slice(hit.start, hit.end), [], 'disabled', disabled)
        next = `${next.slice(0, hit.start)}${updated}${next.slice(hit.end)}`
    }
    throw new Error(NOT_FOUND)
}

export async function readSessionConfigDetail(input: Omit<DetailInput, 'enabled'>): Promise<SessionConfigDetail | { error: string }> {
    const selector = input.selector
    const flavor = (input.flavor ?? '').trim().toLowerCase()
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
            mutable: mutable(source),
            markdown: skill.markdown,
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
        const reported = toolsFromNames(selector.name, input.tools)
        const listed = await mcpTools(located, reported)
        return {
            kind: 'mcp',
            name: selector.name,
            source: selector.source,
            enabled: located?.enabled ?? true,
            mutable: mutable(selector.source),
            ...listed,
        }
    }
    if (!selector.event || !selector.source) return { error: NOT_FOUND }
    const hook = locateHook(flavor, selector.event, selector.matcher, selector.commandName)
    const script = scriptText(hook?.command ?? selector.commandName ?? '')
    return {
        kind: 'hook',
        event: selector.event,
        ...(selector.matcher ? { matcher: selector.matcher } : {}),
        ...(selector.commandName ? { commandName: selector.commandName } : {}),
        source: selector.source,
        enabled: hook?.enabled ?? true,
        mutable: mutable(selector.source),
        ...script,
    }
}

export async function writeSessionConfigEnabled(input: DetailInput): Promise<{ enabled: boolean } | { error: string }> {
    if (!mutable(input.selector.source)) return { error: LOCKED }
    try {
        if (input.selector.kind === 'skill') {
            if (!input.selector.name) return { error: NOT_FOUND }
            const skill = await findSkill(input.selector.name, input.cwd, { flavor: (input.flavor ?? '').trim().toLowerCase() || undefined })
            if (!skill || skill.source !== input.selector.source) return { error: NOT_FOUND }
            if (skill.truncated) return { error: 'Skill is too large to update' }
            const text = readText(skill.filePath)
            if (text === null) return { error: NOT_FOUND }
            writeTextAtomic(skill.filePath, setFrontmatterBoolean(text, 'disabled', !input.enabled))
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
                : setJsonBoolean(text, ['mcpServers', input.selector.name], 'disabled', !input.enabled)
            writeTextAtomic(target.file, next)
            return { enabled: input.enabled }
        }
        if (!input.selector.event) return { error: NOT_FOUND }
        const target = hookEditTarget((input.flavor ?? '').trim().toLowerCase(), input.selector.event, input.selector.matcher, input.selector.commandName)
        if (!target) return { error: NOT_FOUND }
        const text = readText(target.file)
        if (text === null) return { error: NOT_FOUND }
        const next = target.format === 'toml'
            ? setTomlBoolean(text, target.header, 'enabled', input.enabled, (section) => {
                const command = /command\s*=\s*"([^"]*)"/.exec(section)?.[1]
                return Boolean(command && (!input.selector.commandName || commandBasename(command) === input.selector.commandName))
            })
            : editClaudeHooks(text, input.selector.event, input.selector.matcher, input.selector.commandName, !input.enabled)
        writeTextAtomic(target.file, next)
        return { enabled: input.enabled }
    } catch {
        return { error: NOT_FOUND }
    }
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
    const file = flavor === 'cursor'
        ? cursorMcpPath()
        : source === 'project'
            ? projectMcpFiles(cwd).find((path) => {
                const text = readText(path)
                return Boolean(text && jsonServer(text, name))
            })
            : claudeJsonPath()
    if (!file) return null
    const text = readText(file)
    if (!text) return null
    const server = jsonServer(text, name)
    if (!server) return null
    if (flavor === 'cursor' && sessionId && name === `hapi-${sessionId}`) return { ...server, enabled: true }
    return server
}

function mcpEditTarget(cwd: string, flavor: string, name: string, source: string): { file: string; format: 'json' | 'toml'; header: string } | null {
    if (flavor === 'codex') return { file: codexConfigPath(), format: 'toml', header: `mcp_servers.${name}` }
    if (flavor === 'cursor') return { file: cursorMcpPath(), format: 'json', header: '' }
    if (source === 'project') {
        const file = projectMcpFiles(cwd).find((path) => {
            const text = readText(path)
            return Boolean(text && jsonServer(text, name))
        })
        return file ? { file, format: 'json', header: '' } : null
    }
    return { file: claudeJsonPath(), format: 'json', header: '' }
}

function codexSection(text: string, header: string): string | null {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === `[${header}]` || line.trim() === `[[${header}]]`)
    if (start === -1) return null
    let end = start + 1
    while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[end])) end++
    return lines.slice(start, end).join('\n')
}

function locateHook(flavor: string, event: string, matcher: string | undefined, commandName: string | undefined): { command: string; enabled: boolean } | null {
    if (flavor === 'codex') {
        const text = readText(codexConfigPath()) ?? ''
        const sections = text.split(/\n(?=\[\[)/)
        const section = sections.find((part) => part.includes(`[[hooks.${event}]]`) && (!commandName || commandBasename(/command\s*=\s*"([^"]*)"/.exec(part)?.[1] ?? '') === commandName))
        if (!section) return null
        return {
            command: /command\s*=\s*"([^"]*)"/.exec(section)?.[1] ?? '',
            enabled: !/^enabled\s*=\s*false\b/m.test(section),
        }
    }
    const text = readText(claudeSettingsPath())
    if (!text) return null
    const hit = claudeHookObjects(text, event, matcher, commandName)[0]
    if (!hit) return null
    const objectText = text.slice(hit.start, hit.end)
    return {
        command: jsonStringField(objectText, 'command') ?? '',
        enabled: !/"disabled"\s*:\s*true/.test(objectText),
    }
}

function hookEditTarget(flavor: string, event: string, _matcher: string | undefined, _commandName: string | undefined): { file: string; format: 'json' | 'toml'; header: string } | null {
    if (flavor === 'codex') return { file: codexConfigPath(), format: 'toml', header: `hooks.${event}` }
    return { file: claudeSettingsPath(), format: 'json', header: '' }
}
