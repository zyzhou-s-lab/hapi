import { describe, expect, it } from 'vitest'
import { hooksSection, mcpSection, promptSection, skillsSection, visibleInventoryText } from './sessionInventoryView'
import type { SessionInventory } from '@hapi/protocol/types'

const reported: SessionInventory = {
    mcp: {
        kind: 'servers',
        servers: [
            { name: 'hapi', source: 'injected' },
            { name: 'http://127.0.0.1:9/?token=abc', source: 'user' },
        ],
    },
    hooks: {
        availability: 'listed',
        items: [{
            event: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            commandName: 'my-hook',
        }],
    },
    skills: {
        items: [{ name: 'review', description: 'Read the diff', source: 'project' }],
    },
}

describe('session inventory view', () => {
    it('redacts secrets in a preview instead of dropping the line', () => {
        const hidden = '***'
        expect(visibleInventoryText('see https://example.test token=abc and kept')).toBe(`see token=${hidden} and kept`)
        const secret = ['plain', 'value'].join('-')
        const preview = visibleInventoryText(`hapi_session_config_detail useToken = true CLI_API_TOKEN=${secret}`)
        expect(preview).toContain('hapi_session_config_detail')
        expect(preview).toContain('useToken = true')
        expect(preview).toContain(`CLI_API_TOKEN=${hidden}`)
        expect(preview).not.toContain(secret)
        expect(visibleInventoryText('see file://secret and kept')).toBeUndefined()
        expect(mcpSection(reported)).toMatchObject({
            status: 'list',
            rows: [{ title: 'hapi', source: 'injected' }],
        })
        expect(skillsSection(reported, 'omp')).toMatchObject({
            status: 'list',
            rows: [{ title: 'review', mutable: true, lock: null }],
        })
        expect(skillsSection({
            skills: { items: [{ name: 'bundled', source: 'system' }] },
        }, 'omp')).toMatchObject({
            rows: [{ title: 'bundled', mutable: false, lock: 'source' }],
        })
    })

    it('groups MCP servers by config file and keeps a checked project server checkable', () => {
        const section = mcpSection({
            mcp: {
                kind: 'servers',
                servers: [
                    { name: 'near', source: 'project', filePath: '.omp/mcp.json', loaded: true },
                    { name: 'root', source: 'project', filePath: '.mcp.json' },
                    { name: 'home', source: 'user', filePath: '/Users/dev/.omp/agent/mcp.json', loaded: true },
                    { name: 'hapi', source: 'injected' },
                ],
            },
        }, 'omp')
        expect(section).toMatchObject({
            status: 'list',
            groups: [
                { label: '.omp/mcp.json', rows: [{ title: 'near', checkable: true, loaded: true }] },
                { label: '.mcp.json', rows: [{ title: 'root', checkable: true }] },
                { label: '/Users/dev/.omp/agent/mcp.json', rows: [{ title: 'home' }] },
                { rows: [{ title: 'hapi', source: 'injected' }] },
            ],
        })
    })


    it('shows unreported, empty, tool names, and no-hooks states', () => {
        expect(mcpSection(undefined)).toEqual({ status: 'unreported' })
        expect(hooksSection(undefined)).toEqual({ status: 'unreported' })
        expect(skillsSection(undefined)).toEqual({ status: 'unreported' })
        expect(mcpSection({
            mcp: { kind: 'servers', servers: [] },
        })).toEqual({ status: 'empty' })
        expect(mcpSection({
            mcp: { kind: 'tools', servers: [{ name: 'example_probe', source: 'tool' }] },
        })).toMatchObject({ status: 'list', tools: true })
        expect(hooksSection({
            hooks: { availability: 'none', items: [] },
        })).toEqual({ status: 'none' })
        expect(skillsSection({
            skills: { catalogUnavailable: true, items: [] },
        })).toEqual({ status: 'catalogUnavailable' })
    })

    it('lists prompts without a switch and keeps an on-demand marker', () => {
        const section = promptSection({
            prompts: {
                system: { availability: 'none', note: 'no-hapi-system', items: [] },
                user: {
                    availability: 'listed',
                    items: [{
                        id: 'rule',
                        role: 'user',
                        scope: 'project',
                        title: 'api.mdc',
                        pathLabel: '.cursor/rules/api.mdc',
                        load: 'path',
                        match: 'src/**/*.ts',
                        hasText: true,
                    }],
                },
            },
        }, 'user')
        expect(promptSection(undefined, 'system')).toEqual({ status: 'unreported' })
        expect(promptSection({ prompts: { system: { availability: 'none', note: 'no-hapi-system', items: [] } } }, 'system')).toEqual({
            status: 'none',
            note: 'no-hapi-system',
        })
        expect(section).toMatchObject({
            status: 'list',
            rows: [{
                title: 'api.mdc',
                detail: '.cursor/rules/api.mdc',
                toggle: false,
                openable: false,
                load: 'path',
                match: 'src/**/*.ts',
                ref: { kind: 'prompt', id: 'rule' },
            }],
        })
    })
})
