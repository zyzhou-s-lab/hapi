import { describe, expect, it } from 'vitest'
import { formatOmpDuration, formatOmpTokenCount, formatOmpTurnFooter, parseOmpTurnFooter } from '@/chat/ompTurnFooter'

describe('formatOmpTurnFooter', () => {
    it('matches the Tern end-of-turn line, including cost when present', () => {
        const durationMs = 2_100 * 1000 / 74.8
        const footer = parseOmpTurnFooter({
            requestStartedAtMs: 1_700_000_000_000,
            elapsedMs: 47_900,
            inputTokens: 3_800,
            outputTokens: 2_100,
            cacheReadTokens: 198_000,
            ttftMs: 4_300,
            durationMs,
            turnTokens: 203_000,
            turnCostUsd: 0
        })
        expect(footer).toBeDefined()
        expect(formatOmpTurnFooter(footer!, () => '21:57')).toBe(
            '21:57 · Δ 47.9s · in 3.8K · out 2.1K · cache 198K · ttft 4.3s · 74.8 tok/s · 47.9s · 203K tok this turn'
        )
        expect(formatOmpTurnFooter({ ...footer!, turnCostUsd: 0.85 }, () => '21:57')).toBe(
            '21:57 · Δ 47.9s · in 3.8K · out 2.1K · cache 198K · ttft 4.3s · 74.8 tok/s · 47.9s · 203K tok · $0.85 this turn'
        )
        expect(formatOmpTurnFooter({ ...footer!, turnCostUsd: 0.004 }, () => '21:57')).toContain('<$0.01 this turn')
    })

    it('omits clock, delta, cache, ttft, and tok/s when those fields are absent', () => {
        expect(formatOmpTurnFooter({
            inputTokens: 12,
            outputTokens: 3,
            turnTokens: 15
        })).toBe('in 12 · out 3 · 15 tok this turn')
        expect(formatOmpTurnFooter({ turnTokens: 203_000 })).toBe('203K tok this turn')
        expect(formatOmpTurnFooter({ inputTokens: 1, outputTokens: 0, durationMs: 50 })).toBe('in 1 · out 0')
    })

    it('drops a payload with no usage and no turn total', () => {
        expect(parseOmpTurnFooter({ elapsedMs: 10, requestStartedAtMs: 10 })).toBeUndefined()
        expect(parseOmpTurnFooter(null)).toBeUndefined()
    })
})

describe('omp compact formatters', () => {
    it('follows omp duration and token rounding', () => {
        expect(formatOmpDuration(0)).toBe('0ms')
        expect(formatOmpDuration(999)).toBe('999ms')
        expect(formatOmpDuration(47_900)).toBe('47.9s')
        expect(formatOmpDuration(60_000)).toBe('1m')
        expect(formatOmpDuration(90_000)).toBe('1m30s')
        expect(formatOmpDuration(3_600_000)).toBe('1h')
        expect(formatOmpTokenCount(999)).toBe('999')
        expect(formatOmpTokenCount(1_000)).toBe('1K')
        expect(formatOmpTokenCount(3_800)).toBe('3.8K')
        expect(formatOmpTokenCount(198_000)).toBe('198K')
        expect(formatOmpTokenCount(1_500_000)).toBe('1.5M')
    })
})
