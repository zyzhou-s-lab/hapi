import { describe, expect, it } from 'vitest'
import { hooksSection, mcpSection, skillsSection, visibleInventoryText } from './sessionInventoryView'
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
})
