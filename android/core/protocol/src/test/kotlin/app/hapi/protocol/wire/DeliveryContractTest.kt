package app.hapi.protocol.wire

import app.hapi.protocol.chat.normalizeDecryptedMessage
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolCompletionSource
import app.hapi.protocol.chat.ToolState
import app.hapi.protocol.chat.reduceChatBlocks
import app.hapi.protocol.patch.applySessionDetailPatch
import app.hapi.protocol.patch.isRenderIrrelevantSessionPatch
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.window.asWindowMessage
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class DeliveryContractTest {
    private fun messageJson(id: String, seq: Int): String = """
        {"id":"$id","seq":$seq,"localId":"local-$id","createdAt":1000,"invokedAt":null,
         "turnId":"delivery-turn","turnState":"cutoff","phase":"final_answer","lifecycleState":"settled",
         "content":{"role":"agent","meta":{"turnId":"envelope-turn"},
                    "content":{"type":"codex","data":{"type":"message","id":"stream-id","message":"answer","live":true}}}}
    """.trimIndent()

    @Test
    fun `REST and SSE identity survives window copies snapshot and normalization`() {
        val response = HapiJson.decodeFromString(MessagesResponse.serializer(), """
            {"messages":[${messageJson("rest-1", 1)}],
             "page":{"direction":"latest","limit":20,"epoch":0,"reset":false,"hasMore":false}}
        """)
        val event = assertIs<SyncEvent.MessageReceived>(SyncEvents.parse("""
            {"type":"message-received","sessionId":"s-1","message":${messageJson("sse-1", 2)}}
        """))
        for (message in response.messages + event.message) {
            assertEquals("delivery-turn", message.turnId)
            assertEquals("cutoff", message.turnState)
            assertEquals("final_answer", message.phase)
            assertEquals("settled", message.lifecycleState)
            val encoded = HapiJson.encodeToString(DecryptedMessage.serializer(), message)
            assertEquals(message, HapiJson.decodeFromString(DecryptedMessage.serializer(), encoded))
        }
        var state = MessageWindowLogic.applyLatestResponse(
            MessageWindowLogic.createState("s-1"),
            responseMessages = response.messages.map { it.asWindowMessage().copy(status = MessageStatus.Sending).withInvokedAt(1500) },
            page = response.page,
            replaceServerRows = true,
            requestBaseline = emptyMap(),
        )
        state = MessageWindowLogic.ingestIncoming(
            state,
            incoming = listOf(event.message.asWindowMessage().copy(status = MessageStatus.Sending).withInvokedAt(1500)),
        )
        val snapshotJson = HapiJson.encodeToString(PersistedMessageWindow.serializer(), MessageWindowLogic.toPersisted(state))
        val snapshot = HapiJson.decodeFromString(PersistedMessageWindow.serializer(), snapshotJson)
        val restored = MessageWindowLogic.hydrate("s-1", snapshot)
        assertEquals(2, restored.messages.size)
        for (row in restored.messages) {
            assertEquals("delivery-turn", row.turnId)
            assertEquals("cutoff", row.turnState)
            assertEquals("final_answer", row.phase)
            assertEquals("settled", row.lifecycleState)
            assertEquals(MessageStatus.Sent, row.status)
            assertEquals("delivery-turn", row.wire.turnId)
            assertEquals("cutoff", row.wire.turnState)
            assertEquals("final_answer", row.wire.phase)
            assertEquals("settled", row.wire.lifecycleState)
            val normalized = assertNotNull(normalizeDecryptedMessage(row.wire))
            assertEquals("delivery-turn", normalized.turnId)
            assertEquals("cutoff", normalized.turnState)
        }
    }

    @Test
    fun `absent delivery fields stay absent and unknown strings round trip`() {
        val legacy = HapiJson.decodeFromString(DecryptedMessage.serializer(), """
            {"id":"legacy","createdAt":1,"content":{"role":"user","content":"hello"}}
        """)
        val encoded = HapiJson.encodeToJsonElement(DecryptedMessage.serializer(), legacy).jsonObject
        assertFalse(encoded.containsKey("turnId"))
        assertFalse(encoded.containsKey("turnState"))
        assertFalse(encoded.containsKey("phase"))
        assertFalse(encoded.containsKey("lifecycleState"))
        val snapshotJson = HapiJson.encodeToString(
            PersistedMessageWindow.serializer(),
            PersistedMessageWindow(messages = listOf(legacy.asWindowMessage())),
        )
        val snapshot = HapiJson.decodeFromString(PersistedMessageWindow.serializer(), snapshotJson)
        val row = MessageWindowLogic.hydrate("s", snapshot).messages.single()
        assertNull(row.turnId)
        assertNull(row.turnState)
        assertNull(row.phase)
        assertNull(row.lifecycleState)
        val normalizedLegacy = assertNotNull(normalizeDecryptedMessage(row.wire))
        assertNull(normalizedLegacy.turnId)
        assertNull(normalizedLegacy.turnState)
        val future = DecryptedMessage(
            id = "future",
            createdAt = 1,
            turnId = " raw-id ",
            turnState = "future-turn-state",
            phase = "future-phase",
            lifecycleState = "future-state",
        )
        val futureJson = HapiJson.encodeToString(WindowMessage.serializer(), future.asWindowMessage().copy(status = MessageStatus.Queued).withInvokedAt(2))
        val futureRow = HapiJson.decodeFromString(WindowMessage.serializer(), futureJson)
        assertEquals(" raw-id ", futureRow.turnId)
        assertEquals("future-turn-state", futureRow.turnState)
        assertEquals("future-phase", futureRow.phase)
        assertEquals("future-state", futureRow.lifecycleState)
    }

    @Test
    fun `normalization only uses delivery or canonical envelope turn identity`() {
        val payloads = listOf(
            "42",
            """{"role":"user","content":"hello","meta":{"turnId":"canonical"}}""",
            """{"role":"user","content":42,"meta":{"turnId":"canonical"}}""",
            """{"role":"agent","content":{"type":"codex","data":{"type":"message","message":"answer"}},"meta":{"turnId":"canonical"}}""",
            """{"role":"agent","content":{"type":"event","data":{"type":"ready"}},"meta":{"turnId":"canonical"}}""",
            """{"role":"agent","content":42,"meta":{"turnId":"canonical"}}""",
            """{"role":"future","content":42,"meta":{"turnId":"canonical"}}""",
        )
        for (payload in payloads) {
            val content = HapiJson.parseToJsonElement(payload)
            val delivered = DecryptedMessage(id = "uuid-is-not-turn-id", content = content, createdAt = 1, turnId = "delivery")
            assertEquals("delivery", assertNotNull(normalizeDecryptedMessage(delivered)).turnId)
            val legacy = delivered.copy(turnId = null)
            assertEquals(if (payload == "42") null else "canonical", assertNotNull(normalizeDecryptedMessage(legacy)).turnId)
        }
        val wrapped = HapiJson.parseToJsonElement("""{"payload":{"message":{"role":"user","content":"hello","meta":{"turnId":" canonical "}}}}""")
        assertEquals("canonical", assertNotNull(normalizeDecryptedMessage(DecryptedMessage(id = "m", content = wrapped, createdAt = 1))).turnId)
        val providerOnly = HapiJson.parseToJsonElement("""{"role":"agent","meta":{"turn_id":"wrong"},"content":{"type":"output","data":{"type":"assistant","uuid":"not-a-turn","turnId":"wrong","turn_id":"wrong","message":{"content":"answer","turnId":"wrong"}}}}""")
        assertNull(assertNotNull(normalizeDecryptedMessage(DecryptedMessage(id = "uuid-is-not-turn-id", content = providerOnly, createdAt = 1))).turnId)
    }

    @Test
    fun `session lifecycle patch applies and null clears without inference`() {
        val legacy = HapiJson.decodeFromString(Session.serializer(), """
            {"id":"s","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,
             "active":false,"activeAt":0,"metadataVersion":0,"agentStateVersion":0,
             "thinking":false,"thinkingAt":0,"activeTurnStartedAt":99}
        """)
        assertNull(legacy.activeTurnId)
        assertNull(legacy.lifecycleState)
        val event = assertIs<SyncEvent.SessionUpdated>(SyncEvents.parse("""
            {"type":"session-updated","sessionId":"s","data":{"activeTurnId":"turn-1","lifecycleState":"streaming-answer","activeTurnStartedAt":123}}
        """))
        val patch = assertNotNull(SessionPatches.parse(event.data))
        assertFalse(isRenderIrrelevantSessionPatch(legacy, patch))
        val applied = assertNotNull(applySessionDetailPatch(legacy, patch))
        assertEquals("turn-1", applied.activeTurnId)
        assertEquals("streaming-answer", applied.lifecycleState)
        assertEquals(99L, applied.activeTurnStartedAt)
        assertFalse(applied.active)
        assertFalse(applied.thinking)
        assertNull(applySessionDetailPatch(applied, patch))
        assertEquals(applied, HapiJson.decodeFromString(Session.serializer(), HapiJson.encodeToString(Session.serializer(), applied)))
        val lifecycleOnly = assertNotNull(SessionPatches.parse(HapiJson.parseToJsonElement("""{"lifecycleState":"future-state"}""")))
        assertEquals(OptionalField.Absent, lifecycleOnly.activeTurnId)
        val unchangedTurn = assertNotNull(applySessionDetailPatch(applied, lifecycleOnly))
        assertEquals("turn-1", unchangedTurn.activeTurnId)
        assertEquals("future-state", unchangedTurn.lifecycleState)
        val clear = assertNotNull(SessionPatches.parse(HapiJson.parseToJsonElement("""{"activeTurnId":null,"lifecycleState":"idle"}""")))
        assertEquals(OptionalField.Present<String?>(null), clear.activeTurnId)
        val cleared = assertNotNull(applySessionDetailPatch(unchangedTurn, clear))
        assertNull(cleared.activeTurnId)
        assertEquals("idle", cleared.lifecycleState)
        assertEquals(99L, cleared.activeTurnStartedAt)
        val absent = assertNotNull(SessionPatches.parse(HapiJson.parseToJsonElement("""{"updatedAt":3}""")))
        assertEquals(OptionalField.Absent, absent.activeTurnId)
        assertNull(absent.lifecycleState)
        val preserved = assertNotNull(applySessionDetailPatch(applied, absent))
        assertEquals("turn-1", preserved.activeTurnId)
        assertEquals("streaming-answer", preserved.lifecycleState)
    }

    @Test
    fun `session patch still rejects invalid types null lifecycle and unknown keys`() {
        for (json in listOf(
            """{"activeTurnId":1}""",
            """{"lifecycleState":null}""",
            """{"lifecycleState":true}""",
            """{"activeTurnId":"t","lifecycleState":"idle","unknown":true}""",
        )) {
            assertNull(SessionPatches.parse(HapiJson.parseToJsonElement(json)), json)
        }
    }

    @Test
    fun `canonical turn closure reconciles owned tool cutoff and preserves unresolved cases`() {
        fun reduce(rawMessages: List<DecryptedMessage>): Map<String, ChatToolCall> {
            val normalized = rawMessages.mapNotNull { normalizeDecryptedMessage(it) }
            val reduced = reduceChatBlocks(normalized, agentState = null)
            return reduced.blocks.filterIsInstance<ToolCallBlock>().associate { it.id to it.tool }
        }

        val ownedCallContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-owned","name":"Bash","input":{"cmd":"ls"},"progress":"streaming..."}}}
        """)
        val unownedCallContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-unowned","name":"Bash","input":{"cmd":"pwd"},"turnId":"turn-1"}}}
        """)
        val taskCallContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-task","name":"Task","input":{"prompt":"sub"}}}}
        """)
        val closedEventContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"event","data":{"type":"ready"}}}
        """)
        val childDurationContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"output","data":{"type":"system","subtype":"turn_duration","durationMs":10,"isSidechain":true,"parentToolUseId":"call-task"}}}
        """)

        val cutoffTools = reduce(
            listOf(
                DecryptedMessage(id = "m1", content = ownedCallContent, createdAt = 100, turnId = "turn-1", turnState = "running"),
                DecryptedMessage(id = "m2", content = unownedCallContent, createdAt = 101),
                DecryptedMessage(id = "m3", content = taskCallContent, createdAt = 102, turnId = "turn-1", turnState = "running"),
                DecryptedMessage(id = "m4", content = closedEventContent, createdAt = 103, turnId = "turn-1", turnState = "cutoff"),
                DecryptedMessage(id = "m5", content = closedEventContent, createdAt = 104, turnId = "turn-1", turnState = "running"),
            )
        )

        val owned = assertNotNull(cutoffTools["call-owned"])
        assertEquals(ToolState.ERROR, owned.state)
        assertEquals(ToolCompletionSource.INVOCATION_CUTOFF, owned.completionSource)
        assertNull(owned.completedAt)

        val unowned = assertNotNull(cutoffTools["call-unowned"])
        assertEquals(ToolState.RUNNING, unowned.state)
        assertEquals(ToolCompletionSource.UNRESOLVED, unowned.completionSource)
        assertNull(unowned.completedAt)

        val taskTool = assertNotNull(cutoffTools["call-task"])
        assertEquals(ToolState.RUNNING, taskTool.state)
        assertEquals(ToolCompletionSource.UNRESOLVED, taskTool.completionSource)

        // History and child turn_duration events must not close a parent turn.
        val nonClosedTools = reduce(
            listOf(
                DecryptedMessage(id = "h1", content = ownedCallContent, createdAt = 200, turnId = "turn-2", turnState = "running"),
                DecryptedMessage(id = "h2", content = closedEventContent, createdAt = 201, turnId = "turn-2", turnState = "history"),
                DecryptedMessage(id = "h3", content = childDurationContent, createdAt = 202, turnId = "turn-2", turnState = "completed"),
            )
        )
        val stillRunning = assertNotNull(nonClosedTools["call-owned"])
        assertEquals(ToolState.RUNNING, stillRunning.state)
        assertEquals(ToolCompletionSource.UNRESOLVED, stillRunning.completionSource)

        // Explicit terminal tool-call status clears completionSource.
        val explicitCompletedContent = HapiJson.parseToJsonElement("""
            {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-owned","name":"Bash","status":"completed"}}}
        """)
        val explicitTools = reduce(
            listOf(
                DecryptedMessage(id = "e1", content = ownedCallContent, createdAt = 300, turnId = "turn-3", turnState = "running"),
                DecryptedMessage(id = "e2", content = explicitCompletedContent, createdAt = 305, turnId = "turn-3", turnState = "completed"),
            )
        )
        val explicitDone = assertNotNull(explicitTools["call-owned"])
        assertEquals(ToolState.COMPLETED, explicitDone.state)
        assertNull(explicitDone.completionSource)
        assertEquals(305.0, explicitDone.completedAt)
    }
}
