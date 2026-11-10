import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
    getLegacyMessageTurnId,
    getLiveMessageStreamId,
    getMessageScope,
    getMessageSourceAuthority,
    getMessageStreamId,
    getMessageTurnId,
    getMessageTurnPhase,
    getTurnLifecycleEvent,
    unwrapRoleWrappedRecordEnvelope,
    type TurnLifecycleEventPayload
} from '@hapi/protocol/messages'
import type { SessionLifecycleState, TurnState } from '@hapi/protocol'
import type { StoredMessage } from './types'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'

type DbMessageRow = {
    id: string
    session_id: string
    // TEXT (plaintext JSON, legacy rows) or BLOB (zstd-compressed JSON) — see contentCodec.ts
    content: string | Uint8Array
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
    scheduled_at: number | null
    delivery_state: string | null
    stream_id?: string | null
    stream_live?: number
    turn_id?: string | null
    turn_phase?: string | null
}

type DbSessionTurnRow = {
    session_id: string
    turn_id: string
    invocation_id: string | null
    provider_turn_id: string | null
    source_instance_id: string | null
    source_generation: number | null
    scope: string
    start_order: number | null
    status: TurnState
    outcome: string | null
    cutoff_source: string | null
    start_event_id: string | null
    end_event_id: string | null
    created_at: number
    updated_at: number
}

type DbSessionSourceRow = {
    session_id: string
    source_instance_id: string
    generation: number
    status: 'active' | 'retired'
    created_at: number
    updated_at: number
}

export type SessionSourceBinding = {
    sourceInstanceId: string
    sourceGeneration: number
    fenced: boolean
}

export type MessagePosition = {
    at: number
    seq: number
}

export type SteerDeliveryState = 'queued' | 'dispatching' | 'indeterminate'

export class ImportedMessageConflictError extends Error {
    constructor(readonly localId: string) {
        super(`Imported message content changed for localId: ${localId}`)
        this.name = 'ImportedMessageConflictError'
    }
}

/** Indexed metadata is separate from the compressed payload. Canonicalization
 * runs in the writer's transaction: final beats live, then arrival seq wins. */
function normalizeHistoryMessageContent(content: unknown): unknown {
    const settled = settleLiveMessageContent(content)
    if (!isRecordObject(settled)) return settled
    if (typeof settled.role === 'string' && 'content' in settled) {
        const existingMeta = isRecordObject(settled.meta) ? settled.meta : {}
        const contentData = isRecordObject(settled.content) && isRecordObject(settled.content.data)
            ? settled.content.data
            : null
        const nextContent = contentData && contentData.type === 'turn-lifecycle'
            ? {
                ...(settled.content as Record<string, unknown>),
                data: {
                    ...contentData,
                    scope: 'history' as const,
                    replayedHistory: true
                }
            }
            : settled.content
        return {
            ...settled,
            content: nextContent,
            meta: {
                ...existingMeta,
                scope: existingMeta.scope === 'child' ? 'child' : 'history',
                replayedHistory: true
            }
        }
    }
    return settled
}

function canonicalizeLegacyTurnContent(content: unknown): { content: unknown; turnId: string | null; changed: boolean } {
    const canonicalTurnId = getMessageTurnId(content)
    if (canonicalTurnId) {
        return { content, turnId: canonicalTurnId, changed: false }
    }
    const legacyTurnId = getLegacyMessageTurnId(content)
    if (!legacyTurnId || !isRecordObject(content) || typeof content.role !== 'string' || !('content' in content)) {
        return { content, turnId: legacyTurnId, changed: false }
    }
    const existingMeta = isRecordObject(content.meta) ? content.meta : {}
    return {
        content: {
            ...content,
            meta: {
                ...existingMeta,
                turnId: legacyTurnId
            }
        },
        turnId: legacyTurnId,
        changed: true
    }
}

function ensureClosedTurnTombstone(
    db: Database,
    sessionId: string,
    turnId: string,
    status: Exclude<TurnState, 'running'>,
    now: number,
    options?: {
        scope?: string
        invocationId?: string | null
        providerTurnId?: string | null
        sourceInstanceId?: string | null
        sourceGeneration?: number | null
        outcome?: string | null
        cutoffSource?: string | null
        startEventId?: string | null
        endEventId?: string | null
    }
): void {
    db.prepare(`
        INSERT INTO session_turns (
            session_id, turn_id, invocation_id, provider_turn_id, source_instance_id, source_generation,
            scope, start_order, status, outcome, cutoff_source, start_event_id, end_event_id, created_at, updated_at
        ) VALUES (
            @session_id, @turn_id, @invocation_id, @provider_turn_id, @source_instance_id, @source_generation,
            @scope, NULL, @status, @outcome, @cutoff_source, @start_event_id, @end_event_id, @now, @now
        )
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
            status = CASE WHEN session_turns.status = 'running' THEN excluded.status ELSE session_turns.status END,
            outcome = COALESCE(session_turns.outcome, excluded.outcome),
            cutoff_source = COALESCE(session_turns.cutoff_source, excluded.cutoff_source),
            end_event_id = COALESCE(session_turns.end_event_id, excluded.end_event_id),
            updated_at = excluded.updated_at
    `).run({
        session_id: sessionId,
        turn_id: turnId,
        invocation_id: options?.invocationId ?? null,
        provider_turn_id: options?.providerTurnId ?? null,
        source_instance_id: options?.sourceInstanceId ?? null,
        source_generation: options?.sourceGeneration ?? null,
        scope: options?.scope ?? 'history',
        status,
        outcome: options?.outcome ?? null,
        cutoff_source: options?.cutoffSource ?? null,
        start_event_id: options?.startEventId ?? null,
        end_event_id: options?.endEventId ?? null,
        now
    })
}

function getSessionTurnStatus(db: Database, sessionId: string, turnId: string | null | undefined): TurnState | null {
    if (!turnId) return null
    const row = db.prepare(
        'SELECT status FROM session_turns WHERE session_id = ? AND turn_id = ? LIMIT 1'
    ).get(sessionId, turnId) as { status: TurnState } | undefined
    return row?.status ?? null
}

function isClosedTurnStatus(status: TurnState | null): boolean {
    return status !== null && status !== 'running'
}

function indexMessageStream(
    db: Database,
    sessionId: string,
    id: string,
    content: unknown,
    options?: { forceClosedTurnSettle?: boolean; markTurnHistory?: boolean; streamLiveOverride?: boolean; now?: number }
): string {
    const streamId = getMessageStreamId(content)
    const turnId = getMessageTurnId(content)
    const turnPhase = getMessageTurnPhase(content)
    const scope = getMessageScope(content)
    const now = options?.now ?? Date.now()
    if (turnId && (options?.markTurnHistory || scope === 'history')) {
        ensureClosedTurnTombstone(db, sessionId, turnId, 'history', now, { scope: 'history' })
    }
    const turnStatus = getSessionTurnStatus(db, sessionId, turnId)
    const forceSettle = Boolean(options?.forceClosedTurnSettle && isClosedTurnStatus(turnStatus))
    const rawLive = options?.streamLiveOverride ?? (getLiveMessageStreamId(content) !== null)
    const live = !forceSettle && scope !== 'history' && rawLive
    if (forceSettle && getLiveMessageStreamId(content) !== null) {
        const settledContent = settleLiveMessageContent(content)
        db.prepare('UPDATE messages SET content = ? WHERE id = ?')
            .run(encodeMessageContent(truncateOversizedMessageContent(settledContent)), id)
    }
    if (streamId === null) {
        if (turnId !== null || turnPhase !== null) {
            db.prepare('UPDATE messages SET turn_id = ?, turn_phase = ? WHERE id = ?')
                .run(turnId, turnPhase, id)
        }
        return id
    }
    db.prepare('UPDATE messages SET stream_id = ?, stream_live = ?, stream_provisional = ?, turn_id = COALESCE(?, turn_id), turn_phase = COALESCE(?, turn_phase) WHERE id = ?')
        .run(streamId, live ? 1 : 0, rawLive ? 1 : 0, turnId, turnPhase, id)
    const winner = db.prepare(`
        SELECT id FROM messages WHERE session_id = ? AND stream_id = ?
        ORDER BY stream_provisional ASC, seq DESC LIMIT 1
    `).get(sessionId, streamId) as { id: string }
    const replacesFinal = !rawLive && db.prepare(`
        SELECT 1 FROM messages
        WHERE session_id = ? AND stream_id = ? AND stream_provisional = 0 AND id <> ? LIMIT 1
    `).get(sessionId, streamId, id)
    db.prepare('DELETE FROM messages WHERE session_id = ? AND stream_id = ? AND id <> ?')
        .run(sessionId, streamId, winner.id)
    // Only prior finals can contribute usage. Normal provisional replacement
    // must not repeatedly invalidate the whole session's usage scan.
    if (replacesFinal) bumpMessageEpoch(db, sessionId)
    return winner.id
}

