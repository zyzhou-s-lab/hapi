import { describe, expect, it } from 'vitest'
import { hooksSection, mcpSection, skillsSection, visibleInventoryText } from './sessionInventoryView'
import type { SessionInventory } from '@hapi/protocol/types'

const reported: SessionInventory = {
    reportedAt: 1,
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
        expect(mcpSection(reported).status).toBe('list')
        if (mcpSection(reported).status === 'list') {
            expect(mcpSection(reported)).toMatchObject({
                rows: [{ title: 'hapi', source: 'injected' }],
            })
        }
    })

    it('shows unreported, empty, tool names, and no-hooks states', () => {
        expect(mcpSection(undefined)).toEqual({ status: 'unreported' })
        expect(hooksSection(undefined)).toEqual({ status: 'unreported' })
        expect(mcpSection({
            reportedAt: 1,
            mcp: { kind: 'servers', servers: [] },
        })).toEqual({ status: 'empty' })
        expect(mcpSection({
            reportedAt: 1,
            mcp: { kind: 'tools', servers: [{ name: 'example_probe', source: 'tool' }] },
        })).toMatchObject({ status: 'list', tools: true })
        expect(hooksSection({
            reportedAt: 1,
            hooks: { availability: 'none', items: [] },
        })).toEqual({ status: 'none' })
    })

    it('prefers a live skill list and falls back to the snapshot or offline', () => {
        expect(skillsSection({
            inventory: reported,
            live: { state: 'ready', skills: [] },
            sessionActive: true,
        })).toEqual({ status: 'empty' })

        expect(skillsSection({
            inventory: reported,
            live: { state: 'error' },
            sessionActive: false,
        }).status).toBe('list')

        expect(skillsSection({
            inventory: { reportedAt: 1, skills: { catalogUnavailable: true, items: [] } },
            live: { state: 'error', catalogUnavailable: true },
            sessionActive: true,
        })).toEqual({ status: 'catalogUnavailable' })

        expect(skillsSection({
            inventory: undefined,
            live: { state: 'error' },
            sessionActive: false,
        })).toEqual({ status: 'offline' })

        expect(skillsSection({
            inventory: undefined,
            live: { state: 'error' },
            sessionActive: true,
        })).toEqual({ status: 'unreported' })
    })
})
