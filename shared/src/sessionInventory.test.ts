import { describe, expect, it } from 'bun:test'
import { asMarkdownRedaction, parseSessionConfigDetail, parseSessionConfigRpc, redactConfigSecrets, SessionInventorySchema } from './sessionInventory'

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

    it('redacts hapi_mu tokens without blanking ordinary names', () => {
        const hapi = `hapi_mu_${'a'.repeat(20)}`
        const short = `hapi_mu_${'b'.repeat(8)}`
        const sk = `sk-${'c'.repeat(12)}`
        const ghp = `ghp_${'d'.repeat(12)}`
        const pat = `github_pat_${'e'.repeat(12)}`
        const slack = `xoxb-${'f'.repeat(12)}`
        const hidden = '***'
        expect(redactConfigSecrets(`see ${hapi} ${short} ${sk} ${ghp} ${pat} ${slack}`))
            .toBe(`see ${hidden} ${short} ${hidden} ${hidden} ${hidden} ${hidden}`)
        expect(redactConfigSecrets(hapi)).toBe(hidden)
        expect(redactConfigSecrets(`${hapi}\nstill here`)).toBe(`${hidden}\nstill here`)
        expect(redactConfigSecrets('hapi_session_config_detail')).toBe('hapi_session_config_detail')
        expect(redactConfigSecrets('use hapi_change_title_now please')).toBe('use hapi_change_title_now please')
        expect(redactConfigSecrets('mcp__hapi__change_title')).toBe('mcp__hapi__change_title')
        expect(redactConfigSecrets('PASSWORD=yes')).toBe('PASSWORD=***')
        expect(redactConfigSecrets('DB_PASSWORD=Yes')).toBe('DB_PASSWORD=***')
        expect(redactConfigSecrets('SECRET=0')).toBe('SECRET=***')
        expect(redactConfigSecrets('--token true')).toBe('--token ***')
        expect(asMarkdownRedaction('TOKEN=***')).toBe('TOKEN=`***`')
        expect(asMarkdownRedaction('TOKEN=`***`')).toBe('TOKEN=`***`')
        expect(asMarkdownRedaction('***bold italic***')).toBe('***bold italic***')
        expect(asMarkdownRedaction('---')).toBe('---')
        expect(asMarkdownRedaction('***')).toBe('***')
        expect(redactConfigSecrets('useToken = false')).toBe('useToken = false')
        expect(redactConfigSecrets('"useToken": "true"')).toBe('"useToken": "true"')
        const secret = ['plain', 'value'].join('-')
        expect(redactConfigSecrets(`CLI_API_TOKEN=${secret}`)).toBe(`CLI_API_TOKEN=${hidden}`)
        expect(redactConfigSecrets(`"cliApiToken": "${secret}"`)).toBe(`"cliApiToken": ${hidden}`)
        expect(redactConfigSecrets(`"CLI_API_TOKEN": "${secret}"`)).toBe(`"CLI_API_TOKEN": ${hidden}`)
        expect(redactConfigSecrets(`CLI_API_TOKEN=${secret}`)).not.toContain(secret)
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
