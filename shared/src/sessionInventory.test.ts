import { describe, expect, it } from 'bun:test'
import { parseSessionConfigDetail, parseSessionConfigRpc, redactConfigSecrets, SessionInventorySchema } from './sessionInventory'

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

    it('redacts runner errors and keeps an empty failure empty', () => {
        const token = ['s', 'k', '-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('')
        const parsed = parseSessionConfigRpc({ success: false, error: `Bearer ${token}" OPENAI_API_KEY=zzsecret GITHUB_TOKEN=zzgithub` })
        expect(parsed.success).toBe(false)
        if (parsed.success) return
        expect(parsed.error).toContain('Bearer ***"')
        expect(parsed.error).toContain('OPENAI_API_KEY=***')
        expect(parsed.error).toContain('GITHUB_TOKEN=***')
        expect(parsed.error).not.toContain(token)
        expect(parsed.error).not.toContain('zzsecret')
        expect(parseSessionConfigRpc({ success: false, error: '   ' })).toEqual({ success: false, error: '' })
        const detail = parseSessionConfigDetail({
            success: true,
            kind: 'hook',
            event: 'PreToolUse',
            source: 'user',
            enabled: true,
            mutable: false,
            script: `GITHUB_TOKEN=zzgithub ${token}`,
            truncated: false,
        })
        expect(detail.success && detail.kind === 'hook' ? detail.script : '').toBe('GITHUB_TOKEN=*** ***')
        expect(redactConfigSecrets(`prefix ${token}"`)).toBe('prefix ***"')
    })

    it('keeps prompt labels, drops command text, and redacts prompt detail', () => {
        const parsed = parseSessionConfigRpc({
            success: true,
            prompts: {
                system: { availability: 'listed', items: [{ id: 's1', role: 'system', scope: 'injected', title: 'append-system-prompt', command: 'secret' }] },
                user: { availability: 'listed', items: [{ id: 'u1', role: 'user', scope: 'project', title: 'CLAUDE.md', pathLabel: 'CLAUDE.md', url: 'http://example.test' }] },
            },
        })
        expect(parsed).toEqual({
            success: true,
            prompts: {
                system: { availability: 'listed', items: [{ id: 's1', role: 'system', scope: 'injected', title: 'append-system-prompt' }] },
                user: { availability: 'listed', items: [{ id: 'u1', role: 'user', scope: 'project', title: 'CLAUDE.md', pathLabel: 'CLAUDE.md' }] },
            },
        })
        const token = ['s', 'k', '-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('')
        const detail = parseSessionConfigDetail({
            success: true,
            kind: 'prompt',
            id: 'u1',
            title: 'CLAUDE.md',
            markdown: `OPENAI_API_KEY=zzgithub ${token}`,
            truncated: true,
        })
        expect(detail.success && detail.kind === 'prompt' ? detail.markdown : '').toBe('OPENAI_API_KEY=*** ***')
        expect(JSON.stringify(parsed)).not.toContain('http')
        expect(JSON.stringify(parsed)).not.toContain('secret')
    })
})
