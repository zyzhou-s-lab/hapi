package app.hapi.protocol.chat

import app.hapi.protocol.wire.DecryptedMessage

/** Port of `web/src/chat/normalize.ts` — the decode-tree entry point. */

private fun nonEmptyTurnId(value: String?): String? =
    value?.trim()?.takeIf { it.isNotEmpty() }

private fun resolveMessageTurnId(
    message: DecryptedMessage,
    meta: kotlinx.serialization.json.JsonElement?,
): String? =
    nonEmptyTurnId(message.turnId)
        ?: nonEmptyTurnId(asObject(meta)?.let { asString(it["turnId"]) })

private fun stringifiedAgentFallback(
    message: DecryptedMessage,
    text: String,
    meta: kotlinx.serialization.json.JsonElement?,
    invokedAt: Long?,
    turnId: String?,
    turnState: String?,
): NormalizedMessage = NormalizedMessage.Agent(
    id = message.id,
    localId = message.localId,
    createdAt = message.createdAt,
    isSidechain = false,
    content = listOf(NormalizedAgentContent.Text(text = text, uuid = message.id, parentUUID = null)),
    meta = meta,
    status = null,
    originalText = null,
    invokedAt = invokedAt,
    turnId = turnId,
    turnState = turnState,
)

fun normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage? {
    val record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record == null) {
        // No envelope: stringify the whole content. (TS sets no invokedAt here.)
        return stringifiedAgentFallback(
            message,
            safeStringify(message.content),
            meta = null,
            invokedAt = null,
            turnId = resolveMessageTurnId(message, meta = null),
            turnState = message.turnState,
        )
    }

    val invokedAt = message.invokedAtOrNull
    val turnId = resolveMessageTurnId(message, record.meta)
    val turnState = message.turnState

    if (record.role == "user") {
        val normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return if (normalized is NormalizedMessage.User) {
            normalized.copy(invokedAt = invokedAt, turnId = turnId, turnState = turnState)
        } else {
            NormalizedMessage.User(
                id = message.id,
                localId = message.localId,
                createdAt = message.createdAt,
                isSidechain = false,
                text = safeStringify(record.content),
                meta = record.meta,
                invokedAt = invokedAt,
                turnId = turnId,
                turnState = turnState,
            )
        }
    }
    if (record.role == "agent") {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        val normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (normalized == null && isCodexContent(record.content)) {
            return null
        }
        return when (normalized) {
            is NormalizedMessage.User -> normalized.copy(invokedAt = invokedAt, turnId = turnId, turnState = turnState)
            is NormalizedMessage.Agent -> normalized.copy(invokedAt = invokedAt, turnId = turnId, turnState = turnState)
            is NormalizedMessage.Event -> normalized.copy(invokedAt = invokedAt, turnId = turnId, turnState = turnState)
            null -> stringifiedAgentFallback(message, safeStringify(record.content), meta = record.meta, invokedAt = invokedAt, turnId = turnId, turnState = turnState)
        }
    }

    return stringifiedAgentFallback(message, safeStringify(record.content), meta = record.meta, invokedAt = invokedAt, turnId = turnId, turnState = turnState)
}
