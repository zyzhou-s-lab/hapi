import type { ClientToServerEvents, MessageAck, SessionLifecycleState } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { CopilotAgentMode } from '@hapi/protocol'
import type { AgentState, CodexCollaborationMode, Metadata, PermissionMode } from '@hapi/protocol/types'
import { getLiveMessageStreamId, getMessageSourceAuthority, getTurnLifecycleEvent, isRedundantGoalStatusEventContent, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Store, StoredSession, StoredMessage } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { TodosSchema } from '../../../sync/todos'
import { applyTodoMessageContent } from '../../../fork-features/task-panel/taskProjection'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import { extractBackgroundTaskDelta, extractBackgroundTasksSnapshot } from '../../../sync/backgroundTasks'
import { shouldRecordSessionActivity } from '../../../sync/sessionActivity'
import type { CliSocketWithData } from '../../socketTypes'
import type { SessionEndReason } from '@hapi/protocol'
import type { AccessErrorReason, AccessResult } from './types'
import { writeStoredGeneratedImage } from '../../../generatedImages/storage'
import { getHapiHomeDir } from '../../../scratchlistAttachments/storage'
import { MAX_GENERATED_IMAGE_BYTES } from '../../socketLimits'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
    sourceInstanceId?: string
    sourceGeneration?: number
}

type SessionEndPayload = Parameters<ClientToServerEvents['session-end']>[0]

type SessionReadyPayload = Parameters<ClientToServerEvents['session-ready']>[0]

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional(),
    // Client-provided origin timestamp (epoch ms) — e.g. a Claude transcript
    // entry's own `timestamp`. Only honored for agent messages (no localId);
    // see addMessage in messages.ts.
    createdAt: z.number().optional()
})

