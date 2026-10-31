import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

/**
 * Whether one configured MCP server is actually up.
 *
 * Copied from Magpie 0.1.2396 (`github.com/yetone/magpie` tag v0.1.2396,
 * `internal/library/mcp_check.go`). Magpie is MIT licensed:
 * Copyright (c) 2026 yetone. Permission is hereby granted, free of charge, to
 * any person obtaining a copy of this software to deal in it without
 * restriction, including the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies, provided the copyright notice
 * and this permission notice appear in all copies or substantial portions.
 * https://github.com/yetone/magpie/blob/v0.1.2396/LICENSE
 *
 * The Library page's own comment: the only way to know is to connect the way
 * an agent would. A command is started, asked to initialize and to list its
 * tools, then stopped. A URL is asked the same over HTTP. `ok` means it
 * answered. A sign-in refusal, an HTTP error, a dead process, or a step that
 * never answers is not loaded.
 *
 * Not copied: WSL distros, and Magpie refreshing its own OAuth token. A 401
 * or 403 is simply not loaded.
 */

const MCP_PROTOCOL = '2025-06-18'
/** One server, initialize plus tools/list. A silent process must not hold the config page. */
const PROBE_BUDGET_MS = 8_000
const CHECK_AT_ONCE = 4
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
const require = createRequire(import.meta.url)
const HAPI_VERSION = (() => {
    try {
        const version = (require('../../../package.json') as { version?: unknown }).version
        return typeof version === 'string' && version ? version : '0.0.0'
    } catch {
        return '0.0.0'
    }
})()

export type McpProbeTarget = {
    name: string
    transport: 'stdio' | 'http' | 'sse'
    command?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
}

type RpcMsg = {
    id?: number | string
    result?: unknown
    error?: { code?: number; message?: string }
}

function request(id: number, method: string, params?: unknown): string {
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return JSON.stringify(message)
}

function initializeReq(): string {
    return request(1, 'initialize', {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'hapi', version: HAPI_VERSION },
    })
}

function sameId(message: RpcMsg, id: number): boolean {
    return String(message.id).trim() === String(id)
}

function rpcMsg(value: unknown): RpcMsg | undefined {
    if (!value || typeof value !== 'object') return undefined
    const message: RpcMsg = {}
    if ('id' in value && (typeof value.id === 'number' || typeof value.id === 'string')) message.id = value.id
    if ('result' in value) message.result = value.result
    if ('error' in value && value.error && typeof value.error === 'object') {
        const error: NonNullable<RpcMsg['error']> = {}
        if ('code' in value.error && typeof value.error.code === 'number') error.code = value.error.code
        if ('message' in value.error && typeof value.error.message === 'string') error.message = value.error.message
        message.error = error
    }
    return message
}

function toolsOk(message: RpcMsg): boolean {
    if (message.error) return message.error.code === -32601
    const result = message.result
    if (!result || typeof result !== 'object') return false
    if (!('tools' in result)) return true
    return Array.isArray(result.tools)
}

type ProbeHit = { ok: boolean; timedOut: boolean }

function down(timedOut = false): ProbeHit {
    return { ok: false, timedOut }
}

const PROBE_TTL_MS = 10 * 60 * 1000
const PROBE_CACHE_MAX = 200

type CachedProbe = { ok: boolean; at: number }
type Flight = { gen: number; fresh: boolean; promise: Promise<ProbeHit> }

const probeCache = new Map<string, CachedProbe>()
const flights = new Map<string, Flight>()
const writtenGen = new Map<string, number>()
let nextGen = 0

function sortedPairs(record: Record<string, string> | undefined): Array<[string, string]> {
    if (!record) return []
    return Object.keys(record).sort().map((key) => [key, record[key] ?? ''])
}

