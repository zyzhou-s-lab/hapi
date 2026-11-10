import Foundation

// Port of web/src/chat/normalize.ts — total decode of one wire message.

private func nonEmptyTurnId(_ value: String?) -> String? {
    guard let trimmed = value?.jsTrimmed, !trimmed.isEmpty else { return nil }
    return trimmed
}

private func resolveMessageTurnId(_ message: DecryptedMessage, meta: JSONValue?) -> String? {
    if let deliveryTurnId = nonEmptyTurnId(message.turnId) {
        return deliveryTurnId
    }
    return nonEmptyTurnId(meta?["turnId"]?.stringValue)
}

/// Port of `normalizeDecryptedMessage`. Returns `nil` only on the two
/// legitimate drop paths (skippable Claude output, unknown codex content);
/// every other malformed shape degrades to stringified text.
public func normalizeDecryptedMessage(_ message: DecryptedMessage) -> NormalizedMessage? {
    guard let record = unwrapRoleWrappedRecordEnvelope(message.content) else {
        return NormalizedMessage(
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: .agent([.text(.init(text: safeStringify(message.content), uuid: message.id, parentUUID: nil))]),
            isSidechain: false,
            // No meta / invokedAt on this branch (normalize.ts:10-20).
            turnId: resolveMessageTurnId(message, meta: nil),
            turnState: message.turnState
        )
    }
    let turnId = resolveMessageTurnId(message, meta: record.meta)
    let turnState = message.turnState

    if record.role == "user" {
        if var normalized = normalizeUserRecord(
            messageId: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: record.content,
            meta: record.meta
        ) {
            normalized.invokedAt = message.invokedAt
            normalized.turnId = turnId
            normalized.turnState = turnState
            return normalized
        }
        return NormalizedMessage(
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: .user(text: safeStringify(record.content), attachments: nil),
            isSidechain: false,
            meta: record.meta,
            invokedAt: message.invokedAt,
            turnId: turnId,
            turnState: turnState
        )
    }

    if record.role == "agent" {
        if isSkippableAgentContent(record.content) {
            return nil
        }
        let normalized = normalizeAgentRecord(
            messageId: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: record.content,
            meta: record.meta
        )
        if normalized == nil && isCodexContent(record.content) {
            return nil
        }
        if var normalized {
            normalized.invokedAt = message.invokedAt
            normalized.turnId = turnId
            normalized.turnState = turnState
            return normalized
        }
        return NormalizedMessage(
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: .agent([.text(.init(text: safeStringify(record.content), uuid: message.id, parentUUID: nil))]),
            isSidechain: false,
            meta: record.meta,
            invokedAt: message.invokedAt,
            turnId: turnId,
            turnState: turnState
        )
    }

    return NormalizedMessage(
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        content: .agent([.text(.init(text: safeStringify(record.content), uuid: message.id, parentUUID: nil))]),
        isSidechain: false,
        meta: record.meta,
        invokedAt: message.invokedAt,
        turnId: turnId,
        turnState: turnState
    )
}
