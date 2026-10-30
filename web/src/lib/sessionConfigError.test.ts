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

    it('shows other reasons without absolute paths and truncates them', () => {
        expect(formatSessionConfigError(
            'failed to read /Users/dev/project/.mcp.json token=abc',
            t,
        )).toBe('Could not read session config: failed to read token=abc')
        expect(formatSessionConfigError(`boom ${'x'.repeat(200)}`, t)).toMatch(/…$/)
        expect(formatSessionConfigError(`boom ${'x'.repeat(200)}`, t).length).toBeLessThan(220)
        expect(formatSessionConfigError('/tmp/only-a-path', t)).toBe('Unavailable')
    })
})
