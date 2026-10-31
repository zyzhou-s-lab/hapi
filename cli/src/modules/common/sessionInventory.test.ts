import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { describe, expect, it } from 'vitest'
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
    readLiveSessionConfig,
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
        expect(ompInventoryFromTools(['read', 'mcp__example_probe', 'mcp__'])).toEqual({
            mcp: { kind: 'tools', servers: [{ name: 'example_probe', source: 'tool' }] },
            hooks: { availability: 'none', items: [] },
        })
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

    it('does not read an absolute path named by a repo opencode.json', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-opencode-repo-'))
        const outside = mkdtempSync(join(tmpdir(), 'hapi-opencode-secret-'))
        const creds = join(outside, 'creds')
        writeFileSync(creds, 'aws_secret_access_key=sekret\n')
        writeFileSync(join(root, 'opencode.json'), JSON.stringify({ instructions: [creds] }))
        try {
            const allowed = await listedSessionConfigRealpaths({ flavor: 'opencode', cwd: root })
            expect(allowed.has(realpathSync(creds))).toBe(false)
            const rpc = new RpcHandlerManager({ scopePrefix: 'session-opencode' })
            registerFileHandlers(rpc, root, async () => allowed)
            const response = JSON.parse(await rpc.handleRequest({
                method: 'session-opencode:readFile',
                params: JSON.stringify({ path: creds }),
            })) as { success: boolean }
            expect(response.success).toBe(false)
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })

    it('does not open a script named by a project settings file', () => {
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
                allowOutside: false,
            })
            expect(items[0]?.event).toBe('PreToolUse')
            expect(items[0]?.scriptPath).toBeUndefined()
        } finally {
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })
})