/** A byte-identical snapshot is not a new revision. Replays must not insert,
 * replace, or bump the epoch. Live versus final is part of the content. */
function identicalStreamMessage(db: Database, sessionId: string, content: unknown): StoredMessage | null {
    const streamId = getMessageStreamId(content)
    if (streamId === null) return null
    const row = db.prepare(`
        SELECT * FROM messages WHERE session_id = ? AND stream_id = ?
        ORDER BY stream_provisional ASC, seq DESC LIMIT 1
    `).get(sessionId, streamId) as DbMessageRow | undefined
    if (!row) return null
    const stored = truncateOversizedMessageContent(content)
    if (!isDeepStrictEqual(decodeMessageContent(row.content), stored)) return null
    return hydrateStoredMessage(db, row)
}

/** Used only by migration/merge, never by the snapshot hot path. */
export function compactMessageStreams(db: Database, sessionId?: string): void {
    db.prepare(`
        DELETE FROM messages WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY session_id, stream_id ORDER BY stream_provisional ASC, seq DESC
                ) AS rank FROM messages
                WHERE stream_id IS NOT NULL ${sessionId ? 'AND session_id = ?' : ''}
            ) WHERE rank > 1
        )
    `).run(...(sessionId ? [sessionId] : []))
}

/** One-time v26 backfill reads legacy TEXT and compressed BLOB content alike. */
export function backfillMessageStreams(db: Database): void {
    const update = db.prepare('UPDATE messages SET stream_id = ?, stream_live = ?, stream_provisional = ? WHERE id = ?')
    const rows = db.prepare('SELECT id, content FROM messages')
    for (const row of rows.iterate() as Iterable<Pick<DbMessageRow, 'id' | 'content'>>) {
        const content = decodeMessageContent(row.content)
        const streamId = getMessageStreamId(content)
        if (streamId !== null) {
            const live = getLiveMessageStreamId(content) === null ? 0 : 1
            update.run(streamId, live, live, row.id)
        }
    }
    compactMessageStreams(db)
    db.exec(`
        INSERT INTO message_epochs (session_id, epoch)
        SELECT DISTINCT session_id, 1 FROM messages WHERE stream_id IS NOT NULL
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `)
}

export function addImportedMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId: string,
    createdAt: number
): { message: StoredMessage; inserted: boolean } {
    const sourceWasLive = getLiveMessageStreamId(content) !== null
    const normalizedContent = normalizeHistoryMessageContent(content)
    const canonicalized = canonicalizeLegacyTurnContent(normalizedContent)
    const finalContent = canonicalized.content

    const existing = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
    ).get(sessionId, localId) as DbMessageRow | undefined
    if (existing) {
        const message = hydrateStoredMessage(db, existing)
        const canonicalContent = truncateOversizedMessageContent(finalContent)
        if (!isDeepStrictEqual(message.content, canonicalContent) && !isDeepStrictEqual(message.content, truncateOversizedMessageContent(content))) {
            throw new ImportedMessageConflictError(localId)
        }
        return { message, inserted: false }
    }

    const now = Date.now()
    const stampedAt = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now
    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        const msgSeqRow = db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }
        const id = randomUUID()
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, NULL
            )
        `).run({
            id,
            session_id: sessionId,
            content: encodeMessageContent(truncateOversizedMessageContent(finalContent)),
            created_at: stampedAt,
            seq: msgSeqRow.nextSeq,
            local_id: localId,
            invoked_at: stampedAt
        })
        const canonicalId = indexMessageStream(db, sessionId, id, finalContent, {
            forceClosedTurnSettle: true,
            markTurnHistory: true,
            streamLiveOverride: sourceWasLive,
            now: stampedAt
        })
        if (canonicalId === id && previousHead && stampedAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(canonicalId) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create imported message')
        return { message: hydrateStoredMessage(db, row), inserted: canonicalId === id }
    })()
}

function toStoredMessage(row: DbMessageRow, turnState?: TurnState | null): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: decodeMessageContent(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null,
        scheduledAt: row.scheduled_at ?? null,
        ...(row.delivery_state && row.delivery_state !== 'queued' ? { deliveryState: 'indeterminate' as const } : {}),
        ...(row.turn_id ? { turnId: row.turn_id } : {}),
        ...(turnState ? { turnState } : {}),
        ...(row.turn_phase === 'execution' || row.turn_phase === 'final_answer' ? { phase: row.turn_phase } : {}),
        ...(row.stream_live === 1
            ? { lifecycleState: 'streaming' as const }
            : (row.stream_id || row.turn_id || row.turn_phase
                ? { lifecycleState: 'settled' as const }
                : {}))
    }
}

function hydrateStoredMessage(db: Database, row: DbMessageRow): StoredMessage {
    const turnState = row.turn_id ? getSessionTurnStatus(db, row.session_id, row.turn_id) : null
    return toStoredMessage(row, turnState)
}

function hydrateStoredMessages(db: Database, rows: DbMessageRow[]): StoredMessage[] {
    if (rows.length === 0) return []
    const turnIdsBySession = new Map<string, Set<string>>()
    for (const row of rows) {
        if (!row.turn_id) continue
        let set = turnIdsBySession.get(row.session_id)
        if (!set) {
            set = new Set<string>()
            turnIdsBySession.set(row.session_id, set)
        }
        set.add(row.turn_id)
    }
    if (turnIdsBySession.size === 0) {
        return rows.map((row) => toStoredMessage(row))
    }
    const statusMap = new Map<string, TurnState>()
    for (const [sessionId, turnIdSet] of turnIdsBySession.entries()) {
        const turnIds = Array.from(turnIdSet)
        const placeholders = turnIds.map(() => '?').join(', ')
        const turnRows = db.prepare(`
            SELECT turn_id, status
            FROM session_turns
            WHERE session_id = ? AND turn_id IN (${placeholders})
        `).all(sessionId, ...turnIds) as Array<{ turn_id: string; status: TurnState }>
        for (const turnRow of turnRows) {
            statusMap.set(`${sessionId}::${turnRow.turn_id}`, turnRow.status)
        }
    }
    return rows.map((row) => {
        const turnState = row.turn_id ? (statusMap.get(`${row.session_id}::${row.turn_id}`) ?? null) : null
        return toStoredMessage(row, turnState)
    })
}

export type CopyStoredMessageInput = Pick<
    StoredMessage,
    'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'
>

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null,
    createdAt?: number
): StoredMessage {
    const now = Date.now()
    // Client-provided origin timestamp (e.g. a Claude transcript entry's own
    // `timestamp`), falling back to server-receive time when absent. Only
    // agent-message callers (sessionHandlers' `on('message')`) pass this today.
    const stampedAt = Number.isFinite(createdAt)
        ? Math.min(createdAt!, now)
        : now

    // Without a localId, invoked_at is stamped immediately below — there is no
    // ack path to flip it later.  A scheduled message in that state would be
    // skipped by the future-emit branch and never picked up by
    // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
    // the schedule would be silently lost.
    if (scheduledAt != null && !localId) {
        throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
    }

    const unwrapped = unwrapRoleWrappedRecordEnvelope(content)
    const isAgentOrLifecycleMessage = unwrapped?.role === 'agent' || getTurnLifecycleEvent(content) !== null

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            if (isAgentOrLifecycleMessage) {
                recordSessionMessageReceipt(
                    db,
                    sessionId,
                    localId,
                    buildMessageReceiptInfo(content),
                    now,
                    { at: existing.invoked_at ?? existing.created_at, seq: existing.seq }
                )
            }
            return hydrateStoredMessage(db, existing)
        }
    }
    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const encoded = encodeMessageContent(truncateOversizedMessageContent(content))

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Agent/lifecycle messages carry a localId for transport idempotency, not for the user prompt queue,
    // so stamp their invoked_at immediately to keep them out of getImmediateQueuedLocalMessages.
    const invokedAt = (!localId || isAgentOrLifecycleMessage) ? stampedAt : null
    const receiptInfo = localId && isAgentOrLifecycleMessage ? buildMessageReceiptInfo(content) : null

    return db.transaction(() => {
        const identical = identicalStreamMessage(db, sessionId, content)
        if (identical) {
            if (receiptInfo && localId) {
                recordSessionMessageReceipt(
                    db,
                    sessionId,
                    localId,
                    receiptInfo,
                    now,
                    { at: identical.invokedAt ?? identical.createdAt, seq: identical.seq }
                )
            }
            return identical
        }
        const previousHead = getNewestMessagePosition(db, sessionId)
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at
            )
        `).run({
            id,
            session_id: sessionId,
            content: encoded,
            created_at: stampedAt,
            seq: msgSeq,
            local_id: localId ?? null,
            invoked_at: invokedAt,
            scheduled_at: scheduledAt ?? null
        })
        const canonicalId = indexMessageStream(db, sessionId, id, content, {
            forceClosedTurnSettle: true,
            now: stampedAt
        })
        if (receiptInfo && localId) {
            recordSessionMessageReceipt(
                db,
                sessionId,
                localId,
                receiptInfo,
                now,
                { at: invokedAt ?? stampedAt, seq: msgSeq }
            )
        }

        const positionAt = invokedAt ?? stampedAt
        if (canonicalId === id && previousHead && positionAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(canonicalId) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create message')
        return hydrateStoredMessage(db, row)
    })()
}