const generatedImageUploadSchema = z.object({
    sid: z.string().min(1),
    imageId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    content: z.string().max(Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4)
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

const HUB_OWNED_METADATA_KEYS = ['supersededBySessionId', 'opencodeClearOperation'] as const

function preserveHubOwnedMetadata(incoming: unknown, current: unknown): unknown {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
    const next = { ...(incoming as Record<string, unknown>) }
    const existing = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}
    for (const key of HUB_OWNED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
        else delete next[key]
    }
    return next
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onBackgroundTaskCount?: (sessionId: string, count: number) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    /** Delegates session-end immediate-queue sweep to the MessageService layer. */
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    /** Drops the queued-thinking grace so synchronous CLI handlers (e.g. slash
     *  commands) don't leave the spinner stuck for the full grace window. */
    onMessagesConsumed?: (sessionId: string) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionReady, onSessionEnd, onWebappEvent, onBackgroundTaskDelta, onBackgroundTaskCount, onSessionActivity, onSweepImmediateQueued, onMessagesConsumed } = deps

    const publishMessage = (sid: string, msg: StoredMessage): void => {
        const message = {
            id: msg.id,
            seq: msg.seq,
            createdAt: msg.createdAt,
            localId: msg.localId,
            content: msg.content,
            invokedAt: msg.invokedAt,
            ...(msg.turnId ? { turnId: msg.turnId } : {}),
            ...(msg.turnState ? { turnState: msg.turnState } : {}),
            ...(msg.toolStates ? { toolStates: msg.toolStates } : {}),
            ...((msg.turnPhase ?? msg.phase) ? { phase: msg.turnPhase ?? msg.phase } : {}),
            ...(msg.lifecycleState ? { lifecycleState: msg.lifecycleState } : {})
        }
        socket.to(`session:${sid}`).emit('update', {
            id: randomUUID(), seq: msg.seq, createdAt: Date.now(),
            body: { t: 'new-message', sid, message }
        })
        onWebappEvent?.({ type: 'message-received', sessionId: sid, message })
    }

    const publishLifecycle = (sid: string, state: { activeTurnId: string | null; lifecycleState: SessionLifecycleState }): void => {
        onWebappEvent?.({
            type: 'session-updated', sessionId: sid,
            data: {
                activeTurnId: state.activeTurnId,
                lifecycleState: state.lifecycleState,
                thinking: state.activeTurnId !== null,
                ...(state.activeTurnId === null ? { activeTurnStartedAt: null } : {})
            }
        })
    }

    socket.on('session-source-bind', (data, ack) => {
        const parsed = z.object({ sid: z.string().min(1), sourceInstanceId: z.string().trim().min(1) }).safeParse(data)
        if (!parsed.success) {
            ack?.({ ok: false, sourceInstanceId: '', sourceGeneration: 0, reason: 'invalid-payload' })
            return
        }
        const { sid, sourceInstanceId } = parsed.data
        const access = resolveSessionAccess(sid)
        if (!access.ok) {
            ack?.({ ok: false, sourceInstanceId, sourceGeneration: 0, reason: access.reason })
            return
        }
        const bound = store.messages.bindSessionSource(sid, sourceInstanceId, Date.now(), access.value.namespace)
        for (const msg of bound.finalizedMessages) publishMessage(sid, msg)
        if (bound.lifecycleChanged) publishLifecycle(sid, bound)
        ack?.({ ok: !bound.fenced, sourceInstanceId, sourceGeneration: bound.sourceGeneration, fenced: bound.fenced })
    })

    socket.on('message', (data: unknown, ack?: (response: MessageAck) => void) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            ack?.({ ok: false, reason: 'invalid-payload' })
            return
        }

        const { sid, localId, createdAt } = parsed.data
        const raw = parsed.data.message

        const content = typeof raw === 'string'
            ? (() => {
                try {
                    return JSON.parse(raw) as unknown
                } catch {
                    return raw
                }
            })()
            : raw

        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            ack?.({ ok: false, eventId: localId, reason: sessionAccess.reason })
            return
        }
        const session = sessionAccess.value

        const lifecycle = getTurnLifecycleEvent(content)
        const record = unwrapRoleWrappedRecordEnvelope(content)
        const authority = getMessageSourceAuthority(content)
        const isAgent = record?.role === 'agent'
        const receipt = localId && isAgent
            ? store.messages.checkSessionMessageReceipt(sid, localId, store.messages.buildMessageReceiptInfo(content))
            : 'absent'
        const committed = (): void => ack?.({
            ok: true, eventId: localId, committed: true,
            ...(authority.sourceGeneration !== null ? { sourceGeneration: authority.sourceGeneration } : {})
        })
        if (receipt === 'matched') {
            committed()
            return
        }
        if (receipt === 'conflict' || (lifecycle && localId !== lifecycle.eventId)) {
            ack?.({ ok: false, eventId: localId, reason: 'invalid-payload' })
            return
        }
        if (isAgent && !store.messages.isSessionSourceAuthoritative(sid, authority.sourceInstanceId, authority.sourceGeneration)) {
            ack?.({ ok: false, eventId: localId, reason: 'fenced-source' })
            return
        }
        if (isRedundantGoalStatusEventContent(content)) {
            committed()
            return
        }
        const bgSnapshot = extractBackgroundTasksSnapshot(content)
        if (bgSnapshot !== null) {
            onBackgroundTaskCount?.(sid, bgSnapshot.length)
            committed()
            return
        }

        const result = lifecycle && localId
            ? store.messages.addLifecycleMessage(sid, session.namespace, content, lifecycle, localId, createdAt)
            : null
        const msg = result?.message ?? store.messages.addMessage(sid, content, localId, undefined, createdAt)
        committed()
        if (result) {
            for (const finalized of result.transition.finalizedMessages) publishMessage(sid, finalized)
            publishMessage(sid, msg)
            if (result.transition.lifecycleChanged) publishLifecycle(sid, result.transition)
            return
        }

        const liveSnapshot = getLiveMessageStreamId(content) !== null
        // A rejected provisional row must not replay the authoritative final's side effects.
        if (liveSnapshot && getLiveMessageStreamId(msg.content) === null) return

        if (!liveSnapshot && shouldRecordSessionActivity(content)) {
            onSessionActivity?.(sid, msg.createdAt)
        }

        const storedSession = store.sessions.getSession(sid)
        const storedTodos = storedSession?.todos
        const parsedTodos = TodosSchema.safeParse(storedTodos)
        const nextTodos = liveSnapshot ? null : applyTodoMessageContent(parsedTodos.success ? parsedTodos.data : null, content)
        if (nextTodos) {
            // Two results can share a millisecond. The watermark is also the
            // SSE version, so an equal stamp would both lose the store write
            // and let a client drop the second patch. An earlier stamp is a
            // late message and must not replace the newer list.
            const previousWatermark = storedSession?.todosUpdatedAt ?? null
            const newerOrSame = previousWatermark === null || msg.createdAt >= previousWatermark
            const todoVersion = previousWatermark !== null && msg.createdAt === previousWatermark
                ? previousWatermark + 1
                : msg.createdAt
            const updated = newerOrSame
                ? store.sessions.setSessionTodos(sid, nextTodos, todoVersion, session.namespace)
                : false
            if (updated) {
                const stored = store.sessions.getSession(sid)
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        todos: {
                            version: stored?.todosUpdatedAt ?? todoVersion,
                            value: nextTodos
                        },
                        updatedAt: stored?.updatedAt ?? todoVersion
                    }
                })
            }
        }

        const teamDelta = liveSnapshot ? null : extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSession(sid)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            const updated = store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
            if (updated) {
                const stored = store.sessions.getSession(sid)
                // Versioned clear: value null = TeamDelete. Consumers gate on
                // version (store team_state_updated_at) so dual SSE cannot
                // resurrect a deleted team from a lagged older event.
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        teamState: {
                            version: stored?.teamStateUpdatedAt ?? msg.createdAt,
                            value: newTeamState
                        },
                        updatedAt: stored?.updatedAt ?? msg.createdAt
                    }
                })
            }
        }

        const bgDelta = liveSnapshot ? null : extractBackgroundTaskDelta(content)
        if (bgDelta) {
            onBackgroundTaskDelta?.(sid, bgDelta)
        }
        publishMessage(sid, msg)
        if (msg.turnId && msg.turnState === 'running' && session.activeTurnId === msg.turnId) {
            const nextPhase = (msg.turnPhase ?? msg.phase) === 'final_answer' ? 'streaming-answer' : 'thinking'
            if (store.sessions.setSessionLifecycle(sid, msg.turnId, nextPhase, session.namespace)) {
                publishLifecycle(sid, { activeTurnId: msg.turnId, lifecycleState: nextPhase })
            }
        }
    })

    socket.on('generated-image:upload', async (data: unknown) => {
        const parsed = generatedImageUploadSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sid, imageId, fileName, mimeType, content } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            return
        }

        const bytes = Buffer.from(content, 'base64')
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
            return
        }

        await writeStoredGeneratedImage(
            getHapiHomeDir(),
            sessionAccess.value.namespace,
            imageId,
            { fileName, mimeType, bytes }
        ).catch(() => {})
    })

    const handleUpdateMetadata: UpdateMetadataHandler = (data, cb) => {
        const parsed = updateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, metadata, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionMetadata(
            sid,
            preserveHubOwnedMetadata(metadata, sessionAccess.value.metadata),
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, metadata: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    // Broadcast the persisted (merged) value, not the pre-merge
                    // payload — otherwise other CLIs in the session room would
                    // overwrite their local cache with a tokenless metadata
                    // snapshot even though the DB row was preserved.
                    // See store.sessions.mergeSessionMetadata for the merge
                    // contract.
                    metadata: { version: result.version, value: result.value },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                // The unknown-cast here mirrors the schema's MetadataSchema.nullable()
                // shape: the store returns raw JSON, the wire schema parses it on
                // both ends. Keeping the broadcast shape identical to the socket.io
                // `update-session` body (line ~213) lets the same patch travel
                // through both fan-out channels without divergence.
                data: {
                    metadata: { version: result.version, value: result.value as Metadata | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-metadata', handleUpdateMetadata)

    const handleUpdateState: UpdateStateHandler = (data, cb) => {
        const parsed = updateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, agentState, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionAgentState(
            sid,
            agentState,
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, agentState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: null,
                    agentState: { version: result.version, value: agentState }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                data: {
                    agentState: { version: result.version, value: agentState as AgentState | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-state', handleUpdateState)

    socket.on('session-alive', (data: SessionAlivePayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        if (!store.messages.isSessionSourceAuthoritative(data.sid, data.sourceInstanceId, data.sourceGeneration)) return
        onSessionAlive?.(data)
    })

    socket.on('session-ready', (data: SessionReadyPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        if (!store.messages.isSessionSourceAuthoritative(data.sid, data.sourceInstanceId, data.sourceGeneration)) return
        onSessionReady?.(data)
    })

    socket.on('messages-consumed', (data: { sid: string; localIds: string[]; clearQueuedThinkingGrace?: boolean; steered?: boolean }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        const invokedAt = Date.now()
        let sessionUpdatedAt: number
        try {
            sessionUpdatedAt = store.recordMessagesConsumed(
                data.sid,
                localIds,
                invokedAt,
                sessionAccess.value.namespace
            )
        } catch (err) {
            console.error('recordMessagesConsumed failed', err)
            return
        }

        try {
            onSessionActivity?.(data.sid, sessionUpdatedAt)
        } catch (err) {
            console.error('onSessionActivity failed', err)
        }

        // Only drop the queued-thinking grace when the CLI explicitly opts in
        // (synchronous handlers like slash commands that will never send
        // their own `thinking=true` keepalive). Normal queue drains still
        // need the grace so the spinner doesn't flicker between the queue
        // shift and `backend.prompt` start.
        if (data.clearQueuedThinkingGrace === true) {
            onMessagesConsumed?.(data.sid)
        }
        // Emit only after the DB transaction succeeds. This is an ACK-level
        // batch contract, so preserve its original timestamp even when IDs are
        // heterogeneous, replayed, or unknown. `steered` is a live-only signal
        // (never persisted) that marks mid-turn delivery for the web badge.
        onWebappEvent?.({ type: 'messages-consumed', sessionId: data.sid, localIds, invokedAt, ...(data.steered === true ? { steered: true } : {}) })
    })

    socket.on('messages-indeterminate', (data: { sid: string; localIds: string[] }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) return
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        try {
            store.recordMessagesIndeterminate(data.sid, localIds, sessionAccess.value.namespace)
        } catch (err) {
            console.error('recordMessagesIndeterminate failed', err)
            return
        }
        onWebappEvent?.({ type: 'messages-indeterminate', sessionId: data.sid, localIds })
    })

    socket.on('messages-steer-state', (
        data: { sid: string; localIds: string[]; state: 'queued' | 'dispatching' },
        ack?: (response: { ok: boolean }) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)
            || (data.state !== 'queued' && data.state !== 'dispatching')) {
            reply({ ok: false })
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            reply({ ok: false })
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        try {
            const ok = store.recordSteerDeliveryState(
                data.sid,
                localIds,
                data.state,
                sessionAccess.value.namespace
            )
            reply({ ok })
            if (ok && data.state === 'queued') {
                onWebappEvent?.({ type: 'messages-requeued', sessionId: data.sid, localIds })
            }
        } catch (err) {
            console.error('recordSteerDeliveryState failed', err)
            reply({ ok: false })
        }
    })

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        if (!store.messages.isSessionSourceAuthoritative(data.sid, data.sourceInstanceId, data.sourceGeneration)) return

        // Force-invoke only immediate-queued messages (scheduled_at IS NULL) at
        // session end.  *All* scheduled rows — mature or future — are deliberately
        // preserved in DB so the mature-scan path (releaseMatureScheduledMessages)
        // remains the sole emit channel and the CLI ack remains the sole writer of
        // invoked_at.  See HAPI Bot R4: stamping a mature scheduled row here would
        // make the next mature-scan tick skip it (filter on invoked_at IS NULL) and
        // silently drop the user's prompt.
        //
        // Without this sweep for immediate rows, the floating bar would pin queued
        // rows after the CLI exits — there is no longer an ack path, so they would
        // stay queued forever.  The 5-second tick in syncEngine.expireInactive
        // emits scheduled rows when they mature, regardless of session end.
        if (data.reason !== 'cleared') {
            try {
                onSweepImmediateQueued?.(data.sid, Date.now())
            } catch (err) {
                console.error('session-end sweep failed', err)
            }
        }

        onSessionEnd?.(data)
    })
}
