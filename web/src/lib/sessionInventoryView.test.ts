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
    it('hides urls and tokens', () => {
        expect(visibleInventoryText('see https://example.test token=abc')).toBe('see')
        expect(mcpSection(reported)).toMatchObject({
            status: 'list',
            rows: [{ title: 'hapi', source: 'injected' }],
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
                toggle: false,
                openable: true,
                load: 'path',
                match: 'src/**/*.ts',
                ref: { kind: 'prompt', id: 'rule' },
            }],
        })
    })
})