export function getMessageByLocalId(
    db: Database,
    sessionId: string,
    localId: string
): StoredMessage | null {
    const row = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
    ).get(sessionId, localId) as DbMessageRow | undefined
    return row ? hydrateStoredMessage(db, row) : null
}

export type SessionMessageReceiptInfo = {
    kind: 'lifecycle' | 'message'
    sourceInstanceId: string | null
    sourceGeneration: number | null
    turnId: string | null
    transition: string | null
    outcome: string | null
    streamId: string | null
}

export type SessionMessageReceiptLookup = 'absent' | 'matched' | 'conflict'

type DbSessionMessageReceiptRow = {
    session_id: string
    event_id: string
    kind: string
    source_instance_id: string | null
    source_generation: number | null
    turn_id: string | null
    transition: string | null
    outcome: string | null
    stream_id: string | null
    committed_at: number
}

export function buildMessageReceiptInfo(content: unknown): SessionMessageReceiptInfo {
    const lifecycle = getTurnLifecycleEvent(content)
    if (lifecycle) {
        return {
            kind: 'lifecycle',
            sourceInstanceId: lifecycle.sourceInstanceId ?? null,
            sourceGeneration: typeof lifecycle.sourceGeneration === 'number' && Number.isFinite(lifecycle.sourceGeneration)
                ? Math.trunc(lifecycle.sourceGeneration)
                : null,
            turnId: lifecycle.turnId,
            transition: lifecycle.transition,
            outcome: lifecycle.outcome ?? null,
            streamId: null
        }
    }
    const sourceAuthority = getMessageSourceAuthority(content)
    return {
        kind: 'message',
        sourceInstanceId: sourceAuthority.sourceInstanceId ?? null,
        sourceGeneration: sourceAuthority.sourceGeneration ?? null,
        turnId: getMessageTurnId(content),
        transition: null,
        outcome: null,
        streamId: getMessageStreamId(content)
    }
}

export function checkSessionMessageReceipt(
    db: Database,
    sessionId: string,
    eventId: string,
    expected: SessionMessageReceiptInfo
): SessionMessageReceiptLookup {
    const row = db.prepare(`
        SELECT * FROM session_message_receipts
        WHERE session_id = ? AND event_id = ? LIMIT 1
    `).get(sessionId, eventId) as DbSessionMessageReceiptRow | undefined
    if (!row) return 'absent'
    const matches = row.kind === expected.kind
        && (row.source_instance_id ?? null) === expected.sourceInstanceId
        && (row.source_generation ?? null) === expected.sourceGeneration
        && (row.turn_id ?? null) === expected.turnId
        && (row.transition ?? null) === expected.transition
        && (row.outcome ?? null) === expected.outcome
        && (row.stream_id ?? null) === expected.streamId
    return matches ? 'matched' : 'conflict'
}

export function recordSessionMessageReceipt(
    db: Database,
    sessionId: string,
    eventId: string,
    info: SessionMessageReceiptInfo,
    now: number = Date.now(),
    explicitPosition?: { at: number; seq: number }
): void {
    const position = explicitPosition ?? (db.prepare(`
        SELECT COALESCE(invoked_at, created_at) AS at, seq FROM messages
        WHERE session_id = ? AND local_id = ? LIMIT 1
    `).get(sessionId, eventId) as { at: number; seq: number } | undefined)
    const positionSeq = position?.seq ?? getMaxSeq(db, sessionId) + 1
    db.prepare(`
        INSERT INTO session_message_receipts (
            session_id, event_id, kind, source_instance_id, source_generation,
            turn_id, transition, outcome, stream_id, committed_at, position_at, position_seq
        ) VALUES (
            @session_id, @event_id, @kind, @source_instance_id, @source_generation,
            @turn_id, @transition, @outcome, @stream_id, @committed_at, @position_at, @position_seq
        )
        ON CONFLICT(session_id, event_id) DO NOTHING
    `).run({
        session_id: sessionId,
        event_id: eventId,
        kind: info.kind,
        source_instance_id: info.sourceInstanceId,
        source_generation: info.sourceGeneration,
        turn_id: info.turnId,
        transition: info.transition,
        outcome: info.outcome,
        stream_id: info.streamId,
        committed_at: now,
        position_at: position?.at ?? now,
        position_seq: positionSeq
    })
}

export function copyMessageToSession(
    db: Database,
    sessionId: string,
    message: CopyStoredMessageInput
): StoredMessage {
    const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
    const nextSeq = getMaxSeq(db, sessionId) + 1

    let localId = message.localId
    if (localId) {
        const collision = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as { 1: number } | undefined
        if (collision) {
            // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
            localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
        }
    }

    if (message.scheduledAt != null && !localId && message.invokedAt === null) {
        // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
        localId = `merged-scheduled:${randomUUID()}`
    }

    const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
    const id = randomUUID()
    const sourceWasLive = getLiveMessageStreamId(message.content) !== null
    const normalizedContent = normalizeHistoryMessageContent(message.content)
    const canonicalized = canonicalizeLegacyTurnContent(normalizedContent)
    const finalContent = canonicalized.content
    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
        )
    `).run({
        id,
        session_id: sessionId,
        // Lossless re-encode only — copies move existing history between
        // sessions, so no truncation here even for pre-codec oversized rows.
        content: encodeMessageContent(finalContent),
        created_at: createdAt,
        seq: nextSeq,
        local_id: localId ?? null,
        invoked_at: invokedAt ?? null,
        scheduled_at: message.scheduledAt ?? null,
        delivery_state: message.deliveryState ?? 'queued'
    })
    const canonicalId = indexMessageStream(db, sessionId, id, finalContent, {
        forceClosedTurnSettle: true,
        markTurnHistory: true,
        streamLiveOverride: sourceWasLive,
        now: createdAt
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(canonicalId) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to copy message into target session')
    }

    // Copies preserve the source display timestamp, so a new high-seq row can
    // still land behind a Web client's cached composite tail cursor. Mark the
    // target history as structurally changed so incremental readers reset.
    bumpMessageEpoch(db, sessionId)
    return hydrateStoredMessage(db, row)
}

/**
 * Batch-hydrate a fork child: one transaction, contiguous seq allocation,
 * single epoch bump. Avoids O(n) max-seq lookups and epoch writes.
 */
export function copyMessagesToSession(
    db: Database,
    sessionId: string,
    messages: CopyStoredMessageInput[]
): number {
    if (messages.length === 0) return 0

    return db.transaction(() => {
        let nextSeq = getMaxSeq(db, sessionId) + 1
        const insert = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
            )
        `)
        const collisionCheck = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        )

        for (const message of messages) {
            const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
            let localId = message.localId
            if (localId) {
                const collision = collisionCheck.get(sessionId, localId) as { 1: number } | undefined
                if (collision) {
                    localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
                }
            }
            if (message.scheduledAt != null && !localId && message.invokedAt === null) {
                localId = `merged-scheduled:${randomUUID()}`
            }
            const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
            const id = randomUUID()
            const sourceWasLive = getLiveMessageStreamId(message.content) !== null
            const normalizedContent = normalizeHistoryMessageContent(message.content)
            const canonicalized = canonicalizeLegacyTurnContent(normalizedContent)
            const finalContent = canonicalized.content
            insert.run({
                id,
                session_id: sessionId,
                content: encodeMessageContent(finalContent),
                created_at: createdAt,
                seq: nextSeq,
                local_id: localId ?? null,
                invoked_at: invokedAt ?? null,
                scheduled_at: message.scheduledAt ?? null,
                delivery_state: message.deliveryState ?? 'queued'
            })
            indexMessageStream(db, sessionId, id, finalContent, {
                forceClosedTurnSettle: true,
                markTurnHistory: true,
                streamLiveOverride: sourceWasLive,
                now: createdAt
            })
            nextSeq += 1
        }

        bumpMessageEpoch(db, sessionId)
        return messages.length
    })()
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return hydrateStoredMessages(db, rows.reverse())
}

export function getAllMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    return hydrateStoredMessages(db, rows)
}

export function getMessagesAfterSeq(
    db: Database,
    sessionId: string,
    afterSeq: number
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
    ).all(sessionId, afterSeq) as DbMessageRow[]

    return hydrateStoredMessages(db, rows)
}

