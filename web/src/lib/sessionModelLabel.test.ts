import { describe, expect, it } from 'vitest'
import { formatUsageSnapshotLabel, getSessionModelLabel } from './sessionModelLabel'

describe('getSessionModelLabel', () => {
    it('prefers the explicit session model', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.4' })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.4'
        })
    })

    it('renders friendly labels for known Claude aliases', () => {
        expect(getSessionModelLabel({ model: 'opus' })).toEqual({
            key: 'session.item.model',
            value: 'Opus'
        })
        expect(getSessionModelLabel({ model: 'fable' })).toEqual({
            key: 'session.item.model',
            value: 'Fable'
        })
    })

    it('renders friendly labels for current and legacy AGY models and supports dynamic availableModels overrides', () => {
        expect(getSessionModelLabel({ model: 'gemini-pro-orchestrator' })).toEqual({
            key: 'session.item.model',
            value: 'Orchestrator (Carbon)'
        })
        expect(getSessionModelLabel({ model: 'gemini-3.5-flash-medium' })).toEqual({
            key: 'session.item.model',
            value: 'Gemini 3.5 Flash (Medium)'
        })
        expect(getSessionModelLabel(
            { model: 'gemini-pro-orchestrator' },
            [{ modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Live Override)' }]
        )).toEqual({
            key: 'session.item.model',
            value: 'Orchestrator (Live Override)'
        })
    })

    it('returns null when no model is available', () => {
        expect(getSessionModelLabel({})).toBeNull()
    })
})

describe('formatUsageSnapshotLabel', () => {
    it('renders the first normalized progress metric', () => {
        expect(formatUsageSnapshotLabel({
            providerId: 'openusage', displayName: 'Claude', plan: 'Max 20x', fetchedAt: '2026-07-12T00:00:00Z',
            metrics: [{ type: 'progress', label: 'Session', used: 24, limit: 100, unit: 'percent', resetsAt: null }]
        }, '余 ')).toBe('Claude · Session 余 76%')
    })
})
