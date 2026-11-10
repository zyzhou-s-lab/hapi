import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import {
    addMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteLiveMessageSnapshots,
    finalizeOpenLiveStreamsForSession,
    deleteQueuedMessageById,
    claimIndeterminateMessage,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    markMessagesIndeterminate,
    setMessagesDeliveryState,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    getAllMessages,
    getMessagesAfterSeq,
    getMessageSeqById,
    truncateMessagesFromLocalId,
    getMessageByLocalId,
    bindSessionSource,
    isSessionSourceAuthoritative,
    recordTurnLifecycleEvent,
    closeRunningTurnsForSession,
    buildMessageReceiptInfo,
    checkSessionMessageReceipt,
    recordSessionMessageReceipt,
    getRunningTurnIdsForSession,
    type SessionMessageReceiptInfo,
    type SessionMessageReceiptLookup,
    type BindSessionSourceResult,
    type RecordTurnLifecycleTransitionResult,
    type CloseRunningTurnsForSessionResult,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
} from './messages'
import type { TurnLifecycleEventPayload } from '@hapi/protocol/messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number): StoredMessage {
        return addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt)
    }

    addLifecycleMessage(sessionId: string, namespace: string, content: unknown, event: TurnLifecycleEventPayload, localId: string, createdAt?: number): { message: StoredMessage; transition: RecordTurnLifecycleTransitionResult } {
        return this.db.transaction(() => {
            const now = Date.now()
            const stampedAt = Number.isFinite(createdAt)
                ? Math.min(createdAt!, now)
                : now
            const existing = this.db.prepare(
                'SELECT COALESCE(invoked_at, created_at) AS at, seq FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
            ).get(sessionId, localId) as { at: number; seq: number } | undefined
            const nextSeqRow = this.db.prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
            ).get(sessionId) as { nextSeq: number }
            const position = existing ?? { at: stampedAt, seq: nextSeqRow.nextSeq }
            const transition = recordTurnLifecycleEvent(this.db, sessionId, namespace, event, now, position)
            const message = addMessage(this.db, sessionId, content, localId, undefined, stampedAt)
            return { message, transition }
        })()
    }

    deleteLiveMessageSnapshots(sessionId: string, streamId: string, keepMessageId?: string): number {
        return deleteLiveMessageSnapshots(this.db, sessionId, streamId, keepMessageId)
    }

    finalizeOpenLiveStreamsForSession(sessionId: string, turnId?: string | null): StoredMessage[] {
        return finalizeOpenLiveStreamsForSession(this.db, sessionId, turnId)
    }

    addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): { message: StoredMessage; inserted: boolean } {
        return addImportedMessage(this.db, sessionId, content, localId, createdAt)
    }

    copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>
    ): StoredMessage {
        // 中文注释：重复会话合并时需要保留源消息的时间戳和排队信息，因此走专门的复制入口而不是普通 addMessage。
        return this.db.transaction(() => copyStoredMessageToSession(this.db, sessionId, message))()
    }

    copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): number {
        return copyStoredMessagesToSession(this.db, sessionId, messages)
    }

    getAllMessages(sessionId: string): StoredMessage[] {
        return getAllMessages(this.db, sessionId)
    }

    getMessagesAfterSeq(sessionId: string, afterSeq: number): StoredMessage[] {
        return getMessagesAfterSeq(this.db, sessionId, afterSeq)
    }

    getSeqById(sessionId: string, messageId: string): number | null {
        return getMessageSeqById(this.db, sessionId, messageId)
    }

    getMessages(sessionId: string, limit: number = 200): StoredMessage[] {
        return getMessages(this.db, sessionId, limit)
    }

    getFirstMessages(sessionId: string, limit: number = 50): StoredMessage[] {
        return getFirstMessages(this.db, sessionId, limit)
    }

    getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): StoredMessage[] {
        return getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit)
    }

    getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): StoredMessage[] {
        return getMessagesByPosition(this.db, sessionId, limit, before)
    }

    getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition
    ): StoredMessage[] {
        return getMessagesAfterPosition(this.db, sessionId, limit, after, until)
    }

    getNewestMessagePosition(sessionId: string): MessagePosition | null {
        return getNewestMessagePosition(this.db, sessionId)
    }

    getMessageEpoch(sessionId: string): number {
        return getMessageEpoch(this.db, sessionId)
    }

    bumpMessageEpoch(sessionId: string): number {
        return bumpMessageEpoch(this.db, sessionId)
    }

    getLocalMessageStates(sessionId: string, localIds: string[]): LocalMessageState[] {
        return getLocalMessageStates(this.db, sessionId, localIds)
    }

    getUninvokedLocalMessages(sessionId: string, options?: { deliverableOnly?: boolean }): StoredMessage[] {
        return getUninvokedLocalMessages(this.db, sessionId, options)
    }

    getMatureScheduledMessages(beforeTime: number): StoredMessage[] {
        return getMatureScheduledMessages(this.db, beforeTime)
    }

    getImmediateQueuedLocalMessages(sessionId: string): StoredMessage[] {
        return getImmediateQueuedLocalMessages(this.db, sessionId)
    }

    countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): number {
        return countFutureScheduledLocalMessages(this.db, sessionId, now)
    }

    countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return countFutureScheduledBySessionIds(this.db, sessionIds, now)
    }

    minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return minFutureScheduledAtBySessionIds(this.db, sessionIds, now)
    }

    countMessages(sessionId: string): number {
        return countMessages(this.db, sessionId)
    }

    cancelQueuedMessage(sessionId: string, messageId: string): CancelQueuedMessageResult {
        return cancelQueuedMessage(this.db, sessionId, messageId)
    }

    lookupQueuedMessage(sessionId: string, messageId: string): LookupQueuedMessageResult {
        return lookupQueuedMessage(this.db, sessionId, messageId)
    }

    deleteQueuedMessageById(sessionId: string, messageId: string): boolean {
        return deleteQueuedMessageById(this.db, sessionId, messageId)
    }

    claimIndeterminateMessage(sessionId: string, messageId: string): StoredMessage | null {
        return claimIndeterminateMessage(this.db, sessionId, messageId)
    }

    markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): number {
        return markMessagesInvoked(this.db, sessionId, localIds, invokedAt)
    }

    markMessagesIndeterminate(sessionId: string, localIds: string[]): number {
        return markMessagesIndeterminate(this.db, sessionId, localIds)
    }

    setMessagesDeliveryState(sessionId: string, localIds: string[], state: 'queued' | 'dispatching' | 'indeterminate'): number {
        return setMessagesDeliveryState(this.db, sessionId, localIds, state)
    }

    markUninvokedImmediateMessages(sessionId: string, invokedAt: number): string[] {
        return markUninvokedImmediateMessages(this.db, sessionId, invokedAt)
    }

    moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId)
    }

    moveUninvokedMessages(fromSessionId: string, toSessionId: string): number {
        return moveUninvokedMessages(this.db, fromSessionId, toSessionId)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
        }> = []
    ): { deleted: number; inserted: number; epoch: number } {
        return truncateMessagesFromLocalId(this.db, sessionId, localId, replacement)
    }

    getMessageByLocalId(sessionId: string, localId: string): StoredMessage | null {
        return getMessageByLocalId(this.db, sessionId, localId)
    }
    buildMessageReceiptInfo(content: unknown): SessionMessageReceiptInfo {
        return buildMessageReceiptInfo(content)
    }

    checkSessionMessageReceipt(sessionId: string, eventId: string, expected: SessionMessageReceiptInfo): SessionMessageReceiptLookup {
        return checkSessionMessageReceipt(this.db, sessionId, eventId, expected)
    }

    recordSessionMessageReceipt(sessionId: string, eventId: string, info: SessionMessageReceiptInfo, now?: number): void {
        recordSessionMessageReceipt(this.db, sessionId, eventId, info, now)
    }

    getRunningTurnIdsForSession(sessionId: string, sourceInstanceId?: string | null): string[] {
        return getRunningTurnIdsForSession(this.db, sessionId, sourceInstanceId)
    }


    bindSessionSource(sessionId: string, sourceInstanceId: string, now?: number, namespace?: string): BindSessionSourceResult {
        return bindSessionSource(this.db, sessionId, sourceInstanceId, now, namespace)
    }

    isSessionSourceAuthoritative(
        sessionId: string,
        sourceInstanceId?: string | null,
        sourceGeneration?: number | null,
        options?: { allowUnbound?: boolean }
    ): boolean {
        return isSessionSourceAuthoritative(this.db, sessionId, sourceInstanceId, sourceGeneration, options)
    }

    recordTurnLifecycleEvent(
        sessionId: string,
        namespace: string,
        event: TurnLifecycleEventPayload,
        now?: number
    ): RecordTurnLifecycleTransitionResult {
        return recordTurnLifecycleEvent(this.db, sessionId, namespace, event, now)
    }

    closeRunningTurnsForSession(
        sessionId: string,
        namespace: string,
        options: {
            reason: 'session-abort' | 'session-end' | 'session-inactive'
            sourceInstanceId?: string | null
            turnIds?: string[]
            retireSource?: boolean
            bumpGeneration?: boolean
            now?: number
        }
    ): CloseRunningTurnsForSessionResult {
        return closeRunningTurnsForSession(this.db, sessionId, namespace, options)
    }
}
