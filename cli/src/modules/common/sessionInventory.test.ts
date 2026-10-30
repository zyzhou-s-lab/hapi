import { describe, expect, it } from 'vitest'
import {
    commandBasename,
    hooksFromClaudeSettings,
    inventorySkills,
    mcpServersFromClaudeJson,
    mcpServersFromConfig,
    ompInventoryFromTools,
    parseCodexConfigInventory,
    withSessionInventory,
} from './sessionInventory'
import type { Metadata } from '@/api/types'

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
        expect(parsed.hooks).toEqual([{ event: 'PreToolUse', source: 'user' }])
        expect(JSON.stringify(parsed)).not.toContain('http')
        expect(JSON.stringify(parsed)).not.toContain('abc')
    })

    it('turns omp mcp tool names into a tools list and reports no hooks', () => {
        expect(ompInventoryFromTools(['read', 'mcp__example_probe', 'mcp__'])).toEqual({
            mcp: { kind: 'tools', servers: [{ name: 'example_probe', source: 'tool' }] },
            hooks: { availability: 'none', items: [] },
        })
    })

    it('merges a skill snapshot without dropping an earlier mcp report', () => {
        const metadata = {
            path: '/work',
            host: 'local',
            sessionInventory: {
                reportedAt: 1,
                mcp: { kind: 'servers' as const, servers: [{ name: 'hapi', source: 'injected' as const }] },
            },
        } satisfies Metadata

        const next = withSessionInventory(metadata, {
            skills: inventorySkills([{ name: 'review', description: 'Look at https://example.test token=abc', source: 'project' }]),
        }, 2)

        expect(next.sessionInventory?.mcp?.servers).toEqual([{ name: 'hapi', source: 'injected' }])
        expect(next.sessionInventory?.skills?.items).toEqual([{
            name: 'review',
            description: 'Look at',
            source: 'project',
        }])
        expect(JSON.stringify(next.sessionInventory)).not.toContain('http')
        expect(JSON.stringify(next.sessionInventory)).not.toContain('abc')
    })
})