/** Current seq for a message that still lives on this session (merge-stable id). */
export function getMessageSeqById(
    db: Database,
    sessionId: string,
    messageId: string
): number | null {
    const row = db.prepare(
        'SELECT seq FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { seq: number } | undefined
    return row ? row.seq : null
}

export function getFirstMessages(
    db: Database,
    sessionId: string,
    limit: number = 50
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return hydrateStoredMessages(db, rows)
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export function getDeliverableMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    now: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND seq > ?
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
          AND delivery_state = 'queued'
        ORDER BY seq ASC
        LIMIT ?
    `).all(sessionId, safeAfterSeq, now, safeLimit) as DbMessageRow[]

    return hydrateStoredMessages(db, rows)
}

/** Exact indexed pruning, including snapshots separated by arbitrary context. */
export function deleteLiveMessageSnapshots(
    db: Database,
    sessionId: string,
    streamId: string,
    keepMessageId?: string
): number {
    const result = db.prepare(`
        DELETE FROM messages WHERE session_id = ? AND stream_id = ?
            AND stream_live = 1 AND (? IS NULL OR id <> ?)
    `).run(sessionId, streamId, keepMessageId ?? null, keepMessageId ?? null)
    return Number(result.changes)
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settleRoleWrappedRecord(record: Record<string, unknown>): Record<string, unknown> {
    if (record.role !== 'agent' || !isRecordObject(record.content)) {
        return record
    }
    const content = record.content
    if (!isRecordObject(content.data) || content.data.live !== true) {
        return record
    }
    return {
        ...record,
        content: {
            ...content,
            data: {
                ...content.data,
                live: false
            }
        }
    }
}

function settleLiveMessageContent(value: unknown): unknown {
    if (!isRecordObject(value)) return value
    if (typeof value.role === 'string' && 'content' in value) {
        return settleRoleWrappedRecord(value)
    }
    if (isRecordObject(value.message) && typeof value.message.role === 'string' && 'content' in value.message) {
        const nextMessage = settleRoleWrappedRecord(value.message)
        return nextMessage === value.message ? value : { ...value, message: nextMessage }
    }
    if (isRecordObject(value.data) && isRecordObject(value.data.message)
        && typeof value.data.message.role === 'string' && 'content' in value.data.message) {
        const nextMessage = settleRoleWrappedRecord(value.data.message)
        return nextMessage === value.data.message
            ? value
            : { ...value, data: { ...value.data, message: nextMessage } }
    }
    if (isRecordObject(value.payload) && isRecordObject(value.payload.message)
        && typeof value.payload.message.role === 'string' && 'content' in value.payload.message) {
        const nextMessage = settleRoleWrappedRecord(value.payload.message)
        return nextMessage === value.payload.message
            ? value
            : { ...value, payload: { ...value.payload, message: nextMessage } }
    }
    return value
}

/**
 * Atomically settle any open `stream_live = 1` rows for a session (or specific turn)
 * so a refresh, abort, turn completion, or session exit never leaves orphan streaming
 * rows in SQLite. Also flips `content.data.live = false` so late `liveSnapshot`
 * arrivals are rejected by `indexMessageStream` + `sessionHandlers`.
 */
export function finalizeOpenLiveStreamsForSession(
    db: Database,
    sessionId: string,
    turnId?: string | null
): StoredMessage[] {
    return db.transaction(() => {
        const rows = (turnId
            ? db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND stream_live = 1 AND turn_id = ? ORDER BY seq ASC'
            ).all(sessionId, turnId)
            : db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND stream_live = 1 ORDER BY seq ASC'
            ).all(sessionId)
        ) as DbMessageRow[]
        if (rows.length === 0) return []

        const updateStmt = db.prepare(
            'UPDATE messages SET content = ?, stream_live = 0, stream_provisional = 0 WHERE id = ?'
        )
        const finalized: StoredMessage[] = []
        for (const row of rows) {
            const decoded = decodeMessageContent(row.content)
            const settledContent = settleLiveMessageContent(decoded)
            const encoded = encodeMessageContent(truncateOversizedMessageContent(settledContent))
            updateStmt.run(encoded, row.id)
            finalized.push(hydrateStoredMessage(db, {
                ...row,
                content: encoded,
                stream_live: 0
            }))
        }
        compactMessageStreams(db, sessionId)
        bumpMessageEpoch(db, sessionId)
        return finalized
    })()
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order. */
export function getMessagesByPosition(
    db: Database,
    sessionId: string,
    limit: number,
    before?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const beforeClause = before
        ? 'AND (COALESCE(invoked_at, created_at) < @beforeAt OR (COALESCE(invoked_at, created_at) = @beforeAt AND seq < @beforeSeq))'
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          ${beforeClause}
        ORDER BY position_at DESC, seq DESC
        LIMIT @limit
    `).all({
        sessionId,
        beforeAt: before?.at ?? null,
        beforeSeq: before?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    // Reverse so results are in ascending display order (oldest first)
    return hydrateStoredMessages(db, rows.reverse())
}

/** Return messages strictly after a display-position cursor in ascending order.
 *  `until`, when supplied, is an inclusive fixed snapshot head so a catch-up
 *  loop does not chase messages appended while it is running. */
export function getMessagesAfterPosition(
    db: Database,
    sessionId: string,
    limit: number,
    after: MessagePosition,
    until?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const untilClause = until
        ? `AND (
            COALESCE(invoked_at, created_at) < @untilAt
            OR (COALESCE(invoked_at, created_at) = @untilAt AND seq <= @untilSeq)
        )`
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          AND (
            COALESCE(invoked_at, created_at) > @afterAt
            OR (COALESCE(invoked_at, created_at) = @afterAt AND seq > @afterSeq)
          )
          ${untilClause}
        ORDER BY position_at ASC, seq ASC
        LIMIT @limit
    `).all({
        sessionId,
        afterAt: after.at,
        afterSeq: after.seq,
        untilAt: until?.at ?? null,
        untilSeq: until?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    return hydrateStoredMessages(db, rows)
}

export function getNewestMessagePosition(db: Database, sessionId: string): MessagePosition | null {
    const row = db.prepare(`
        SELECT COALESCE(invoked_at, created_at) AS position_at, seq
        FROM messages
        WHERE session_id = ?
        ORDER BY position_at DESC, seq DESC
        LIMIT 1
    `).get(sessionId) as { position_at: number; seq: number } | undefined
    return row ? { at: row.position_at, seq: row.seq } : null
}

export function getMessageEpoch(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT epoch FROM message_epochs WHERE session_id = ?'
    ).get(sessionId) as { epoch: number } | undefined
    return row?.epoch ?? 0
}

export function bumpMessageEpoch(db: Database, sessionId: string): number {
    db.prepare(`
        INSERT INTO message_epochs (session_id, epoch)
        VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `).run(sessionId)
    return getMessageEpoch(db, sessionId)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export function getUninvokedLocalMessages(
    db: Database,
    sessionId: string,
    options?: { deliverableOnly?: boolean }
): StoredMessage[] {
    const deliverableClause = options?.deliverableOnly ? " AND delivery_state = 'queued'" : ''
    const rows = db.prepare(
        `SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL${deliverableClause} ORDER BY seq ASC`
    ).all(sessionId) as DbMessageRow[]
    return hydrateStoredMessages(db, rows)
}

export type LocalMessageState = {
    localId: string
    invokedAt: number | null
    deliveryState?: string | null
}

export function getLocalMessageStates(
    db: Database,
    sessionId: string,
    localIds: string[]
): LocalMessageState[] {
    if (localIds.length === 0) {
        return []
    }
    const placeholders = localIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT local_id, invoked_at, delivery_state
        FROM messages
        WHERE session_id = ? AND local_id IN (${placeholders})
        ORDER BY seq ASC
    `).all(sessionId, ...localIds) as Array<{
        local_id: string
        invoked_at: number | null
        delivery_state: string | null
    }>
    return rows.map((row) => ({
        localId: row.local_id,
        invokedAt: row.invoked_at,
        ...(row.delivery_state && row.delivery_state !== 'queued'
            ? { deliveryState: row.delivery_state }
            : {})
    }))
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export function getMatureScheduledMessages(
    db: Database,
    beforeTime: number
): StoredMessage[] {
    const rows = db.prepare(
        "SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND invoked_at IS NULL AND delivery_state = 'queued' ORDER BY scheduled_at ASC"
    ).all(beforeTime) as DbMessageRow[]
    return hydrateStoredMessages(db, rows)
}

/** Returns immediate-queued local messages for a session — i.e. rows that have
 *  no scheduled_at (scheduled_at IS NULL).  Used by the session-end sweep
 *  (sweepImmediateQueuedOnSessionEnd): these are messages the user posted to a
 *  CLI session that ended before the runner consumed them, so they cannot ever
 *  be delivered and must be force-invoked to clear the floating bar.
 *
 *  Scheduled rows (scheduled_at IS NOT NULL) are *deliberately excluded*, mature
 *  or not.  The mature-scan path (releaseMatureScheduledMessages) is the sole
 *  emit channel for scheduled rows and it does not write invoked_at — the CLI
 *  ack does.  If the session-end sweep stamped a mature scheduled row as
 *  invoked, a subsequent CLI re-attach would never see the row in the
 *  mature-scan results (it filters on invoked_at IS NULL), and the user's
 *  scheduled prompt would be silently dropped.  See HAPI Bot R4 finding. */
export function getImmediateQueuedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND delivery_state = 'queued'
        ORDER BY seq ASC
    `).all(sessionId) as DbMessageRow[]
    return hydrateStoredMessages(db, rows)
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export function countMessages(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number } | undefined
    return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export function countFutureScheduledLocalMessages(
    db: Database,
    sessionId: string,
    now: number
): number {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
    `).get(sessionId, now) as { count: number } | undefined
    return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace. */
export function countFutureScheduledBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const counts = new Map<string, number>()
    if (sessionIds.length === 0) {
        return counts
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; count: number }[]

    for (const row of rows) {
        counts.set(row.session_id, row.count)
    }
    return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip). */
