import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { describe, expect, it } from 'vitest'
import { clearProbeCache } from './mcpServerCheck'
import { registerFileHandlers } from './handlers/files'
import {
    commandBasename,
    cursorServersFromMcpJson,
    hooksFromClaudeSettings,
    inventorySkills,
    mcpServersFromClaudeJson,
    mcpServersFromConfig,
    ompInventoryFromTools,
    parseCodexConfigInventory,
    projectMcpPaths,
    ompProjectMcpPaths,
    readLiveSessionConfig,
    listSessionAgents,
    listedSessionConfigRealpaths,
} from './sessionInventory'

describe('session inventory collectors', () => {
    it('keeps Claude server names and drops commands, urls, and tokens', () => {
        const servers = mcpServersFromClaudeJson({
            mcpServers: {
                docs: { command: 'npx', args: ['--token', 'secret'], url: 'http://127.0.0.1:9/?token=abc' },
                'http://evil.example/mcp': { command: 'nope' },
            },
            projects: {
                '/work/app': { mcpServers: { local: { url: 'http://example.test' } } },
                '/other': { mcpServers: { foreign: { command: 'skip' } } },
            },
        }, '/work/app/src')

        expect(servers.map((server) => server.name).sort()).toEqual(['docs', 'local'])
        expect(JSON.stringify(servers)).not.toContain('token')
        expect(JSON.stringify(servers)).not.toContain('http')
    })

    it('reads project mcp.json names only', () => {
        expect(mcpServersFromConfig({
            mcpServers: { build: { command: 'node server.js', env: { API_KEY: 'sekret' } } },
        }, 'project')).toEqual([{ name: 'build', source: 'project' }])
    })

    it('reports hook event, matcher, and command basename without the command text', () => {
        const items = hooksFromClaudeSettings({
            hooks: {
                SessionStart: [{
                    matcher: '*',
                    hooks: [{
                        type: 'command',
                        command: 'node /opt/hapi/hook-forwarder --token super-secret',
                    }],
                }],
                PreToolUse: [{
                    matcher: 'Bash',
                    hooks: [{ type: 'command', command: '"/usr/local/bin/my-hook" --token abc' }],
                }],
            },
        })

        expect(items).toEqual([
            { event: 'SessionStart', matcher: '*', source: 'injected', commandName: 'hook-forwarder' },
            { event: 'PreToolUse', matcher: 'Bash', source: 'user', commandName: 'my-hook' },
        ])
        expect(commandBasename('node /opt/hapi/hook-forwarder --token super-secret')).toBe('hook-forwarder')
        expect(commandBasename('bash -lc "git status --short"')).toBe('git')
        expect(commandBasename('node /opt/tools/x.js --flag')).toBe('x.js')
        expect(commandBasename('npx --yes some-pkg')).toBe('some-pkg')
        expect(commandBasename('env TOKEN=abc /usr/local/bin/my-hook')).toBe('my-hook')
        expect(JSON.stringify(commandBasename('env TOKEN=abc my-hook'))).not.toContain('abc')
        expect(JSON.stringify(items)).not.toContain('super-secret')
        expect(JSON.stringify(items)).not.toContain('/usr/local')
    })

    it('parses Codex table names and ignores command values', () => {
        const parsed = parseCodexConfigInventory(`
# comment
[mcp_servers.docs]
command = "npx"
url = "http://example.test/?token=abc"

[mcp_servers.hapi.args]
value = "secret"

[[hooks.PreToolUse]]
command = "my-hook --token abc"
`)

        expect(parsed.servers.map((server) => server.name)).toEqual(['docs', 'hapi'])
        expect(parsed.hooks[0]).toMatchObject({ event: 'PreToolUse', source: 'user' })
        expect(parsed.hooks[0]?.line).toBeGreaterThan(0)
        expect(JSON.stringify(parsed)).not.toContain('http')
        expect(JSON.stringify(parsed)).not.toContain('abc')
    })

    it('turns omp mcp tool names into a tools list and reports no hooks', () => {
        expect(ompInventoryFromTools(['read', 'mcp__example_probe', 'mcp__hapi__display_image', 'mcp__'])).toEqual({
            mcp: { kind: 'tools', servers: [{ name: 'example_probe', source: 'tool' }, { name: 'hapi', source: 'tool' }] },
            hooks: { availability: 'none', items: [] },
        })
    })

    it('lists configured omp servers and marks which ones the session loaded', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-omp-mcp-'))
        const agent = mkdtempSync(join(tmpdir(), 'hapi-omp-agent-'))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agent
        mkdirSync(join(workspace, '.git'))
        writeFileSync(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: {
                notion: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer sekret' } },
                idle: { command: 'echo', args: ['hidden'] },
            },
        }, null, 2))
        writeFileSync(join(agent, 'settings.json'), JSON.stringify({
            mcpServers: { fromSettings: { command: 'true' } },
        }))
        writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
            mcpServers: { projectServer: { command: 'true' } },
        }))
        try {
            const config = await readLiveSessionConfig({
                flavor: 'omp',
                cwd: workspace,
                tools: ['read', 'mcp__notion__search', 'mcp__extra_probe'],
                promptLive: {
                    omp: {
                        systemPrompt: [
                            '## MCP Server Instructions\n### notion\nSearch pages.',
                            'Mounted route mcp__android_remote_control_mi10pro_android_tap.',
                            'Warning: MCP server "idle" failed to connect: timeout. Its tools are unavailable.',
                        ],
                    },
                },
            })
            const byName = Object.fromEntries((config.mcp?.servers ?? []).map((server) => [server.name, server]))
            expect(byName.notion).toMatchObject({ source: 'user', loaded: false })
            expect(byName.notion?.filePath).toContain('mcp.json')
            expect(byName.notion?.line).toBeGreaterThan(0)
            expect(byName.idle).toMatchObject({ source: 'user', loaded: false })
            expect(byName.fromSettings?.filePath).toContain('settings.json')
            expect(byName.fromSettings?.loaded).toBe(false)
            expect(byName.projectServer).toMatchObject({ source: 'project', filePath: '.mcp.json' })
            expect(byName.projectServer.loaded).toBeUndefined()
            expect(byName.extra_probe).toMatchObject({ source: 'tool', loaded: true })
            const encoded = JSON.stringify(config.mcp)
            expect(encoded).not.toContain('sekret')
            expect(encoded).not.toContain('127.0.0.1')
            expect(encoded).not.toContain('Bearer')
            expect(encoded).not.toContain('hidden')
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previous
            rmSync(workspace, { recursive: true, force: true })
            rmSync(agent, { recursive: true, force: true })
        }
    })

    it('loads an omp server only when its own handshake answers', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-omp-mcp-probe-'))
        const agent = mkdtempSync(join(tmpdir(), 'hapi-omp-agent-probe-'))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agent
        const answering = join(agent, 'answer.cjs')
        const dead = join(agent, 'dead.cjs')
        writeFileSync(answering, `
            const readline = require('node:readline')
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                if (msg.method === 'initialize') {
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n')
                } else if (msg.method === 'tools/list') {
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'p' }] } }) + '\\n')
                }
            })
        `)
        writeFileSync(dead, 'process.exit(1)\n')
        writeFileSync(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: {
                git: { command: 'true' },
                memory: { command: 'true' },
                time: { command: 'true' },
                android: { command: process.execPath, args: [dead] },
                android_remote_control: { command: process.execPath, args: [answering] },
                idle: { command: 'true' },
            },
        }))
        try {
            const config = await readLiveSessionConfig({
                flavor: 'omp',
                cwd: workspace,
                tools: ['read', 'mcp__extra_probe', 'mcp__android__tap'],
                promptLive: {
                    omp: {
                        systemPrompt: [
                            'You can use git and memory. Check the time.',
                            '## MCP Server Instructions\n### git\n### idle\n### android',
                            'mcp__android__tap and mcp__android_remote_control__tap',
                            'Warning: MCP server "idle" not ready after 30000ms; its tools are unavailable for this run.',
                            'Warning: MCP server "android_remote_control" failed to connect: disconnected; its tools are unavailable for this run.',
                            'MCP server "idle" failed to connect: v1.2 failed. Its tools are unavailable until the client restarts the session.',
                            "MCP server 'idle' failed",
                        ],
                    },
                },
            })
            const byName = Object.fromEntries((config.mcp?.servers ?? []).map((server) => [server.name, server.loaded]))
            expect(byName.git).toBe(false)
            expect(byName.memory).toBe(false)
            expect(byName.time).toBe(false)
            expect(byName.android).toBe(false)
            expect(byName.android_remote_control).toBe(true)
            expect(byName.idle).toBe(false)
            expect(byName.extra_probe).toBe(true)
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previous
            rmSync(workspace, { recursive: true, force: true })
            rmSync(agent, { recursive: true, force: true })
        }
    })

    it('redacts skill text and marks stamped cursor bridges as injected', () => {
        expect(inventorySkills([{
            name: 'review',
            description: 'Look at https://example.test token=abc',
            source: 'project',
        }]).items).toEqual([{
            name: 'review',
            description: 'Look at',
            source: 'project',
        }])

        expect(cursorServersFromMcpJson({
            mcpServers: {
                docs: { command: 'npx', url: 'http://example.test/?token=abc' },
                'hapi-session-1': { command: 'hapi', env: { HAPI_MCP_OVERLAY_PID: '10' } },
                'hapi-user': { command: 'user-owned' },
            },
        }, 'session-1')).toEqual([
            { name: 'docs', source: 'user' },
            { name: 'hapi-session-1', source: 'injected' },
            { name: 'hapi-user', source: 'user' },
        ])
    })

    it('stops looking for project mcp.json at home', () => {
        expect(projectMcpPaths('/home/dev/proj/app', '/home/dev')).toEqual([
            '/home/dev/proj/app/.mcp.json',
            '/home/dev/proj/.mcp.json',
        ])
    })

    it('walks native project mcp files from the cwd up to the git root', () => {
        expect(ompProjectMcpPaths('/home/dev/proj/app', '/home/dev')).toEqual([
            '/home/dev/proj/app/.omp/mcp.json',
            '/home/dev/proj/app/.omp/.mcp.json',
            '/home/dev/proj/.omp/mcp.json',
            '/home/dev/proj/.omp/.mcp.json',
        ])
    })

    it('checks user servers from cache and leaves a project server unstarted until asked', async () => {
        clearProbeCache()
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-omp-priority-'))
        const app = join(workspace, 'app')
        const agent = mkdtempSync(join(tmpdir(), 'hapi-omp-priority-agent-'))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agent
        mkdirSync(join(workspace, '.git'))
        mkdirSync(join(app, '.omp'), { recursive: true })
        mkdirSync(join(workspace, '.omp'), { recursive: true })
        const userHits = join(agent, 'user-hits.txt')
        const projectHits = join(agent, 'project-hits.txt')
        const script = (file: string, mark: string) => `
            const fs = require('node:fs')
            const readline = require('node:readline')
            fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(mark)})
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                const result = msg.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} }
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
            })
        `
        const userScript = join(agent, 'user.cjs')
        const projectScript = join(agent, 'project.cjs')
        writeFileSync(userScript, script(userHits, 'u'))
        writeFileSync(projectScript, script(projectHits, 'p'))
        writeFileSync(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: { userServer: { command: process.execPath, args: [userScript] } },
        }))
        writeFileSync(join(workspace, '.omp', 'mcp.json'), JSON.stringify({
            mcpServers: { shared: { command: 'true' }, parentOnly: { command: 'true' } },
        }))
        writeFileSync(join(app, '.omp', 'mcp.json'), JSON.stringify({
            mcpServers: { shared: { command: process.execPath, args: [projectScript] } },
        }))
        const read = (extra?: { fresh?: boolean; check?: string }) => readLiveSessionConfig({
            flavor: 'omp',
            cwd: app,
            tools: [],
            ...extra,
        })
        const named = async (extra?: { fresh?: boolean; check?: string }) => {
            const config = await read(extra)
            return Object.fromEntries((config.mcp?.servers ?? []).map((server) => [server.name, server]))
        }
        try {
            const first = await named()
            expect(first.userServer?.loaded).toBe(true)
            expect(first.shared).toMatchObject({ source: 'project', filePath: '.omp/mcp.json' })
            expect(first.shared?.loaded).toBeUndefined()
            expect(first.parentOnly?.source).toBe('project')
            expect(existsSync(projectHits)).toBe(false)
            expect(readFileSync(userHits, 'utf8')).toBe('u')
            await named()
            expect(readFileSync(userHits, 'utf8')).toBe('u')
            const checked = await named({ check: 'shared' })
            expect(checked.shared?.loaded).toBe(true)
            expect(readFileSync(projectHits, 'utf8')).toBe('p')
            const cached = await named()
            expect(cached.shared?.loaded).toBe(true)
            expect(readFileSync(projectHits, 'utf8')).toBe('p')
            const fresh = await named({ fresh: true })
            expect(readFileSync(userHits, 'utf8')).toBe('uu')
            expect(readFileSync(projectHits, 'utf8')).toBe('p')
            expect(fresh.shared?.loaded).toBeUndefined()
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previous
            rmSync(workspace, { recursive: true, force: true })
            rmSync(agent, { recursive: true, force: true })
            clearProbeCache()
        }
    })

    it('runs a server with no cwd in the session directory and does not share it across projects', async () => {
        clearProbeCache()
        const left = mkdtempSync(join(tmpdir(), 'hapi-cwd-a-'))
        const right = mkdtempSync(join(tmpdir(), 'hapi-cwd-b-'))
        const agent = mkdtempSync(join(tmpdir(), 'hapi-cwd-agent-'))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agent
        mkdirSync(join(left, '.git'))
        mkdirSync(join(right, '.git'))
        const log = join(agent, 'cwds.txt')
        const script = join(agent, 'cwd.cjs')
        writeFileSync(script, `
            const fs = require('node:fs')
            const readline = require('node:readline')
            fs.appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n')
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                const result = msg.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} }
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
            })
        `)
        writeFileSync(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: { local: { command: process.execPath, args: [script] } },
        }))
        try {
            await readLiveSessionConfig({ flavor: 'omp', cwd: left, tools: [] })
            await readLiveSessionConfig({ flavor: 'omp', cwd: right, tools: [] })
            const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => realpathSync(line))
            expect(lines).toEqual([realpathSync(left), realpathSync(right)])
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previous
            rmSync(left, { recursive: true, force: true })
            rmSync(right, { recursive: true, force: true })
            rmSync(agent, { recursive: true, force: true })
            clearProbeCache()
        }
    })

    it('shows and checks the user server when a root .mcp.json repeats its name', async () => {
        clearProbeCache()
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-user-wins-'))
        const agent = mkdtempSync(join(tmpdir(), 'hapi-user-wins-agent-'))
        const previous = process.env.PI_CODING_AGENT_DIR
        process.env.PI_CODING_AGENT_DIR = agent
        mkdirSync(join(workspace, '.git'))
        const hits = join(agent, 'project-hit.txt')
        const script = join(agent, 'project.cjs')
        writeFileSync(script, `
            const fs = require('node:fs')
            const readline = require('node:readline')
            fs.writeFileSync(${JSON.stringify(hits)}, 'p')
            const rl = readline.createInterface({ input: process.stdin })
            rl.on('line', (line) => {
                let msg
                try { msg = JSON.parse(line) } catch { return }
                if (!msg || !msg.id) return
                const result = msg.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} }
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
            })
        `)
        writeFileSync(join(agent, 'mcp.json'), JSON.stringify({
            mcpServers: { shared: { command: 'true' } },
        }))
        writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
            mcpServers: { shared: { command: process.execPath, args: [script] } },
        }))
        try {
            const config = await readLiveSessionConfig({ flavor: 'omp', cwd: workspace, tools: [], check: 'shared' })
            const shared = config.mcp?.servers.find((server) => server.name === 'shared')
            expect(shared?.source).toBe('user')
            expect(shared?.loaded).toBe(false)
            expect(shared?.filePath?.endsWith('/mcp.json')).toBe(true)
            expect(shared?.filePath?.endsWith('/.mcp.json')).toBe(false)
            expect(existsSync(hits)).toBe(false)
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previous
            rmSync(workspace, { recursive: true, force: true })
            rmSync(agent, { recursive: true, force: true })
            clearProbeCache()
        }
    })



    it('attaches the on-disk skill file when a catalog entry has no path', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-skill-path-'))
        try {
            const skillDir = join(root, '.claude', 'skills', 'docs')
            mkdirSync(skillDir, { recursive: true })
            writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: docs\ndescription: Read docs\n---\nBody\n')
            const config = await readLiveSessionConfig({
                flavor: 'claude',
                cwd: root,
                skills: inventorySkills([{ name: 'docs', description: 'Read docs', source: 'project' }]),
            })
            expect(config.skills?.items.find((skill) => skill.name === 'docs')?.filePath).toBe('.claude/skills/docs/SKILL.md')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('reads a repo opencode.json absolute path only after authorization', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-opencode-repo-'))
        const outside = mkdtempSync(join(tmpdir(), 'hapi-opencode-secret-'))
        const creds = join(outside, 'creds')
        writeFileSync(creds, 'aws_secret_access_key=sekret\n')
        writeFileSync(join(root, 'opencode.json'), JSON.stringify({ instructions: [creds] }))
        try {
            const allowed = await listedSessionConfigRealpaths({ flavor: 'opencode', cwd: root })
            const real = realpathSync(creds)
            expect(allowed.has(real)).toBe(true)
            const rpc = new RpcHandlerManager({ scopePrefix: 'session-opencode' })
            registerFileHandlers(rpc, root, async () => allowed)
            const read = async (authorized: boolean) => JSON.parse(await rpc.handleRequest({
                method: 'session-opencode:readFile',
                params: JSON.stringify({ path: creds, authorized }),
            })) as { success: boolean; content?: string }
            expect((await read(false)).success).toBe(false)
            const opened = await read(true)
            expect(opened.success).toBe(true)
            expect(Buffer.from(opened.content ?? '', 'base64').toString('utf8')).toContain('sekret')
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })

    it('lists custom sub-agents and lets a project file override a bundled one', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-agents-project-'))
        const home = mkdtempSync(join(tmpdir(), 'hapi-agents-home-'))
        const bundled = mkdtempSync(join(tmpdir(), 'hapi-agents-bundled-'))
        const previousHome = process.env.PI_CODING_AGENT_DIR
        const previousClaude = process.env.CLAUDE_CONFIG_DIR
        const previousBundled = process.env.HAPI_OMP_BUNDLED_AGENTS
        process.env.PI_CODING_AGENT_DIR = home
        process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
        process.env.HAPI_OMP_BUNDLED_AGENTS = bundled
        mkdirSync(join(workspace, '.git'))
        mkdirSync(join(workspace, '.omp', 'agents'), { recursive: true })
        mkdirSync(join(home, 'agents'), { recursive: true })
        mkdirSync(join(home, 'claude', 'agents'), { recursive: true })
        writeFileSync(join(workspace, '.omp', 'agents', 'scout.md'), '---\nmeta:\n  name: hidden\n  description: Nested\nname: scout\ndescription: Project scout\n---\nDo not leak token=sekret\n')
        writeFileSync(join(home, 'agents', 'notes.md'), '---\nname: notes\ndescription: User notes https://example.test\n---\nbody\n')
        writeFileSync(join(home, 'claude', 'agents', 'claude-helper.md'), '---\nname: claude-helper\ndescription: Claude helper\n---\nbody\n')
        writeFileSync(join(bundled, 'scout.md'), '---\nname: scout\ndescription: Bundled scout\n---\nbody\n')
        writeFileSync(join(bundled, 'task.md'), '---\nname: task\ndescription: Bundled task\n---\nbody\n')
        try {
            const agents = await listSessionAgents(workspace)
            const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]))
            expect(byName.scout).toMatchObject({ source: 'project', description: 'Project scout' })
            expect(byName.scout?.filePath).toBe('.omp/agents/scout.md')
            expect(byName.notes).toMatchObject({ source: 'user', description: 'User notes' })
            expect(byName.notes?.filePath).toContain('/agents/notes.md')
            expect(byName['claude-helper']).toMatchObject({ source: 'user', description: 'Claude helper' })
            expect(byName.task).toMatchObject({ source: 'system', description: 'Bundled task' })
            expect(byName.task?.filePath).toContain('/task.md')
            const encoded = JSON.stringify(agents)
            expect(encoded).not.toContain('sekret')
            expect(encoded).not.toContain('https://')
        } finally {
            if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR
            else process.env.PI_CODING_AGENT_DIR = previousHome
            if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
            else process.env.CLAUDE_CONFIG_DIR = previousClaude
            if (previousBundled === undefined) delete process.env.HAPI_OMP_BUNDLED_AGENTS
            else process.env.HAPI_OMP_BUNDLED_AGENTS = previousBundled
            rmSync(workspace, { recursive: true, force: true })
            rmSync(home, { recursive: true, force: true })
            rmSync(bundled, { recursive: true, force: true })
        }
    })

    it('lists a script named by a project settings file', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-hook-repo-'))
        const outside = mkdtempSync(join(tmpdir(), 'hapi-hook-script-'))
        const script = join(outside, 'hook.sh')
        writeFileSync(script, 'echo secret\n')
        const text = JSON.stringify({
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] },
        })
        try {
            const items = hooksFromClaudeSettings(JSON.parse(text) as unknown, {
                file: join(root, '.claude', 'settings.json'),
                cwd: root,
                text,
                source: 'project',
            })
            expect(items[0]?.event).toBe('PreToolUse')
            expect(items[0]?.scriptPath).toBe(realpathSync(script))
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })
})
