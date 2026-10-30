import { describe, expect, it } from 'bun:test'
import { MetadataSchema } from './schemas'
import { SessionInventorySchema } from './sessionInventory'

describe('SessionInventorySchema', () => {
    it('keeps names and sources and drops command, url, and token fields', () => {
        const parsed = SessionInventorySchema.parse({
            reportedAt: 1,
            mcp: {
                kind: 'servers',
                servers: [{
                    name: 'docs',
                    source: 'user',
                    command: 'npx secret-server',
                    url: 'http://127.0.0.1:9/?token=abc',
                    env: { TOKEN: 'abc' },
                }],
            },
            hooks: {
                availability: 'listed',
                items: [{
                    event: 'PreToolUse',
                    matcher: 'Bash',
                    source: 'user',
                    commandName: 'my-hook',
                    command: 'my-hook --token secret',
                }],
            },
        })

        expect(parsed.mcp?.servers).toEqual([{ name: 'docs', source: 'user' }])
        expect(parsed.hooks?.items).toEqual([{
            event: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            commandName: 'my-hook',
        }])
        expect(JSON.stringify(parsed)).not.toContain('token')
        expect(JSON.stringify(parsed)).not.toContain('http')
        expect(JSON.stringify(parsed)).not.toContain('npx')
    })

    it('round-trips through session metadata', () => {
        const parsed = MetadataSchema.parse({
            path: '/work',
            host: 'local',
            sessionInventory: {
                reportedAt: 10,
                mcp: { kind: 'tools', servers: [{ name: 'probe', source: 'tool' }] },
                hooks: { availability: 'none', items: [] },
                skills: {
                    catalogUnavailable: true,
                    items: [],
                },
            },
        })

        expect(parsed.sessionInventory?.mcp?.kind).toBe('tools')
        expect(parsed.sessionInventory?.hooks?.availability).toBe('none')
        expect(parsed.sessionInventory?.skills?.catalogUnavailable).toBe(true)
    })
})
