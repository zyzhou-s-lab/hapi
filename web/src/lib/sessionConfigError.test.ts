import { describe, expect, it } from 'vitest'
import { formatSessionConfigError } from './sessionConfigError'

const t = (key: string, params?: Record<string, string | number>) => {
    if (key === 'session.config.runnerOffline') return 'Runner is offline and the config could not be read.'
    if (key === 'session.config.unavailable') return 'Unavailable'
    if (key === 'session.config.errorWithDetail') return `Could not read session config: ${params?.error}`
    return key
}

describe('formatSessionConfigError', () => {
    it('maps a missing runner handler to the offline message', () => {
        expect(formatSessionConfigError('RPC handler not registered: session-1:listSessionConfig', t))
            .toBe('Runner is offline and the config could not be read.')
        expect(formatSessionConfigError('handler-not-registered', t))
            .toBe('Runner is offline and the config could not be read.')
        expect(formatSessionConfigError('RPC socket disconnected: session-1:listSessionConfig', t))
            .toBe('Runner is offline and the config could not be read.')
    })

    it('uses a neutral message when the error is empty', () => {
        expect(formatSessionConfigError('', t)).toBe('Unavailable')
        expect(formatSessionConfigError('   ', t)).toBe('Unavailable')
        expect(formatSessionConfigError(undefined, t)).toBe('Unavailable')
    })

    it('masks secrets, keeps ordinary text, and drops absolute paths', () => {
        const message = formatSessionConfigError(
            `failed to read /Users/dev/project/.mcp.json token=abc Bearer sek-ret key=hunter2 https://user:${'p4ss'}@example.test/mcp and/or https://example.test`,
            t,
        )
        expect(message).not.toContain('abc')
        expect(message).not.toContain('sek-ret')
        expect(message).not.toContain('hunter2')
        expect(message).not.toContain('p4ss')
        expect(message).not.toContain('/Users/')
        expect(message).toContain('token=***')
        expect(message).toContain('Bearer ***')
        expect(message).toContain('key=***')
        expect(message).toContain('https://***@example.test/mcp')
        expect(message).toContain('and/or')
        expect(message).toContain('https://example.test')
        expect(formatSessionConfigError(`boom ${'x'.repeat(200)}`, t)).toMatch(/…$/)
        expect(formatSessionConfigError('/tmp/only-a-path', t)).toBe('Unavailable')
    })
})