export function minFutureScheduledAtBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const nextAt = new Map<string, number>()
    if (sessionIds.length === 0) {
        return nextAt
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; next_at: number }[]

    for (const row of rows) {
        nextAt.set(row.session_id, row.next_at)
    }
    return nextAt
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

export type CancelQueuedMessageResult =
    | { status: 'cancelled'; localId: string | null }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'busy'; localId: string }

/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked). */
export function cancelQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): CancelQueuedMessageResult {
    return db.transaction(() => {
        // Accept either the server-assigned uuid (id) or the client localId.
        // This handles the pre-echo window where the web client still holds
        // msg.id === localId and passes that as the messageId parameter.
        // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
        // which is safe — messages without a localId are inserted with invoked_at set
        // and are never queued, so they cannot reach this code path anyway.
        const row = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

        if (!row) {
            // Row absent: already cancelled or wrong id — fold into 'cancelled'
            return { status: 'cancelled' as const, localId: null }
        }

        if (row.invoked_at !== null) {
            // CLI already consumed this message before the cancel arrived.
            // Return the full row so the web client can restore authoritative invoked state
            // rather than reverting to a stale queued snapshot (invokedAt: null).
            return { status: 'invoked' as const, message: hydrateStoredMessage(db, row) }
        }

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)

        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
        }

        return { status: 'cancelled' as const, localId: row.local_id }
    })()
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'dispatching'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'indeterminate'; localId: string | null; resolvedId: string; scheduledAt: number | null }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export function lookupQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): LookupQueuedMessageResult {
    const row = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1
    `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

    if (!row) {
        return { status: 'absent' as const }
    }

    if (row.invoked_at !== null) {
        return { status: 'invoked' as const, message: hydrateStoredMessage(db, row) }
    }

    if (row.delivery_state === 'dispatching') {
        return { status: 'dispatching' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }
    if (row.delivery_state === 'indeterminate') {
        return { status: 'indeterminate' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
/** Claim a durable unknown-delivery row for an explicit retry. */
export function claimIndeterminateMessage(
    db: Database,
    sessionId: string,
    messageId: string
): StoredMessage | null {
    return db.transaction(() => {
        const claimed = db.prepare(`
            UPDATE messages
            SET delivery_state = 'dispatching'
            WHERE session_id = ?
              AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'indeterminate'
        `).run(sessionId, messageId, messageId)
        if (claimed.changes === 0) return null
        const updated = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'dispatching'
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined
        return updated ? hydrateStoredMessage(db, updated) : null
    })()
}

export function deleteQueuedMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): boolean {
    return db.transaction(() => {
        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)
        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
            return true
        }
        return false
    })()
}

/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread. */
export function markMessagesInvoked(
    db: Database,
    sessionId: string,
    localIds: string[],
    invokedAt: number
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    return db.prepare(
        `UPDATE messages
         SET invoked_at = ?, delivery_state = 'queued'
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL`
    ).run(invokedAt, sessionId, ...localIds).changes
}

/** Move an uninvoked steer through its durable delivery states. */
export function setMessagesDeliveryState(
    db: Database,
    sessionId: string,
    localIds: string[],
    state: SteerDeliveryState
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    const fromStates = state === 'queued'
        ? "'dispatching', 'indeterminate'"
        : state === 'dispatching'
            ? "'queued', 'indeterminate'"
            : "'queued', 'dispatching'"
    return db.prepare(
        `UPDATE messages
         SET delivery_state = ?
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL
           AND delivery_state IN (${fromStates})`
    ).run(state, sessionId, ...localIds).changes
}

/** Hold an ambiguous steer out of automatic replay without claiming delivery. */
export function markMessagesIndeterminate(
    db: Database,
    sessionId: string,
    localIds: string[]
): number {
    return setMessagesDeliveryState(db, sessionId, localIds, 'indeterminate')
}

/** Settle immediate queued rows on an archived clear source without touching
 * scheduled rows, which must remain uninvoked for transfer to the replacement. */
export function markUninvokedImmediateMessages(
    db: Database,
    sessionId: string,
    invokedAt: number
): string[] {
    const rows = db.prepare(`
        SELECT local_id FROM messages
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND delivery_state = 'queued'
        ORDER BY seq ASC
    `).all(sessionId) as Array<{ local_id: string }>
    if (rows.length === 0) return []

    db.prepare(`
        UPDATE messages
        SET invoked_at = ?
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND delivery_state = 'queued'
    `).run(invokedAt, sessionId)
    return rows.map((row) => row.local_id)
}

/**
 * Reassign only uninvoked scheduled rows when an archived OpenCode session
 * is replaced by /clear. The transaction preserves ids/localIds so the normal
 * scheduled-message ack path continues on the replacement session.
 */
export function moveUninvokedScheduledMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): number {
    if (fromSessionId === toSessionId) return 0

    const rows = db.prepare(`
        SELECT id FROM messages
        WHERE session_id = ?
          AND scheduled_at IS NOT NULL
          AND invoked_at IS NULL
        ORDER BY seq ASC
    `).all(fromSessionId) as Array<{ id: string }>
    if (rows.length === 0) return 0

    try {
        db.exec('BEGIN')
        let nextSeq = getMaxSeq(db, toSessionId)
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) {
            nextSeq += 1
            update.run(toSessionId, nextSeq, row.id)
        }
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        db.exec('COMMIT')
        return rows.length
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Move every still-held prompt to a reserved replacement, preserving FIFO.
 * If both sessions already contain the same non-null localId, the replacement
 * row is authoritative (it represents the retry/new owner) and only the
 * uninvoked source duplicate is discarded.
 */
export function moveUninvokedMessages(db: Database, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0
    return db.transaction(() => {
        const discarded = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM messages AS target
                  WHERE target.session_id = ?
                    AND target.local_id = messages.local_id
              )
        `).run(fromSessionId, toSessionId).changes
        const rows = db.prepare(`
            SELECT id, session_id FROM messages
            WHERE session_id IN (?, ?) AND invoked_at IS NULL
            -- created_at is millisecond-granularity; rowid is the durable
            -- cross-session insertion order for ties within this database.
            ORDER BY created_at ASC,
                     rowid ASC,
                     seq ASC,
                     id ASC
        `).all(fromSessionId, toSessionId) as Array<{ id: string; session_id: string }>
        const moved = rows.filter((row) => row.session_id === fromSessionId).length
        if (discarded === 0 && moved === 0) return 0
        const invokedMax = db.prepare(`
            SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages
            WHERE session_id = ? AND invoked_at IS NOT NULL
        `).get(toSessionId) as { maxSeq: number }
        let nextSeq = invokedMax.maxSeq
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) update.run(toSessionId, ++nextSeq, row.id)
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        return discarded + moved
    })()
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
            db.prepare('UPDATE session_message_receipts SET position_seq = position_seq + ? WHERE session_id = ?')
                .run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            // Force-invoke the older copy: clearing local_id severs its ack path
            // (markMessagesInvoked matches by local_id), so leaving invoked_at
            // NULL would strand the row in the queued floating bar forever.
            // Use COALESCE so an already-invoked row keeps its server timestamp.
            db.prepare(
                `UPDATE messages
                 SET local_id = NULL,
                     invoked_at = COALESCE(invoked_at, created_at)
                 WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const sourceRows = db.prepare(
            'SELECT id, content, turn_id, stream_live FROM messages WHERE session_id = ?'
        ).all(fromSessionId) as Array<Pick<DbMessageRow, 'id' | 'content' | 'turn_id' | 'stream_live'>>
        const updateSourceRow = db.prepare(
            'UPDATE messages SET content = ?, stream_live = ?, turn_id = COALESCE(?, turn_id) WHERE id = ?'
        )
        const now = Date.now()
        const mergedTurnIds = new Set<string>()
        for (const row of sourceRows) {
            const decoded = decodeMessageContent(row.content)
            const sourceWasLive = row.stream_live === 1 || getLiveMessageStreamId(decoded) !== null
            const normalized = normalizeHistoryMessageContent(decoded)
            const canonicalized = canonicalizeLegacyTurnContent(normalized)
            const turnId = canonicalized.turnId ?? row.turn_id ?? null
            if (turnId) mergedTurnIds.add(turnId)
            updateSourceRow.run(encodeMessageContent(canonicalized.content), sourceWasLive ? 1 : 0, turnId, row.id)
        }
        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)
        for (const turnId of mergedTurnIds) {
            ensureClosedTurnTombstone(db, toSessionId, turnId, 'history', now, { scope: 'history' })
        }
        db.prepare(`
            INSERT INTO session_turns (
                session_id, turn_id, invocation_id, provider_turn_id, source_instance_id, source_generation,
                scope, start_order, status, outcome, cutoff_source, start_event_id, end_event_id, created_at, updated_at
            )
            SELECT
                @to_session_id,
                turn_id,
                invocation_id,
                provider_turn_id,
                source_instance_id,
                source_generation,
                'history',
                NULL,
                CASE WHEN status = 'running' THEN 'history' ELSE status END,
                outcome,
                cutoff_source,
                start_event_id,
                end_event_id,
                created_at,
                @now
            FROM session_turns
            WHERE session_id = @from_session_id
            ON CONFLICT(session_id, turn_id) DO NOTHING
        `).run({
            to_session_id: toSessionId,
            from_session_id: fromSessionId,
            now
        })
        db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(fromSessionId)
        db.prepare(`
            INSERT INTO session_message_receipts (
                session_id, event_id, kind, source_instance_id, source_generation,
                turn_id, transition, outcome, stream_id, committed_at, position_at, position_seq
            )
            SELECT
                @to_session_id,
                event_id,
                kind,
                source_instance_id,
                source_generation,
                turn_id,
                transition,
                outcome,
                stream_id,
                committed_at,
                position_at,
                position_seq
            FROM session_message_receipts
            WHERE session_id = @from_session_id
            ON CONFLICT(session_id, event_id) DO NOTHING
        `).run({
            to_session_id: toSessionId,
            from_session_id: fromSessionId
        })
        compactMessageStreams(db, toSessionId)
        db.prepare('UPDATE messages SET stream_live = 0 WHERE session_id = ? AND stream_live = 1').run(toSessionId)

        if (result.changes > 0) {
            bumpMessageEpoch(db, fromSessionId)
            bumpMessageEpoch(db, toSessionId)
        }

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Truncate transcript at/after the message with `localId`, optionally replacing
 * the removed suffix with `replacement` messages. Bumps message epoch so web
 * clients reset their window.
 */
export function truncateMessagesFromLocalId(
    db: Database,
    sessionId: string,
    localId: string,
    replacement: Array<{
        content: unknown
        localId?: string | null
        createdAt?: number
        invokedAt?: number | null
    }> = []
): { deleted: number; inserted: number; epoch: number } {
    return db.transaction(() => {
        const target = db.prepare(`
            SELECT id, seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ? AND local_id = ?
            LIMIT 1
        `).get(sessionId, localId) as { id: string; seq: number; position_at: number } | undefined

        if (!target) {
            throw new Error(`Message not found for localId: ${localId}`)
        }

        const affectedTurns = db.prepare(`
            SELECT DISTINCT turn_id FROM messages
            WHERE session_id = ?
              AND turn_id IS NOT NULL
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).all(sessionId, target.position_at, target.position_at, target.seq) as Array<{ turn_id: string }>

        db.prepare(`
            DELETE FROM session_message_receipts
            WHERE session_id = ?
              AND (
                  position_at > ?
                  OR (position_at = ? AND position_seq >= ?)
              )
        `).run(sessionId, target.position_at, target.position_at, target.seq)

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).run(sessionId, target.position_at, target.position_at, target.seq)

        const truncateNow = Date.now()
        for (const row of affectedTurns) {
            ensureClosedTurnTombstone(db, sessionId, row.turn_id, 'history', truncateNow, {
                scope: 'history',
                cutoffSource: 'truncate'
            })
        }
        db.prepare(`
            UPDATE sessions
            SET active_turn_id = (
                    SELECT turn_id FROM session_turns
                    WHERE session_id = @session_id AND status = 'running' AND scope = 'main'
                    ORDER BY COALESCE(start_order, 0) DESC, created_at DESC LIMIT 1
                ),
                lifecycle_state = CASE
                    WHEN EXISTS (
                        SELECT 1 FROM session_turns
                        WHERE session_id = @session_id AND status = 'running' AND scope = 'main'
                    ) THEN 'thinking'
                    ELSE 'idle'
                END
            WHERE id = @session_id
        `).run({ session_id: sessionId })

        let inserted = 0
        for (const message of replacement) {
            const now = Date.now()
            const msgSeqRow = db.prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
            ).get(sessionId) as { nextSeq: number }
            const id = randomUUID()
            const createdAt = message.createdAt ?? now
            const invokedAt = message.invokedAt === undefined ? createdAt : message.invokedAt
            const rowLocalId = message.localId ?? null
            const sourceWasLive = getLiveMessageStreamId(message.content) !== null
            const normalizedContent = normalizeHistoryMessageContent(message.content)
            const canonicalized = canonicalizeLegacyTurnContent(normalizedContent)
            const finalContent = canonicalized.content
            db.prepare(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                id,
                sessionId,
                encodeMessageContent(finalContent),
                createdAt,
                msgSeqRow.nextSeq,
                rowLocalId,
                invokedAt
            )
            indexMessageStream(db, sessionId, id, finalContent, {
                forceClosedTurnSettle: true,
                markTurnHistory: true,
                streamLiveOverride: sourceWasLive,
                now: createdAt
            })
            inserted += 1
        }

        const epoch = bumpMessageEpoch(db, sessionId)
        return { deleted: deleted.changes, inserted, epoch }
    })()
}

