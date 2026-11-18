import { describe, expect, it } from 'vitest'
import {
    formatCodexReasoningLabel,
    formatCompactCodexReasoningLabel,
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowCodexReasoningLabel,
    shouldShowReasoningStatusLabel
} from './codexStatusLabels'

describe('codexStatusLabels', () => {
    it('formats unset and default effort as reasoning default', () => {
        expect(formatCodexReasoningLabel(null)).toBe('reasoning default')
        expect(formatCodexReasoningLabel(undefined)).toBe('reasoning default')
        expect(formatCodexReasoningLabel('default')).toBe('reasoning default')
        expect(formatCodexReasoningLabel('  DEFAULT  ')).toBe('reasoning default')
    })

    it('formats selected efforts', () => {
        expect(formatCodexReasoningLabel('xhigh')).toBe('reasoning xhigh')
        expect(formatCodexReasoningLabel('Ultra')).toBe('reasoning ultra')
    })

    it('can omit the reasoning field label', () => {
        expect(formatCodexReasoningLabel('xhigh', false)).toBe('xhigh')
        expect(formatCodexReasoningLabel(null, false)).toBe('default')
    })

    it('formats compact effort-only labels', () => {
        expect(formatCompactCodexReasoningLabel(null)).toBe('default')
        expect(formatCompactCodexReasoningLabel('default')).toBe('default')
        expect(formatCompactCodexReasoningLabel('xhigh')).toBe('xhigh')
        expect(formatCompactCodexReasoningLabel(' Ultra ')).toBe('ultra')
    })

    it('only shows the label for codex and opencode', () => {
        expect(shouldShowCodexReasoningLabel('codex')).toBe(true)
        expect(shouldShowCodexReasoningLabel('opencode')).toBe(true)
        expect(shouldShowCodexReasoningLabel('claude')).toBe(false)
        expect(shouldShowCodexReasoningLabel(null)).toBe(false)
    })
})

describe('reasoning status metadata', () => {
    it('formats Pi reasoning labels with the shared formatter', () => {
        expect(formatReasoningLabel('MAX')).toBe('reasoning max')
        expect(formatCompactReasoningLabel(' MAX ')).toBe('max')
    })

    it('uses model reasoning effort for Codex/OpenCode and ordinary effort for Pi/Agy', () => {
        expect(getReasoningEffortForFlavor('codex', 'xhigh', 'max')).toBe('xhigh')
        expect(getReasoningEffortForFlavor('opencode', 'high', 'max')).toBe('high')
        expect(getReasoningEffortForFlavor('pi', 'xhigh', 'max')).toBe('max')
        expect(getReasoningEffortForFlavor('agy', 'xhigh', 'high')).toBe('high')
        expect(getReasoningEffortForFlavor('claude', 'xhigh', 'max')).toBeNull()
        expect(getReasoningEffortForFlavor('grok', 'xhigh', 'max')).toBeNull()
        expect(getReasoningEffortForFlavor(null, 'xhigh', 'max')).toBeNull()
    })

    it('keeps unset defaults for Codex/OpenCode and requires a real Pi/Agy effort', () => {
        expect(shouldShowReasoningStatusLabel('codex', null)).toBe(true)
        expect(shouldShowReasoningStatusLabel('opencode', null)).toBe(true)
        expect(shouldShowReasoningStatusLabel('pi', 'max')).toBe(true)
        expect(shouldShowReasoningStatusLabel('pi', null)).toBe(false)
        expect(shouldShowReasoningStatusLabel('pi', '   ')).toBe(false)
        expect(shouldShowReasoningStatusLabel('agy', 'high')).toBe(true)
        expect(shouldShowReasoningStatusLabel('agy', null)).toBe(false)
        expect(shouldShowReasoningStatusLabel('agy', '   ')).toBe(false)
        expect(shouldShowReasoningStatusLabel('claude', 'max')).toBe(false)
        expect(shouldShowReasoningStatusLabel('grok', 'max')).toBe(false)
        expect(shouldShowReasoningStatusLabel(null, 'max')).toBe(false)
    })
})
