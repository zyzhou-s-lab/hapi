import { describe, expect, it } from 'vitest'
import { formatSessionConfigError } from './sessionConfigError'

const t = (key: string, params?: Record<string, string | number>) => {
    if (key === 'session.config.runnerOffline') return 'Runner is offline and the config could not be read.'
    if (key === 'session.config.unavailable') return 'Unavailable'
    if (key === 'session.config.errorWithDetail') return `Could not read session config: ${params?.error}`
    if (key === 'session.config.invalid') return 'Could not parse session config.'
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
        expect(formatSessionConfigError('Invalid session config', t)).toBe('Could not parse session config.')
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
        expect(message).toContain('token=`***`')
        expect(message).toContain('Bearer `***`')
        expect(message).toContain('key=`***`')
        expect(message).toContain('https://`***`@example.test/mcp')
        expect(message).toContain('and/or')
        expect(message).toContain('https://example.test')
        const secret = 'zz' + 'value123456'
        const bare = ['s', 'k', '-', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('')
        const github = ['g', 'h', 'p', '_', 'a', 'b', 'c', 'd', 'e', 'f', '1', '2', '3', '4', '5', '6', '7', '8'].join('')
        const envLine = formatSessionConfigError(`OPENAI_API_KEY=${secret} GITHUB_TOKEN=${github} ${bare}`, t)
        expect(envLine).toContain('OPENAI_API_KEY=`***`')
        expect(envLine).toContain('GITHUB_TOKEN=`***`')
        expect(envLine).not.toContain(secret)
        expect(envLine).not.toContain(github)
        expect(envLine).not.toContain(bare)
        expect(formatSessionConfigError(`boom ${'x'.repeat(200)}`, t)).toMatch(/…$/)
        expect(formatSessionConfigError('/tmp/only-a-path', t)).toBe('Unavailable')
    })
})