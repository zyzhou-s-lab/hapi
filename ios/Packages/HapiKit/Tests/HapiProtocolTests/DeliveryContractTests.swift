import Foundation
import HapiProtocol
import Testing

@Suite("Delivery and session identity contract")
struct DeliveryContractTests {
    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func messageJSON(id: String, seq: Int) -> String {
        """
        {"id":"\(id)","seq":\(seq),"localId":"local-\(id)","createdAt":1000,"invokedAt":null,
         "turnId":"delivery-turn","turnState":"cutoff","phase":"final_answer","lifecycleState":"settled",
         "content":{"role":"agent","meta":{"turnId":"envelope-turn"},
                    "content":{"type":"codex","data":{"type":"message","id":"stream-id","message":"answer","live":true}}}}
        """
    }

    @Test func restAndSSEIdentitySurvivesWindowCopiesSnapshotAndNormalization() throws {
        let response = try decode(MessagesResponse.self, """
        {"messages":[\(messageJSON(id: "rest-1", seq: 1))],
         "page":{"direction":"latest","limit":20,"epoch":0,"reset":false,"hasMore":false}}
        """)
        let event = try decode(SyncEvent.self, """
        {"type":"message-received","sessionId":"s-1","message":\(messageJSON(id: "sse-1", seq: 2))}
        """)
        guard case .messageReceived(_, "s-1", let sseMessage) = event else {
            Issue.record("Expected message-received")
            return
        }
        for message in response.messages + [sseMessage] {
            #expect(message.turnId == "delivery-turn")
            #expect(message.turnState == "cutoff")
            #expect(message.phase == "final_answer")
            #expect(message.lifecycleState == "settled")
            let encoded = try JSONEncoder().encode(message)
            #expect(try JSONDecoder().decode(DecryptedMessage.self, from: encoded) == message)
        }
        var state = MessageWindowLogic.applyLatestResponse(
            MessageWindowLogic.createState(sessionId: "s-1"),
            responseMessages: response.messages.map { WindowMessage(wire: $0).withStatus(.sending).withInvokedAt(1500) },
            page: response.page,
            replaceServerRows: true,
            requestBaseline: [:]
        )
        state = MessageWindowLogic.ingestIncoming(
            state,
            incoming: [WindowMessage(wire: sseMessage).withDeliveryState("indeterminate").withStatus(.sending).withInvokedAt(1500)]
        )
        let snapshotData = try JSONEncoder().encode(MessageWindowLogic.toPersisted(state))
        let snapshot = try JSONDecoder().decode(PersistedMessageWindow.self, from: snapshotData)
        let restored = MessageWindowLogic.hydrate(sessionId: "s-1", persisted: snapshot)
        #expect(restored.messages.count == 2)
        for row in restored.messages {
            #expect(row.turnId == "delivery-turn")
            #expect(row.turnState == "cutoff")
            #expect(row.phase == "final_answer")
            #expect(row.lifecycleState == "settled")
            #expect(row.status == .sent)
            let wire = row.asDecryptedMessage
            #expect(wire.turnId == "delivery-turn")
            #expect(wire.turnState == "cutoff")
            #expect(wire.phase == "final_answer")
            #expect(wire.lifecycleState == "settled")
            let normalized = try #require(normalizeDecryptedMessage(wire))
            #expect(normalized.turnId == "delivery-turn")
            #expect(normalized.turnState == "cutoff")
        }
    }

    @Test func absentDeliveryFieldsStayAbsentAndUnknownStringsRoundTrip() throws {
        let legacy = try decode(DecryptedMessage.self, """
        {"id":"legacy","createdAt":1,"content":{"role":"user","content":"hello"}}
        """)
        let data = try JSONEncoder().encode(PersistedMessageWindow(messages: [WindowMessage(wire: legacy)]))
        let snapshot = try JSONDecoder().decode(PersistedMessageWindow.self, from: data)
        let row = try #require(MessageWindowLogic.hydrate(sessionId: "s", persisted: snapshot).messages.first)
        #expect(row.turnId == nil)
        #expect(row.turnState == nil)
        #expect(row.phase == nil)
        #expect(row.lifecycleState == nil)
        let normalizedLegacy = try #require(normalizeDecryptedMessage(row.asDecryptedMessage))
        #expect(normalizedLegacy.turnId == nil)
        #expect(normalizedLegacy.turnState == nil)
        let encoded = try decode(JSONValue.self, String(decoding: JSONEncoder().encode(legacy), as: UTF8.self))
        if case .object(let fields) = encoded {
            #expect(fields["turnId"] == nil)
            #expect(fields["turnState"] == nil)
            #expect(fields["phase"] == nil)
            #expect(fields["lifecycleState"] == nil)
        } else {
            Issue.record("Expected encoded message object")
        }
        let future = DecryptedMessage(
            id: "future",
            createdAt: 1,
            turnId: " raw-id ",
            turnState: "future-turn-state",
            phase: "future-phase",
            lifecycleState: "future-state"
        )
        let futureData = try JSONEncoder().encode(WindowMessage(wire: future).withStatus(.queued).withInvokedAt(2))
        let futureRow = try JSONDecoder().decode(WindowMessage.self, from: futureData)
        #expect(futureRow.turnId == " raw-id ")
        #expect(futureRow.turnState == "future-turn-state")
        #expect(futureRow.phase == "future-phase")
        #expect(futureRow.lifecycleState == "future-state")
    }

