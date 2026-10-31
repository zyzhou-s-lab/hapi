import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Whether one configured MCP server is actually up.
 *
 * Copied from Magpie 0.1.2396 (`github.com/yetone/magpie` tag v0.1.2396,
 * `internal/library/mcp_check.go`). The Library page's own comment: the only
 * way to know is to connect the way an agent would. A command is started,
 * asked to initialize and to list its tools, then stopped. A URL is asked
 * the same over HTTP. `ok` means it answered. A sign-in refusal, an HTTP
 * error, a dead process, or a step that never answers is not loaded.
 *
 * Not copied: WSL distros, and Magpie refreshing its own OAuth token. A 401
 * or 403 is simply not loaded.
 */

const MCP_PROTOCOL = '2025-06-18'
const STDIO_STEP_MS = 30_000
const REMOTE_STEP_MS = 60_000
const CHECK_AT_ONCE = 4
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}'

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
        clientInfo: { name: 'magpie', version: '0.1.2396' },
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

async function checkStdio(target: McpProbeTarget): Promise<boolean> {
    if (!target.command) return false
    const child = spawn(target.command, target.args ?? [], {
        cwd: target.cwd,
        env: { ...process.env, ...target.env },
        stdio: ['pipe', 'pipe', 'pipe'],
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
    const exit = new Promise<void>((resolve) => {
        child.once('exit', () => {
            exited = true
            wake()
            resolve()
        })
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
        child.stdin.write(`${body}\n`)
    }
    try {
        send(initializeReq())
        const init = await waitFor(1, STDIO_STEP_MS)
        if (!init || init.error) return false
        send(INITIALIZED)
        send(request(2, 'tools/list'))
        const tools = await waitFor(2, STDIO_STEP_MS)
        return Boolean(tools && toolsOk(tools))
    } catch {
        return false
    } finally {
        reader.close()
        child.kill()
        await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))])
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

async function checkHttp(target: McpProbeTarget): Promise<boolean> {
    if (!target.url) return false
    const headers = target.headers ?? {}
    let session = ''
    try {
        const init = await postJson(target.url, initializeReq(), headers, session, REMOTE_STEP_MS)
        if (init.status === 401 || init.status === 403 || init.status < 200 || init.status >= 300) return false
        session = init.headers.get('Mcp-Session-Id') ?? ''
        const initMsg = await readRpc(init, 1)
        if (!initMsg || initMsg.error) return false
        await postJson(target.url, INITIALIZED, headers, session, REMOTE_STEP_MS).catch(() => undefined)
        const listed = await postJson(target.url, request(2, 'tools/list'), headers, session, REMOTE_STEP_MS)
        if (listed.status === 401 || listed.status === 403 || listed.status < 200 || listed.status >= 300) return false
        const tools = await readRpc(listed, 2)
        return Boolean(tools && toolsOk(tools))
    } catch {
        return false
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
    if (target.transport === 'stdio') return checkStdio(target)
    return checkHttp(target)
}

/** At most four at a time, same as Magpie's checkAtOnce. */
export async function checkMcpServers(targets: readonly McpProbeTarget[]): Promise<Map<string, boolean>> {
    const loaded = new Map<string, boolean>()
    let cursor = 0
    async function worker(): Promise<void> {
        for (;;) {
            const index = cursor
            cursor += 1
            const target = targets[index]
            if (!target) return
            loaded.set(target.name, await checkMcpServer(target))
        }
    }
    await Promise.all(Array.from({ length: Math.min(CHECK_AT_ONCE, targets.length) }, () => worker()))
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