export type BindSessionSourceResult = SessionSourceBinding & {
    activeTurnId: string | null
    lifecycleState: SessionLifecycleState
    lifecycleChanged: boolean
    closedTurnIds: string[]
    finalizedMessages: StoredMessage[]
}

export function bindSessionSource(
    db: Database,
    sessionId: string,
    sourceInstanceId: string,
    now: number = Date.now(),
    namespace?: string
): BindSessionSourceResult {
    return db.transaction(() => {
        const resolvedNamespace = namespace ?? (
            db.prepare('SELECT namespace FROM sessions WHERE id = ? LIMIT 1').get(sessionId) as { namespace: string } | undefined
        )?.namespace ?? 'default'
        const existing = db.prepare(`
            SELECT * FROM session_sources WHERE session_id = ? AND source_instance_id = ? LIMIT 1
        `).get(sessionId, sourceInstanceId) as DbSessionSourceRow | undefined

        if (existing && existing.status === 'retired') {
            const currentSession = db.prepare(
                'SELECT active_turn_id, lifecycle_state FROM sessions WHERE id = ? LIMIT 1'
            ).get(sessionId) as { active_turn_id: string | null; lifecycle_state: SessionLifecycleState | null } | undefined
            return {
                sourceInstanceId,
                sourceGeneration: existing.generation,
                fenced: true,
                activeTurnId: currentSession?.active_turn_id ?? null,
                lifecycleState: currentSession?.lifecycle_state ?? 'idle',
                lifecycleChanged: false,
                closedTurnIds: [],
                finalizedMessages: []
            }
        }

        const otherActive = db.prepare(`
            SELECT source_instance_id FROM session_sources
            WHERE session_id = ? AND status = 'active' AND source_instance_id <> ?
        `).all(sessionId, sourceInstanceId) as Array<{ source_instance_id: string }>

        const replacedTurns = db.prepare(`
            SELECT turn_id FROM session_turns
            WHERE session_id = ? AND status = 'running' AND (source_instance_id IS NULL OR source_instance_id <> ?)
        `).all(sessionId, sourceInstanceId) as Array<{ turn_id: string }>
        const closedTurnIds = replacedTurns.map((row) => row.turn_id)

        if (otherActive.length > 0) {
            db.prepare(`
                UPDATE session_sources
                SET status = 'retired', updated_at = ?
                WHERE session_id = ? AND status = 'active' AND source_instance_id <> ?
            `).run(now, sessionId, sourceInstanceId)
        }
        if (closedTurnIds.length > 0) {
            db.prepare(`
                UPDATE session_turns
                SET status = 'cutoff', outcome = COALESCE(outcome, 'cutoff'), cutoff_source = 'source-replaced', updated_at = ?
                WHERE session_id = ? AND status = 'running' AND (source_instance_id IS NULL OR source_instance_id <> ?)
            `).run(now, sessionId, sourceInstanceId)
            bumpMessageEpoch(db, sessionId)
        }

        const finalizedMessages: StoredMessage[] = []
        for (const replacedTurnId of closedTurnIds) {
            finalizedMessages.push(...finalizeOpenLiveStreamsForSession(db, sessionId, replacedTurnId))
        }
        if (!existing && (otherActive.length > 0 || closedTurnIds.length === 0)) {
            finalizedMessages.push(...finalizeOpenLiveStreamsForSession(db, sessionId))
        }
        const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, resolvedNamespace)

        const generation = existing ? existing.generation : 1
        db.prepare(`
            INSERT INTO session_sources (session_id, source_instance_id, generation, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            ON CONFLICT(session_id, source_instance_id) DO UPDATE SET
                status = 'active',
                updated_at = excluded.updated_at
        `).run(sessionId, sourceInstanceId, generation, now, now)

        return {
            sourceInstanceId,
            sourceGeneration: generation,
            fenced: false,
            ...recomputed,
            closedTurnIds,
            finalizedMessages
        }
    })()
}