/** Identity of a server's config. The name is not part of it. */
export function probeConfigKey(target: McpProbeTarget): string {
    return JSON.stringify({
        transport: target.transport,
        command: target.command ?? null,
        args: target.args ?? [],
        cwd: target.cwd ?? null,
        env: sortedPairs(target.env),
        url: target.url ?? null,
        headers: sortedPairs(target.headers),
    })
}

function readCache(key: string): boolean | undefined {
    const row = probeCache.get(key)
    if (!row) return undefined
    if (Date.now() - row.at > PROBE_TTL_MS) {
        probeCache.delete(key)
        writtenGen.delete(key)
        return undefined
    }
    return row.ok
}

function trimGenerations(): void {
    for (const key of writtenGen.keys()) {
        if (writtenGen.size <= PROBE_CACHE_MAX) return
        if (!probeCache.has(key)) writtenGen.delete(key)
    }
    while (writtenGen.size > PROBE_CACHE_MAX) {
        const oldest = writtenGen.keys().next().value
        if (oldest === undefined) break
        writtenGen.delete(oldest)
    }
}

function remember(key: string, gen: number, result: ProbeHit): void {
    if (gen < (writtenGen.get(key) ?? 0)) return
    writtenGen.delete(key)
    writtenGen.set(key, gen)
    probeCache.delete(key)
    if (!result.timedOut) probeCache.set(key, { ok: result.ok, at: Date.now() })
    while (probeCache.size > PROBE_CACHE_MAX) {
        const oldest = probeCache.keys().next().value
        if (oldest === undefined) break
        probeCache.delete(oldest)
        writtenGen.delete(oldest)
    }
    trimGenerations()
}

export function cachedProbe(target: McpProbeTarget): boolean | undefined {
    return readCache(probeConfigKey(target))
}

export function probeCacheSize(): number {
    return probeCache.size
}

export function probeGenerationSize(): number {
    return writtenGen.size
}

export function clearProbeCache(): void {
    probeCache.clear()
    flights.clear()
    writtenGen.clear()
}

function runProbe(target: McpProbeTarget): Promise<ProbeHit> {
    return target.transport === 'stdio' ? checkStdio(target) : checkHttp(target)
}

function startFlight(target: McpProbeTarget, key: string, fresh: boolean): Promise<ProbeHit> {
    const gen = ++nextGen
    let settle: (result: ProbeHit) => void = () => undefined
    const promise = new Promise<ProbeHit>((resolve) => {
        settle = resolve
    })
    flights.set(key, { gen, fresh, promise })
    void runProbe(target).then((result) => {
        if (flights.get(key)?.gen === gen) flights.delete(key)
        remember(key, gen, result)
        settle(result)
    }, () => {
        if (flights.get(key)?.gen === gen) flights.delete(key)
        const result = down()
        remember(key, gen, result)
        settle(result)
    })
    return promise
}

function probeShared(target: McpProbeTarget, fresh: boolean): Promise<ProbeHit> {
    const key = probeConfigKey(target)
    if (!fresh) {
        const hit = readCache(key)
        if (hit !== undefined) return Promise.resolve({ ok: hit, timedOut: false })
        const flight = flights.get(key)
        if (flight) return flight.promise
        return startFlight(target, key, false)
    }
    const flight = flights.get(key)
    if (flight?.fresh) return flight.promise
    return startFlight(target, key, true)
}

