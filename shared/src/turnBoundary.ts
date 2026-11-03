import { unwrapRoleWrappedRecordEnvelope } from './messages'
import { isObject } from './utils'

/**
 * Claude Code writes bookkeeping into the transcript as `type: 'user'`.
 * The same prefixes are rejected by `isExternalUserMessage` in the CLI.
 */
const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>',
]

export const TURN_PAGE_SIZE = 20
export const TURN_PAGE_MAX = 50
export const TURN_PAGE_ROW_MAX = 2000

function textFromContent(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
            if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') continue
            parts.push(block.text)
        }
        return parts.length > 0 ? parts.join('\n') : null
    }
    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return content.text
    }
    return null
}

function isSidechainOrMeta(content: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    const candidates = [content, record, record?.meta, record?.content]
    for (const candidate of candidates) {
        if (!isObject(candidate)) continue
        if (candidate.isSidechain === true || candidate.isMeta === true) return true
        if (isObject(candidate.data) && (candidate.data.isSidechain === true || candidate.data.isMeta === true)) {
            return true
        }
    }
    return false
}

/**
 * A conversation turn starts at a human prompt that has already been invoked.
 * Queued rows (`invokedAt === null`), sidechain prompts, and Claude's injected
 * user-shaped bookkeeping do not. Attachment-only prompts do.
 * `invokedAt` omitted (pre-V8 payloads) counts as already invoked.
 */
export function isHumanTurnStart(message: { content: unknown; invokedAt?: number | null }): boolean {
    if (message.invokedAt === null) return false
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record || record.role !== 'user') return false
    if (isSidechainOrMeta(message.content)) return false
    const text = textFromContent(record.content)
    if (text !== null && SYSTEM_INJECTION_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix))) {
        return false
    }
    if (text !== null && text.trim().length > 0) return true
    return isObject(record.content) && Array.isArray(record.content.attachments) && record.content.attachments.length > 0
}