export function isSessionSourceAuthoritative(
    db: Database,
    sessionId: string,
    sourceInstanceId?: string | null,
    sourceGeneration?: number | null,
    options?: { allowUnbound?: boolean }
): boolean {
    if (!sourceInstanceId) {
        if (options?.allowUnbound === false) return false
        const anySource = db.prepare(`
            SELECT source_instance_id FROM session_sources
            WHERE session_id = ? LIMIT 1
        `).get(sessionId) as { source_instance_id: string } | undefined
        return !anySource
    }
    const row = db.prepare(`
        SELECT * FROM session_sources
        WHERE session_id = ? AND source_instance_id = ? LIMIT 1
    `).get(sessionId, sourceInstanceId) as DbSessionSourceRow | undefined
    return row?.status === 'active'
        && Number.isSafeInteger(sourceGeneration)
        && sourceGeneration === row.generation
}

export type RecordTurnLifecycleTransitionResult = {
    activeTurnId: string | null
    lifecycleState: SessionLifecycleState
    lifecycleChanged: boolean
    turnState: TurnState
    finalizedMessages: StoredMessage[]
    fenced: boolean
}

function recomputeSessionActiveTurnInTransaction(
    db: Database,
    sessionId: string,
    namespace: string,
    preferredClosedLifecycleState: 'idle' | 'completed' = 'idle'
): { activeTurnId: string | null; lifecycleState: SessionLifecycleState; lifecycleChanged: boolean } {
    const latestRunning = db.prepare(`
        SELECT turn_id FROM session_turns
        WHERE session_id = ? AND status = 'running' AND scope = 'main'
        ORDER BY COALESCE(start_order, 0) DESC, created_at DESC
        LIMIT 1
    `).get(sessionId) as { turn_id: string } | undefined

    const currentSession = db.prepare(`
        SELECT active_turn_id, lifecycle_state FROM sessions
        WHERE id = ? AND namespace = ? LIMIT 1
    `).get(sessionId, namespace) as { active_turn_id: string | null; lifecycle_state: SessionLifecycleState | null } | undefined

    const nextActiveTurnId = latestRunning?.turn_id ?? null
    const currentLifecycle = currentSession?.lifecycle_state ?? 'idle'
    const isRunningPhase = currentLifecycle === 'thinking'
        || currentLifecycle === 'tool-executing'
        || currentLifecycle === 'streaming-answer'
        || currentLifecycle === 'awaiting-permission'
    const nextLifecycleState: SessionLifecycleState = nextActiveTurnId
        ? (isRunningPhase ? currentLifecycle : 'thinking')
        : preferredClosedLifecycleState

    const result = db.prepare(`
        UPDATE sessions
        SET active_turn_id = @active_turn_id,
            lifecycle_state = @lifecycle_state
        WHERE id = @id
          AND namespace = @namespace
          AND (active_turn_id IS NOT @active_turn_id OR lifecycle_state IS NOT @lifecycle_state)
    `).run({
        id: sessionId,
        namespace,
        active_turn_id: nextActiveTurnId,
        lifecycle_state: nextLifecycleState
    })

    return {
        activeTurnId: nextActiveTurnId,
        lifecycleState: nextLifecycleState,
        lifecycleChanged: result.changes === 1
    }
}

export function recordTurnLifecycleEvent(
    db: Database,
    sessionId: string,
    namespace: string,
    event: TurnLifecycleEventPayload,
    now: number = Date.now(),
    receiptPosition?: { at: number; seq: number }
): RecordTurnLifecycleTransitionResult {
    return db.transaction(() => {
        const existingTurn = db.prepare(`
            SELECT * FROM session_turns WHERE session_id = ? AND turn_id = ? LIMIT 1
        `).get(sessionId, event.turnId) as DbSessionTurnRow | undefined

        const hasBoundSource = Boolean(
            db.prepare('SELECT 1 FROM session_sources WHERE session_id = ? LIMIT 1').get(sessionId)
        )
        const preHandshakeBlocked = Boolean(event.preHandshake && hasBoundSource)
        const sourceAuthoritative = !preHandshakeBlocked && isSessionSourceAuthoritative(
            db,
            sessionId,
            event.sourceInstanceId ?? null,
            event.sourceGeneration ?? null
        )

        if (event.scope === 'history' || preHandshakeBlocked || !sourceAuthoritative) {
            const closedStatus: Exclude<TurnState, 'running'> = event.scope === 'history'
                ? 'history'
                : 'cutoff'
            ensureClosedTurnTombstone(db, sessionId, event.turnId, closedStatus, now, {
                scope: event.scope,
                invocationId: event.invocationId ?? null,
                providerTurnId: event.providerTurnId ?? null,
                sourceInstanceId: event.sourceInstanceId ?? null,
                sourceGeneration: event.sourceGeneration ?? null,
                outcome: event.outcome ?? null,
                cutoffSource: preHandshakeBlocked ? 'pre-handshake' : (!sourceAuthoritative ? 'fenced-source' : null),
                startEventId: event.transition === 'started' ? event.eventId : null,
                endEventId: event.transition === 'finished' ? event.eventId : null
            })
            recordSessionMessageReceipt(db, sessionId, event.eventId, {
                kind: 'lifecycle',
                sourceInstanceId: event.sourceInstanceId ?? null,
                sourceGeneration: typeof event.sourceGeneration === 'number' && Number.isFinite(event.sourceGeneration)
                    ? Math.trunc(event.sourceGeneration)
                    : null,
                turnId: event.turnId,
                transition: event.transition,
                outcome: event.outcome ?? null,
                streamId: null
            }, now, receiptPosition)
            const finalizedMessages = finalizeOpenLiveStreamsForSession(db, sessionId, event.turnId)
            const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, namespace)
            return {
                ...recomputed,
                turnState: getSessionTurnStatus(db, sessionId, event.turnId) ?? closedStatus,
                finalizedMessages,
                fenced: !sourceAuthoritative || preHandshakeBlocked
            }
        }

        if (event.transition === 'started') {
            if (existingTurn && existingTurn.status !== 'running') {
                recordSessionMessageReceipt(db, sessionId, event.eventId, {
                    kind: 'lifecycle',
                    sourceInstanceId: event.sourceInstanceId ?? null,
                    sourceGeneration: typeof event.sourceGeneration === 'number' && Number.isFinite(event.sourceGeneration)
                        ? Math.trunc(event.sourceGeneration)
                        : null,
                    turnId: event.turnId,
                    transition: event.transition,
                    outcome: null,
                    streamId: null
                }, now, receiptPosition)
                const finalizedMessages = finalizeOpenLiveStreamsForSession(db, sessionId, event.turnId)
                const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, namespace)
                return {
                    ...recomputed,
                    turnState: existingTurn.status,
                    finalizedMessages,
                    fenced: false
                }
            }
            if (!existingTurn) {
                const nextOrderRow = db.prepare(`
                    SELECT COALESCE(MAX(start_order), 0) + 1 AS nextOrder
                    FROM session_turns
                    WHERE session_id = ?
                `).get(sessionId) as { nextOrder: number }
                db.prepare(`
                    INSERT INTO session_turns (
                        session_id, turn_id, invocation_id, provider_turn_id, source_instance_id, source_generation,
                        scope, start_order, status, outcome, cutoff_source, start_event_id, end_event_id, created_at, updated_at
                    ) VALUES (
                        @session_id, @turn_id, @invocation_id, @provider_turn_id, @source_instance_id, @source_generation,
                        @scope, @start_order, 'running', NULL, NULL, @start_event_id, NULL, @now, @now
                    )
                `).run({
                    session_id: sessionId,
                    turn_id: event.turnId,
                    invocation_id: event.invocationId ?? null,
                    provider_turn_id: event.providerTurnId ?? null,
                    source_instance_id: event.sourceInstanceId ?? null,
                    source_generation: event.sourceGeneration ?? null,
                    scope: event.scope,
                    start_order: nextOrderRow.nextOrder,
                    start_event_id: event.eventId,
                    now
                })
            }
            recordSessionMessageReceipt(db, sessionId, event.eventId, {
                kind: 'lifecycle',
                sourceInstanceId: event.sourceInstanceId ?? null,
                sourceGeneration: typeof event.sourceGeneration === 'number' && Number.isFinite(event.sourceGeneration)
                    ? Math.trunc(event.sourceGeneration)
                    : null,
                turnId: event.turnId,
                transition: event.transition,
                outcome: null,
                streamId: null
            }, now, receiptPosition)
            const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, namespace)
            return {
                ...recomputed,
                turnState: 'running' as const,
                finalizedMessages: [],
                fenced: false
            }
        }

        const terminalStatus: Exclude<TurnState, 'running'> = event.outcome === 'failed'
            ? 'failed'
            : event.outcome === 'aborted'
                ? 'aborted'
                : 'completed'

        ensureClosedTurnTombstone(db, sessionId, event.turnId, terminalStatus, now, {
            scope: event.scope,
            invocationId: event.invocationId ?? null,
            providerTurnId: event.providerTurnId ?? null,
            sourceInstanceId: event.sourceInstanceId ?? null,
            sourceGeneration: event.sourceGeneration ?? null,
            outcome: event.outcome ?? 'completed',
            cutoffSource: null,
            endEventId: event.eventId
        })
        recordSessionMessageReceipt(db, sessionId, event.eventId, {
            kind: 'lifecycle',
            sourceInstanceId: event.sourceInstanceId ?? null,
            sourceGeneration: typeof event.sourceGeneration === 'number' && Number.isFinite(event.sourceGeneration)
                ? Math.trunc(event.sourceGeneration)
                : null,
            turnId: event.turnId,
            transition: event.transition,
            outcome: event.outcome ?? 'completed',
            streamId: null
        }, now, receiptPosition)
        const finalizedMessages = finalizeOpenLiveStreamsForSession(db, sessionId, event.turnId)
        const preferredClosedLifecycleState = terminalStatus === 'completed' ? 'completed' : 'idle'
        const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, namespace, preferredClosedLifecycleState)
        return {
            ...recomputed,
            turnState: getSessionTurnStatus(db, sessionId, event.turnId) ?? terminalStatus,
            finalizedMessages,
            fenced: false
        }
    })()
}

