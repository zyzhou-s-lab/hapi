import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { isObject, safeStringify } from '@hapi/protocol'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { isCodexContent, isSkippableAgentContent, normalizeAgentRecord } from '@/chat/normalizeAgent'
import { normalizeUserRecord } from '@/chat/normalizeUser'

const normalizedMessageCache = new WeakMap<DecryptedMessage, NormalizedMessage | null>()

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | null {
    if (normalizedMessageCache.has(message)) {
        return normalizedMessageCache.get(message) ?? null
    }
    const result = normalizeDecryptedMessageUncached(message)
    normalizedMessageCache.set(message, result)
    return result
}

function normalizeDecryptedMessageUncached(message: DecryptedMessage): NormalizedMessage | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    // Provider payload IDs are not canonical invocation identities.
    const turnId = message.turnId?.trim()
        || (record && isObject(record.meta) && typeof record.meta.turnId === 'string' ? record.meta.turnId.trim() : undefined)
        || undefined
    const turnState = message.turnState ?? undefined
    if (!record) {
        return {
            id: message.id,
            turnId,
            turnState,
            localId: message.localId,
            createdAt: message.createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: safeStringify(message.content), uuid: message.id, parentUUID: null }],
            status: message.status,
            originalText: message.originalText
        }
    }

    if (record.role === 'user') {
        const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized
            ? {
                ...normalized,
                turnId,
                turnState,
                status: message.status,
                originalText: message.originalText,
                invokedAt: message.invokedAt,
                steered: message.steered
            }
            : {
                id: message.id,
                turnId,
                turnState,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: safeStringify(record.content) },
                meta: record.meta,
                status: message.status,
                originalText: message.originalText,
                invokedAt: message.invokedAt,
                steered: message.steered
            }
    }
    if (record.role === 'agent') {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (!normalized && isCodexContent(record.content)) {
            return null
        }
        if (!normalized) {
            return {
                id: message.id,
                turnId,
                turnState,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
                meta: record.meta,
                status: message.status,
                originalText: message.originalText,
                invokedAt: message.invokedAt
            }
        }
        const settledOverride = message.lifecycleState === 'settled'
            && normalized.role === 'agent'
            && (normalized.live || normalized.streamSnapshot?.live)
            ? {
                live: undefined,
                streamSnapshot: normalized.streamSnapshot
                    ? { ...normalized.streamSnapshot, live: false }
                    : undefined
            }
            : undefined
        return {
            ...normalized,
            turnId,
            turnState,
            ...settledOverride,
            status: message.status,
            originalText: message.originalText,
            invokedAt: message.invokedAt
        }
    }

    return {
        id: message.id,
        turnId,
        turnState,
        localId: message.localId,
        createdAt: message.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
        meta: record.meta,
        status: message.status,
        originalText: message.originalText,
        invokedAt: message.invokedAt
    }
}