async function checkStdio(target: McpProbeTarget): Promise<ProbeHit> {
    if (!target.command) return down()
    // cwd is already absolute: the session directory, or the config path
    // resolved against it. Magpie pins HOME because its own cwd is often
    // unusable; omp starts the server in the session directory.
    const group = process.platform !== 'win32'
    const child = spawn(target.command, target.args ?? [], {
        cwd: target.cwd,
        env: { ...process.env, ...target.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: group,
    })
    const lines: RpcMsg[] = []
    let pending: (() => void) | undefined
    const wake = () => {
        const resolve = pending
        pending = undefined
        resolve?.()
    }
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
        try {
            const message = rpcMsg(JSON.parse(line))
            if (message) lines.push(message)
        } catch {
            // a line that isn't JSON-RPC is the server logging on the wrong stream
        }
        wake()
    })
    let exited = false
    let processGone = false
    const exit = new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            processGone = true
            exited = true
            wake()
            resolve()
        }
        // Spawn failures (ENOENT, EACCES, a bad cwd) emit 'error' and may never emit 'exit'.
        child.once('error', finish)
        child.once('exit', finish)
    })
    child.stdin.on('error', () => {
        exited = true
        wake()
    })
    const waitFor = async (id: number, budgetMs: number): Promise<RpcMsg | undefined> => {
        const deadline = Date.now() + budgetMs
        while (Date.now() < deadline) {
            if (child.exitCode !== null) exited = true
            const found = lines.findIndex((message) => sameId(message, id))
            if (found >= 0) return lines.splice(found, 1)[0]
            if (exited && lines.length === 0) return undefined
            const left = deadline - Date.now()
            if (left <= 0) return undefined
            await new Promise<void>((resolve) => {
                pending = resolve
                setTimeout(resolve, Math.min(left, 50))
            })
        }
        return undefined
    }
    const send = (body: string) => {
        if (exited || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) return
        child.stdin.write(`${body}\n`)
    }
    const started = Date.now()
    const remaining = () => Math.max(0, PROBE_BUDGET_MS - (Date.now() - started))
    try {
        send(initializeReq())
        const init = await waitFor(1, remaining())
        if (!init || init.error) return down(!init && !processGone && child.exitCode === null)
        send(INITIALIZED)
        send(request(2, 'tools/list'))
        const tools = await waitFor(2, remaining())
        if (!tools || !toolsOk(tools)) return down(!tools && !processGone && child.exitCode === null)
        return { ok: true, timedOut: false }
    } catch {
        return down()
    } finally {
        reader.close()
        if (!exited && child.exitCode === null && child.stdin.writable) child.stdin.end()
        const waitExit = (ms: number) => Promise.race([
            exit.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
        ])
        const signal = (name: NodeJS.Signals) => {
            if (processGone || !child.pid || child.pid <= 0) return
            try {
                if (group) process.kill(-child.pid, name)
                else child.kill(name)
            } catch {
                // already gone
            }
        }
        // Windows stays on one SIGTERM. Elsewhere the child is its own group, so a
        // wrapper that ignores SIGTERM cannot leave grandchildren behind.
        if (!await waitExit(1_000)) signal('SIGTERM')
        if (!group) {
            await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))])
        } else if (!await waitExit(1_000)) {
            signal('SIGKILL')
            await waitExit(1_000)
        }
    }
}

async function postJson(url: string, body: string, headers: Record<string, string>, session: string, budgetMs: number): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': MCP_PROTOCOL } : {}),
        },
        body,
        signal: AbortSignal.timeout(budgetMs),
    })
}

async function readRpc(response: Response, id: number): Promise<RpcMsg | undefined> {
    const type = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (type.includes('text/event-stream')) {
        for (const chunk of text.split('\n\n')) {
            const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
            if (!data) continue
            try {
                const message = JSON.parse(data) as RpcMsg
                if (sameId(message, id)) return message
            } catch {
                // keep reading the stream
            }
        }
        return undefined
    }
    try {
        return rpcMsg(JSON.parse(text))
    } catch {
        return undefined
    }
}