export type CloseRunningTurnsForSessionResult = {
    activeTurnId: string | null
    lifecycleState: SessionLifecycleState
    lifecycleChanged: boolean
    closedTurnIds: string[]
    turnState: Exclude<TurnState, 'running'>
    finalizedMessages: StoredMessage[]
    nextSourceGeneration: number | null
}

export function closeRunningTurnsForSession(
    db: Database,
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
    const now = options.now ?? Date.now()
    const closedStatus: Exclude<TurnState, 'running'> = options.reason === 'session-abort' ? 'aborted' : 'cutoff'
    return db.transaction(() => {
        let nextSourceGeneration: number | null = null
        if (options.retireSource) {
            if (options.sourceInstanceId) {
                db.prepare(`
                    INSERT INTO session_sources (session_id, source_instance_id, generation, status, created_at, updated_at)
                    VALUES (?, ?, 1, 'retired', ?, ?)
                    ON CONFLICT(session_id, source_instance_id) DO UPDATE SET
                        status = 'retired',
                        updated_at = excluded.updated_at
                `).run(sessionId, options.sourceInstanceId, now, now)
            } else {
                db.prepare(`
                    UPDATE session_sources SET status = 'retired', updated_at = ?
                    WHERE session_id = ?
                `).run(now, sessionId)
            }
        } else if (options.bumpGeneration) {
            if (options.sourceInstanceId) {
                db.prepare(`
                    INSERT INTO session_sources (session_id, source_instance_id, generation, status, created_at, updated_at)
                    VALUES (?, ?, 2, 'active', ?, ?)
                    ON CONFLICT(session_id, source_instance_id) DO UPDATE SET
                        generation = session_sources.generation + 1,
                        updated_at = excluded.updated_at
                `).run(sessionId, options.sourceInstanceId, now, now)
                const row = db.prepare(`
                    SELECT generation FROM session_sources WHERE session_id = ? AND source_instance_id = ? LIMIT 1
                `).get(sessionId, options.sourceInstanceId) as { generation: number } | undefined
                nextSourceGeneration = row?.generation ?? null
            } else {
                db.prepare(`
                    UPDATE session_sources
                    SET generation = generation + 1, updated_at = ?
                    WHERE session_id = ? AND status = 'active'
                `).run(now, sessionId)
            }
        }

        const requestedTurnIds = options.turnIds
            ? Array.from(new Set(options.turnIds.map((id) => id.trim()).filter((id) => id.length > 0)))
            : null

        const closedTurnIds: string[] = []
        if (requestedTurnIds) {
            for (const targetTurnId of requestedTurnIds) {
                ensureClosedTurnTombstone(db, sessionId, targetTurnId, closedStatus, now, {
                    scope: 'main',
                    sourceInstanceId: options.sourceInstanceId ?? null,
                    outcome: closedStatus,
                    cutoffSource: options.reason
                })
                closedTurnIds.push(targetTurnId)
            }
            if (closedTurnIds.length > 0) {
                bumpMessageEpoch(db, sessionId)
            }
        } else {
            const currentActiveTurnId = (
                db.prepare('SELECT active_turn_id FROM sessions WHERE id = ? LIMIT 1').get(sessionId) as { active_turn_id: string | null } | undefined
            )?.active_turn_id ?? null
            const runningTurns = db.prepare(`
                SELECT turn_id FROM session_turns
                WHERE session_id = ? AND status = 'running'
            `).all(sessionId) as Array<{ turn_id: string }>
            for (const row of runningTurns) {
                closedTurnIds.push(row.turn_id)
            }
            if (currentActiveTurnId && !closedTurnIds.includes(currentActiveTurnId)) {
                ensureClosedTurnTombstone(db, sessionId, currentActiveTurnId, closedStatus, now, {
                    scope: 'main',
                    sourceInstanceId: options.sourceInstanceId ?? null,
                    outcome: closedStatus,
                    cutoffSource: options.reason
                })
                closedTurnIds.push(currentActiveTurnId)
            }
            if (runningTurns.length > 0) {
                db.prepare(`
                    UPDATE session_turns
                    SET status = @status,
                        outcome = COALESCE(outcome, @status),
                        cutoff_source = @cutoff_source,
                        updated_at = @now
                    WHERE session_id = @session_id AND status = 'running'
                `).run({
                    session_id: sessionId,
                    status: closedStatus,
                    cutoff_source: options.reason,
                    now
                })
            }
            if (closedTurnIds.length > 0) {
                bumpMessageEpoch(db, sessionId)
            }
        }

        const finalizedMessages: StoredMessage[] = []
        if (requestedTurnIds) {
            for (const targetTurnId of closedTurnIds) {
                finalizedMessages.push(...finalizeOpenLiveStreamsForSession(db, sessionId, targetTurnId))
            }
        } else {
            finalizedMessages.push(...finalizeOpenLiveStreamsForSession(db, sessionId))
        }
        const recomputed = recomputeSessionActiveTurnInTransaction(db, sessionId, namespace)
        return {
            ...recomputed,
            closedTurnIds,
            turnState: closedStatus,
            finalizedMessages,
            nextSourceGeneration
        }
    })()
}

export function getRunningTurnIdsForSession(
    db: Database,
    sessionId: string,
    sourceInstanceId?: string | null
): string[] {
    if (typeof sourceInstanceId === 'string' && sourceInstanceId.trim().length > 0) {
        const rows = db.prepare(`
            SELECT turn_id FROM session_turns
            WHERE session_id = ? AND status = 'running' AND source_instance_id = ?
            ORDER BY COALESCE(start_order, 0) ASC, created_at ASC
        `).all(sessionId, sourceInstanceId.trim()) as Array<{ turn_id: string }>
        return rows.map((row) => row.turn_id)
    }
    const rows = db.prepare(`
        SELECT turn_id FROM session_turns
        WHERE session_id = ? AND status = 'running'
        ORDER BY COALESCE(start_order, 0) ASC, created_at ASC
    `).all(sessionId) as Array<{ turn_id: string }>
    return rows.map((row) => row.turn_id)
}