    @Test func normalizationOnlyUsesDeliveryOrCanonicalEnvelopeTurnIdentity() throws {
        let payloads = [
            "42",
            #"{"role":"user","content":"hello","meta":{"turnId":"canonical"}}"#,
            #"{"role":"user","content":42,"meta":{"turnId":"canonical"}}"#,
            #"{"role":"agent","content":{"type":"codex","data":{"type":"message","message":"answer"}},"meta":{"turnId":"canonical"}}"#,
            #"{"role":"agent","content":{"type":"event","data":{"type":"ready"}},"meta":{"turnId":"canonical"}}"#,
            #"{"role":"agent","content":42,"meta":{"turnId":"canonical"}}"#,
            #"{"role":"future","content":42,"meta":{"turnId":"canonical"}}"#,
        ]
        for payload in payloads {
            let content = try decode(JSONValue.self, payload)
            let delivered = DecryptedMessage(id: "uuid-is-not-turn-id", content: content, createdAt: 1, turnId: "delivery")
            #expect(normalizeDecryptedMessage(delivered)?.turnId == "delivery")
            let legacy = DecryptedMessage(id: "uuid-is-not-turn-id", content: content, createdAt: 1)
            #expect(normalizeDecryptedMessage(legacy)?.turnId == (payload == "42" ? nil : "canonical"))
        }
        let wrapped = try decode(JSONValue.self, #"{"payload":{"message":{"role":"user","content":"hello","meta":{"turnId":" canonical "}}}}"#)
        #expect(normalizeDecryptedMessage(DecryptedMessage(id: "m", content: wrapped, createdAt: 1))?.turnId == "canonical")
        let providerOnly = try decode(JSONValue.self, #"{"role":"agent","meta":{"turn_id":"wrong"},"content":{"type":"output","data":{"type":"assistant","uuid":"not-a-turn","turnId":"wrong","turn_id":"wrong","message":{"content":"answer","turnId":"wrong"}}}}"#)
        #expect(normalizeDecryptedMessage(DecryptedMessage(id: "uuid-is-not-turn-id", content: providerOnly, createdAt: 1))?.turnId == nil)
    }

    @Test func sessionLifecyclePatchAppliesAndNullClearsWithoutInference() throws {
        let legacy = try decode(Session.self, """
        {"id":"s","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,
         "active":false,"activeAt":0,"metadataVersion":0,"agentStateVersion":0,
         "thinking":false,"thinkingAt":0,"activeTurnStartedAt":99}
        """)
        #expect(legacy.activeTurnId == nil)
        #expect(legacy.lifecycleState == nil)
        let event = try decode(SyncEvent.self, """
        {"type":"session-updated","sessionId":"s","data":{"activeTurnId":"turn-1","lifecycleState":"streaming-answer","activeTurnStartedAt":123}}
        """)
        guard case .sessionUpdated(_, "s", .patch(let patch)?) = event else {
            Issue.record("Expected strict session patch")
            return
        }
        #expect(!isRenderIrrelevantSessionPatch(session: legacy, patch: patch))
        let applied = try #require(applySessionDetailPatch(session: legacy, patch: patch))
        #expect(applied.activeTurnId == "turn-1")
        #expect(applied.lifecycleState == "streaming-answer")
        #expect(applied.activeTurnStartedAt == 99)
        #expect(!applied.active)
        #expect(!applied.thinking)
        #expect(applySessionDetailPatch(session: applied, patch: patch) == nil)
        let roundTrip = try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(applied))
        #expect(roundTrip == applied)
        let lifecycleOnly = try decode(SessionPatch.self, #"{"lifecycleState":"future-state"}"#)
        #expect(lifecycleOnly.activeTurnId == nil)
        let unchangedTurn = try #require(applySessionDetailPatch(session: applied, patch: lifecycleOnly))
        #expect(unchangedTurn.activeTurnId == "turn-1")
        #expect(unchangedTurn.lifecycleState == "future-state")
        let clear = try decode(SessionPatch.self, #"{"activeTurnId":null,"lifecycleState":"idle"}"#)
        #expect(clear.activeTurnId == .null)
        let clearData = try JSONEncoder().encode(clear)
        #expect(try JSONDecoder().decode(SessionPatch.self, from: clearData) == clear)
        let cleared = try #require(applySessionDetailPatch(session: unchangedTurn, patch: clear))
        #expect(cleared.activeTurnId == nil)
        #expect(cleared.lifecycleState == "idle")
        #expect(cleared.activeTurnStartedAt == 99)
        let absent = try decode(SessionPatch.self, #"{"updatedAt":3}"#)
        #expect(absent.activeTurnId == nil)
        #expect(absent.lifecycleState == nil)
        let preserved = try #require(applySessionDetailPatch(session: applied, patch: absent))
        #expect(preserved.activeTurnId == "turn-1")
        #expect(preserved.lifecycleState == "streaming-answer")
    }

    @Test func sessionPatchStillRejectsInvalidTypesNullLifecycleAndUnknownKeys() {
        for json in [
            #"{"activeTurnId":1}"#,
            #"{"lifecycleState":null}"#,
            #"{"lifecycleState":true}"#,
            #"{"activeTurnId":"t","lifecycleState":"idle","unknown":true}"#,
        ] {
            #expect(throws: (any Error).self) {
                try decode(SessionPatch.self, json)
            }
        }
    }

    @Test func canonicalTurnClosureReconcilesOwnedToolCutoffAndPreservesUnresolvedCases() throws {
        func reduce(_ rawMessages: [DecryptedMessage]) -> [String: ChatToolCall] {
            let normalized = rawMessages.compactMap { normalizeDecryptedMessage($0) }
            let reduced = reduceChatBlocks(normalized, agentState: nil)
            var tools: [String: ChatToolCall] = [:]
            for block in reduced.blocks {
                if case .toolCall(let toolBlock) = block {
                    tools[toolBlock.id] = toolBlock.tool
                }
            }
            return tools
        }

        let ownedCallContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-owned","name":"Bash","input":{"cmd":"ls"},"progress":"streaming..."}}}
        """)
        let unownedCallContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-unowned","name":"Bash","input":{"cmd":"pwd"},"turnId":"turn-1"}}}
        """)
        let taskCallContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-task","name":"Task","input":{"prompt":"sub"}}}}
        """)
        let closedEventContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"event","data":{"type":"ready"}}}
        """)
        let childDurationContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"output","data":{"type":"system","subtype":"turn_duration","durationMs":10,"isSidechain":true,"parentToolUseId":"call-task"}}}
        """)

        let cutoffTools = reduce([
            DecryptedMessage(id: "m1", content: ownedCallContent, createdAt: 100, turnId: "turn-1", turnState: "running"),
            DecryptedMessage(id: "m2", content: unownedCallContent, createdAt: 101),
            DecryptedMessage(id: "m3", content: taskCallContent, createdAt: 102, turnId: "turn-1", turnState: "running"),
            DecryptedMessage(id: "m4", content: closedEventContent, createdAt: 103, turnId: "turn-1", turnState: "cutoff"),
            DecryptedMessage(id: "m5", content: closedEventContent, createdAt: 104, turnId: "turn-1", turnState: "running"),
        ])

        let owned = try #require(cutoffTools["call-owned"])
        #expect(owned.state == .error)
        #expect(owned.completionSource == .invocationCutoff)
        #expect(owned.completedAt == nil)

        let unowned = try #require(cutoffTools["call-unowned"])
        #expect(unowned.state == .running)
        #expect(unowned.completionSource == .unresolved)
        #expect(unowned.completedAt == nil)

        let taskTool = try #require(cutoffTools["call-task"])
        #expect(taskTool.state == .running)
        #expect(taskTool.completionSource == .unresolved)

        // History and child turn_duration events must not close a parent turn.
        let nonClosedTools = reduce([
            DecryptedMessage(id: "h1", content: ownedCallContent, createdAt: 200, turnId: "turn-2", turnState: "running"),
            DecryptedMessage(id: "h2", content: closedEventContent, createdAt: 201, turnId: "turn-2", turnState: "history"),
            DecryptedMessage(id: "h3", content: childDurationContent, createdAt: 202, turnId: "turn-2", turnState: "completed"),
        ])
        let stillRunning = try #require(nonClosedTools["call-owned"])
        #expect(stillRunning.state == .running)
        #expect(stillRunning.completionSource == .unresolved)

        // Explicit terminal tool-call status and tool-result clear completionSource.
        let explicitCompletedContent = try decode(JSONValue.self, """
        {"role":"agent","content":{"type":"codex","data":{"type":"tool-call","callId":"call-owned","name":"Bash","status":"completed"}}}
        """)
        let explicitTools = reduce([
            DecryptedMessage(id: "e1", content: ownedCallContent, createdAt: 300, turnId: "turn-3", turnState: "running"),
            DecryptedMessage(id: "e2", content: explicitCompletedContent, createdAt: 305, turnId: "turn-3", turnState: "completed"),
        ])
        let explicitDone = try #require(explicitTools["call-owned"])
        #expect(explicitDone.state == .completed)
        #expect(explicitDone.completionSource == nil)
        #expect(explicitDone.completedAt == 305)
    }
}
