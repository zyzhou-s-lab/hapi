import { describe, expect, it } from 'bun:test'
import { isHumanTurnStart } from './turnBoundary'

describe('isHumanTurnStart', () => {
    it('counts an invoked user prompt', () => {
        expect(isHumanTurnStart({
            invokedAt: 1,
            content: { role: 'user', content: { type: 'text', text: 'hello' } }
        })).toBe(true)
    })

    it('counts an attachment-only prompt', () => {
        expect(isHumanTurnStart({
            invokedAt: 1,
            content: {
                role: 'user',
                content: { type: 'text', text: '   ', attachments: [{ id: 'a' }] }
            }
        })).toBe(true)
    })

    it('ignores queued prompts, agent rows, injections, and sidechains', () => {
        expect(isHumanTurnStart({
            invokedAt: null,
            content: { role: 'user', content: { type: 'text', text: 'queued' } }
        })).toBe(false)
        expect(isHumanTurnStart({
            invokedAt: 1,
            content: { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } }
        })).toBe(false)
        expect(isHumanTurnStart({
            invokedAt: 1,
            content: { role: 'user', content: '<task-notification>\n<task-id>1</task-id>' }
        })).toBe(false)
        expect(isHumanTurnStart({
            invokedAt: 1,
            content: { role: 'user', content: { type: 'text', text: 'child' }, isSidechain: true }
        })).toBe(false)
    })
})
