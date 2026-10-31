import { execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { checkMcpServer, checkMcpServers, clearProbeCache } from './mcpServerCheck'

const HAPI_VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version

type Seen = { method?: string; body: unknown; session: string | null }

async function withServer(
    respond: (body: string, res: ServerResponse) => void,
    run: (url: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
    const seen: Seen[] = []
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = body
        try {
            parsed = JSON.parse(body) as unknown
        } catch {
            parsed = body
        }
        const session = req.headers['mcp-session-id']
        seen.push({ method: req.method, body: parsed, session: typeof session === 'string' ? session : null })
        respond(body, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    try {
        await run(`http://127.0.0.1:${address.port}/mcp`, seen)
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

function message(body: string): { id?: number; method?: string } {
    return JSON.parse(body) as { id?: number; method?: string }
}

describe('mcp server probe', () => {
    it('returns false when the command does not exist and does not crash', async () => {
        const crashes: unknown[] = []
        const onCrash = (error: unknown) => { crashes.push(error) }
        process.on('uncaughtException', onCrash)
        try {
            const missing = await checkMcpServer({
                name: 'missing',
                transport: 'stdio',
                command: '/nonexistent/hapi-mcp-bin',
            })
            const badCwd = await checkMcpServer({
                name: 'bad-cwd',
                transport: 'stdio',
                command: '/bin/true',
                cwd: '/nonexistent/hapi-mcp-cwd',
            })
            expect(missing).toBe(false)
            expect(badCwd).toBe(false)
            expect(crashes).toEqual([])
        } finally {
            process.off('uncaughtException', onCrash)
        }
    })

    it('stops a stdio server that never answers within the probe budget', async () => {
        // Wall clock on purpose: the budget uses Date.now around a real child, and the assertion is that it returns in under 12s instead of 30s.
        const started = Date.now()
        const ok = await checkMcpServer({ name: 'sleep', transport: 'stdio', command: '/bin/sleep', args: ['30'] })
        expect(ok).toBe(false)
        expect(Date.now() - started).toBeLessThan(12_000)
    }, 15_000)

    it('accepts an HTTP server that answers initialize and tools/list as hapi', async () => {
        await withServer((body, res) => {
            const msg = message(body)
            if (msg.method === 'initialize') {
                res.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-1' })
                res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }))
                return
            }
            if (msg.method === 'notifications/initialized') {
                res.writeHead(202)
                res.end()
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping' }] } }))
        }, async (url, seen) => {
            const ok = await checkMcpServer({ name: 'remote', transport: 'http', url })
            expect(ok).toBe(true)
            const init = seen.find((entry) => (
                entry.body && typeof entry.body === 'object' && 'method' in entry.body && entry.body.method === 'initialize'
            ))
            expect(init?.body).toMatchObject({
                params: { clientInfo: { name: 'hapi', version: HAPI_VERSION } },
            })
            expect(init?.body).not.toMatchObject({ params: { clientInfo: { name: 'magpie' } } })
            const listed = seen.find((entry) => (
                entry.body && typeof entry.body === 'object' && 'method' in entry.body && entry.body.method === 'tools/list'
            ))
            expect(listed?.session).toBe('sess-1')
        })
    })

    it('reads a tools list delivered as an SSE event', async () => {
        await withServer((body, res) => {
            const msg = message(body)
            const result = msg.method === 'tools/list'
                ? { tools: [{ name: 'ping' }] }
                : { protocolVersion: '2025-06-18', capabilities: {} }
            if (msg.method === 'notifications/initialized') {
                res.writeHead(202)
                res.end()
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'Mcp-Session-Id': 'sess-sse' })
            res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)
        }, async (url) => {
            expect(await checkMcpServer({ name: 'sse', transport: 'sse', url })).toBe(true)
        })
    })

    it('treats an HTTP 401 as not loaded', async () => {
        await withServer((_body, res) => {
            res.writeHead(401)
            res.end('no')
        }, async (url) => {
            expect(await checkMcpServer({ name: 'locked', transport: 'http', url })).toBe(false)
        })
    })

    it('asks a silent server again instead of reusing a timeout', async () => {
        clearProbeCache()
        // Wall clock: each unanswered stdio probe uses the real 8s budget, so two calls must not collapse into one.
        const started = Date.now()
        const target = { name: 'slow', transport: 'stdio' as const, command: '/bin/sleep', args: ['30'] }
        expect((await checkMcpServers([target])).get('slow')).toBe(false)
        expect((await checkMcpServers([target])).get('slow')).toBe(false)
        const elapsed = Date.now() - started
        expect(elapsed).toBeGreaterThan(12_000)
        expect(elapsed).toBeLessThan(24_000)
    }, 30_000)

    it.skipIf(process.platform === 'win32')('leaves no process after a shell that ignores SIGTERM', async () => {
        const token = `hapi-probe-leak-${process.pid}-${Date.now()}`
        const pids = () => {
            let out = ''
            try {
                out = execFileSync('ps', ['-axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
            } catch {
                return [] as number[]
            }
            return out.split('\n').flatMap((line) => {
                if (!line.includes(token)) return []
                const pid = Number(line.trim().split(/\s+/)[0])
                return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? [pid] : []
            })
        }
        try {
            // Wall clock: the shell never answers, and both it and sleep must be gone when the probe returns.
            const ok = await checkMcpServer({
                name: 'trap',
                transport: 'stdio',
                command: 'sh',
                args: ['-c', 'trap "" TERM; sleep 100'],
                env: { HAPI_PROBE_LEAK: token },
            })
            expect(ok).toBe(false)
            expect(pids()).toEqual([])
        } finally {
            for (const pid of pids()) {
                try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
            }
        }
    }, 20_000)

})
