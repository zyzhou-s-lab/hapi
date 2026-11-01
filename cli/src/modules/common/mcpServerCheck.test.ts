import { execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { cachedProbe, checkMcpServer, checkMcpServers, clearProbeCache, probeCacheSize, probeGenerationSize } from './mcpServerCheck'

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

    it('shares one spawn across concurrent probes of the same config', async () => {
        clearProbeCache()
        const dir = mkdtempSync(join(tmpdir(), 'hapi-probe-share-'))
        const log = join(dir, 'starts.txt')
        const script = join(dir, 'once.cjs')
        writeFileSync(script, `
            const fs = require('node:fs')
            const readline = require('node:readline')
            fs.appendFileSync(${JSON.stringify(log)}, 'x')
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                const result = msg.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} }
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
            })
        `)
        const target = { name: 'once', transport: 'stdio' as const, command: process.execPath, args: [script], cwd: dir }
        try {
            await Promise.all([checkMcpServers([target]), checkMcpServers([target])])
            expect(readFileSync(log, 'utf8')).toBe('x')
        } finally {
            rmSync(dir, { recursive: true, force: true })
            clearProbeCache()
        }
    })

    it('keeps a fresh result when an older probe finishes later', async () => {
        clearProbeCache()
        const dir = mkdtempSync(join(tmpdir(), 'hapi-probe-fresh-'))
        const mode = join(dir, 'mode.txt')
        const log = join(dir, 'starts.txt')
        writeFileSync(mode, 'slow')
        const script = join(dir, 'race.cjs')
        writeFileSync(script, `
            const fs = require('node:fs')
            const readline = require('node:readline')
            const kind = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim()
            fs.appendFileSync(${JSON.stringify(log)}, kind + '\\n')
            if (kind === 'slow') {
                setTimeout(() => process.exit(1), 400)
                return
            }
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                const result = msg.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} }
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
            })
        `)
        const target = { name: 'race', transport: 'stdio' as const, command: process.execPath, args: [script], cwd: dir }
        const older = checkMcpServers([target])
        try {
            while (!existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 10))
            writeFileSync(mode, 'fast')
            const fresh = await checkMcpServers([target], { fresh: true })
            expect(fresh.get('race')).toBe(true)
            expect(readFileSync(log, 'utf8')).toContain('fast')
            await older
            expect(cachedProbe(target)).toBe(true)
        } finally {
            rmSync(dir, { recursive: true, force: true })
            clearProbeCache()
        }
    })

    it('drops a cached result after ten minutes', async () => {
        clearProbeCache()
        const target = { name: 'gone', transport: 'stdio' as const, command: '/nonexistent/hapi-ttl-bin' }
        await checkMcpServers([target])
        expect(cachedProbe(target)).toBe(false)
        const realNow = Date.now()
        vi.useFakeTimers()
        try {
            vi.setSystemTime(realNow + 11 * 60 * 1000)
            expect(cachedProbe(target)).toBeUndefined()
        } finally {
            vi.useRealTimers()
            clearProbeCache()
        }
    })

    it('keeps at most 200 cached configs', async () => {
        clearProbeCache()
        const targets = Array.from({ length: 205 }, (_, index) => ({
            name: `missing-${index}`,
            transport: 'stdio' as const,
            command: `/nonexistent/hapi-cap-${index}`,
        }))
        await checkMcpServers(targets)
        expect(probeCacheSize()).toBe(200)
        clearProbeCache()
    })

    it('drops a generation when its cached probe is evicted or expires', async () => {
        clearProbeCache()
        const targets = Array.from({ length: 205 }, (_, index) => ({
            name: `gen-${index}`,
            transport: 'stdio' as const,
            command: `/nonexistent/hapi-gen-${index}`,
        }))
        await checkMcpServers(targets)
        expect(probeCacheSize()).toBe(200)
        expect(probeGenerationSize()).toBe(200)
        const kept = { name: 'kept', transport: 'stdio' as const, command: '/nonexistent/hapi-gen-kept' }
        await checkMcpServers([kept])
        expect(probeGenerationSize()).toBe(200)
        const realNow = Date.now()
        vi.useFakeTimers()
        try {
            vi.setSystemTime(realNow + 11 * 60 * 1000)
            expect(cachedProbe(kept)).toBeUndefined()
            expect(probeGenerationSize()).toBe(199)
        } finally {
            vi.useRealTimers()
            clearProbeCache()
            expect(probeGenerationSize()).toBe(0)
        }
    })



})
