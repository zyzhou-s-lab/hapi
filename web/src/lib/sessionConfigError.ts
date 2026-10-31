import { redactConfigSecrets } from '@hapi/protocol/schemas'

type Translate = (key: string, params?: Record<string, string | number>) => string

const DETAIL_LIMIT = 160

function stripAbsolutePaths(value: string): string {
    return value
        .replace(/(^|\s)(?:~|\/)\S*/g, '$1')
        .replace(/(^|\s)[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
}

export function formatSessionConfigError(error: string | null | undefined, t: Translate): string {
    const detail = error?.trim() ?? ''
    if (!detail || detail === 'Failed to read session config' || detail === 'Session config unavailable') {
        return t('session.config.unavailable')
    }
    if (detail === 'Invalid session config') return t('session.config.invalid')
    if (
        detail === 'handler-not-registered'
        || detail === 'socket-disconnected'
        || detail.startsWith('RPC handler not registered')
        || detail.startsWith('RPC socket disconnected')
    ) {
        return t('session.config.runnerOffline')
    }

    const sanitized = stripAbsolutePaths(redactConfigSecrets(detail))
    if (!sanitized) return t('session.config.unavailable')
    const clipped = sanitized.length > DETAIL_LIMIT
        ? `${sanitized.slice(0, DETAIL_LIMIT - 1)}…`
        : sanitized
    return t('session.config.errorWithDetail', { error: clipped })
}