async function checkHttp(target: McpProbeTarget): Promise<ProbeHit> {
    if (!target.url) return down()
    const headers = target.headers ?? {}
    let session = ''
    const started = Date.now()
    const remaining = () => Math.max(0, PROBE_BUDGET_MS - (Date.now() - started))
    try {
        const initBudget = remaining()
        if (initBudget <= 0) return down(true)
        const init = await postJson(target.url, initializeReq(), headers, session, initBudget)
        if (init.status === 401 || init.status === 403 || init.status < 200 || init.status >= 300) return down()
        session = init.headers.get('Mcp-Session-Id') ?? ''
        const initMsg = await readRpc(init, 1)
        if (!initMsg || initMsg.error) return down()
        const noteBudget = remaining()
        if (noteBudget > 0) {
            await postJson(target.url, INITIALIZED, headers, session, noteBudget).catch(() => undefined)
        }
        const listBudget = remaining()
        if (listBudget <= 0) return down(true)
        const listed = await postJson(target.url, request(2, 'tools/list'), headers, session, listBudget)
        if (listed.status === 401 || listed.status === 403 || listed.status < 200 || listed.status >= 300) return down()
        const tools = await readRpc(listed, 2)
        if (!tools || !toolsOk(tools)) return down()
        return { ok: true, timedOut: false }
    } catch (error) {
        const name = error instanceof Error ? error.name : ''
        return down(name === 'TimeoutError' || name === 'AbortError')
    } finally {
        if (session) {
            fetch(target.url, {
                method: 'DELETE',
                headers: { ...headers, 'Mcp-Session-Id': session },
                signal: AbortSignal.timeout(3_000),
            }).catch(() => undefined)
        }
    }
}

/** One server. `true` only when initialize and tools/list both come back. */
export async function checkMcpServer(target: McpProbeTarget): Promise<boolean> {
    const result = target.transport === 'stdio' ? await checkStdio(target) : await checkHttp(target)
    return result.ok
}

/** At most four at a time. A stored result is reused until the config changes; a timeout is not stored. */
export async function checkMcpServers(targets: readonly McpProbeTarget[], options?: { fresh?: boolean }): Promise<Map<string, boolean>> {
    const loaded = new Map<string, boolean>()
    const pending: McpProbeTarget[] = []
    for (const target of targets) {
        if (!options?.fresh) {
            const hit = cachedProbe(target)
            if (hit !== undefined) {
                loaded.set(target.name, hit)
                continue
            }
        }
        pending.push(target)
    }
    let cursor = 0
    async function worker(): Promise<void> {
        for (;;) {
            const index = cursor
            cursor += 1
            const target = pending[index]
            if (!target) return
            const result = await probeShared(target, options?.fresh === true)
            loaded.set(target.name, result.ok)
        }
    }
    await Promise.all(Array.from({ length: Math.min(CHECK_AT_ONCE, pending.length) }, () => worker()))
    return loaded
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') record[key] = item
    }
    return record
}

/** Configured servers worth connecting to. Disabled entries are left out. Commands, URLs, and headers stay here and are not returned to the page. */
export function probeTargetsFromConfig(value: unknown): McpProbeTarget[] {
    if (!value || typeof value !== 'object' || !('mcpServers' in value)) return []
    const servers = value.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
    const targets: McpProbeTarget[] = []
    for (const [name, raw] of Object.entries(servers)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        if ('disabled' in raw && raw.disabled === true) continue
        const command = 'command' in raw && typeof raw.command === 'string' ? raw.command : undefined
        const url = 'url' in raw && typeof raw.url === 'string' ? raw.url : undefined
        if (!command && !url) continue
        const kind = 'type' in raw && typeof raw.type === 'string' ? raw.type : 'transport' in raw && typeof raw.transport === 'string' ? raw.transport : ''
        const transport = url ? (kind === 'sse' ? 'sse' : 'http') : 'stdio'
        const args = 'args' in raw ? stringList(raw.args) : []
        const cwd = 'cwd' in raw && typeof raw.cwd === 'string' ? raw.cwd : undefined
        targets.push({
            name,
            transport,
            ...(command ? { command } : {}),
            ...(args.length > 0 ? { args } : {}),
            ...(cwd ? { cwd } : {}),
            ...('env' in raw && stringRecord(raw.env) ? { env: stringRecord(raw.env) } : {}),
            ...(url ? { url } : {}),
            ...('headers' in raw && stringRecord(raw.headers) ? { headers: stringRecord(raw.headers) } : {}),
        })
    }
    return targets
}
