import { describe, expect, it } from 'bun:test'
import { parseSessionConfigRpc, SessionInventorySchema } from './sessionInventory'

describe('SessionInventorySchema', () => {
    it('keeps names and sources and drops command, url, and token fields', () => {
        const parsed = SessionInventorySchema.parse({
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

    it('drops commands and urls from a successful RPC payload and keeps failures', () => {
        const parsed = parseSessionConfigRpc({
            success: true,
            mcp: {
                kind: 'servers',
                servers: [{ name: 'docs', source: 'user', command: 'npx', url: 'http://127.0.0.1/?token=abc' }],
            },
        })
        expect(parsed).toEqual({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'docs', source: 'user' }] },
        })
        expect(JSON.stringify(parsed)).not.toContain('token')
        expect(parseSessionConfigRpc({ success: false, error: 'handler-not-registered' })).toEqual({
            success: false,
            error: 'handler-not-registered',
        })
    })
})
