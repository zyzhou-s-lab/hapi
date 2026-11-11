# Haruka Architecture Phase 2 — Residual Compromises Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three remaining architectural compromises identified in the post-`b2f20c04` review of `hapi-answer-in-grid`:
1. **`StoreTurnBlock` / `partitionTurn` intra-turn re-projection** in React render (`TurnBlock.tsx`, `TimelineTurnBlock.tsx`, `turnBlockModel.ts`).
2. **`SessionEntityStore` window-snapshot diffing and `activeTurnId` / `sessionThinking` full-replay fallbacks** (`sessionEntityStore.ts`, `reducer.ts`, `assistant-runtime-blocks.ts`).
3. **`reducerTimeline.ts` sequence/role heuristic boundary fallbacks** (`isHumanTurnStart`, `completePriorRunningTools`, `hasNewerActivity`, and untagged snapshot prefix-guessing in `reducer.ts`).

**Baseline Commit:** `b2f20c04` (`hapi-answer-in-grid`)

---

## Executive Diagnosis of the Three Residual Gaps

| # | Residual Compromise | Exact Location on `b2f20c04` | Runtime Symptom / Architectural Cost | Target End-State |
|---|---|---|---|---|
| **1** | **Intra-turn `partitionTurn` & `projectTurn` re-projection in React** | `web/src/components/AssistantChat/messages/TurnBlock.tsx:144-149`<br>`web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx:126-130`<br>`web/src/components/AssistantChat/messages/turnBlockModel.ts:471-639, 1839-1990` | While pure text streaming inside an existing block skips `StoreTurnBlock` via `TurnLayoutSnapshot`, any structural change within a turn (new step block, tool state transition `pending -> running -> completed`) triggers `store.getLiveTurnParts(messageId)` + `partitionTurn(...)` + `projectTurn(...)` inside React `useMemo`. Furthermore, `TurnRow` still carries eager block/text snapshots (`TurnTextRow.text`, `TurnReasoningRow.text`, `TurnToolRow.block`) even though child views subscribe by `blockId`. | Move turn partitioning and step coalescing into `SessionEntityStore` as an incremental, structural-only `ProjectedTurnLayout` keyed by `turnId`. `TurnRow` descriptors hold only `blockId` + layout metadata; `StoreTurnBlock` and `TimelineTurnBlockView` consume pre-projected layout slices directly without calling `getLiveTurnParts` or running `partitionTurn` in render. |
| **2** | **`SessionEntityStore` window-snapshot projection & `sessionThinking` / `activeTurnId` full-replay degradation** | `web/src/chat/store/sessionEntityStore.ts:1164-1406`<br>`web/src/chat/reducer.ts:67-68, 274-275`<br>`web/src/chat/reducerTimeline.ts:308-309`<br>`web/src/lib/assistant-runtime-blocks.ts:862-1074` | 1) `reduceTimeline` no longer reads `context.activeTurnId` or `context.sessionThinking` (tool cutoff uses message-derived `turnStates` at `reducerTimeline.ts:1137-1148`), yet `sessionEntityStore.ts:1201-1202` and `1389-1390` still invalidate `SettledPrefixCache` and `retainedTimelineSuffix` whenever `activeTurnId` or `sessionThinking` changes—forcing a **full window replay** on every thinking start/stop transition even though `sessionThinking` only affects `buildTurnHeadersById` (`assistant-runtime-blocks.ts:966`).<br>2) `SessionEntityStore` still runs a post-reduction array reconciliation pipeline (`reduceChatBlocks -> reconcileChatBlocks -> buildVisibleChatBlocks -> buildTurnEntitiesById -> buildTurnLayoutsById -> notifyChangedListeners`) and falls back to full replay on `replace-window`. | 1) Immediately remove dead `activeTurnId`/`sessionThinking` dependencies from `reduceChatBlocks`/`reduceTimeline` and add a header-only fast path in `SessionEntityStore` when only `sessionThinking`/`activeTurnId` changes.<br>2) Evolve `SessionEntityStore` into an operation-driven entity state machine where `append-tail`, `upsert-live-stream`, `prepend-history`, and delta-resolved `replace-window` mutate persistent turn/block entities in place and emit exact `dirtyEntityIds` without whole-array diffing. |
| **3** | **`reducerTimeline.ts` sequence/role heuristic boundary inference** | `web/src/chat/reducerTimeline.ts:399-431` (`isHumanTurnStart`, `closeRunningStepsBeforeHumanTurn`)<br>`web/src/chat/reducerTimeline.ts:520-559` (`completePriorRunningTools`)<br>`web/src/chat/reducerTimeline.ts:1110-1148` (`hasNewerActivity`)<br>`web/src/chat/reducer.ts:127-205` (`collapseAssistantSnapshots`) | Despite persisted `session_turns` (`turn_id`, `turn_phase`), `stream_id`, and `stream_live` in Hub SQLite, `reducerTimeline.ts` still executes sequence heuristics (`completePriorRunningTools` when a newer agent message arrives, `closeRunningStepsBeforeHumanTurn` on next user prompt, `seenReadyOrAbort + hasNewerActivity` at timeline end, and prefix-matching in `collapseAssistantSnapshots`). | Enforce strict protocol-driven lifecycle resolution whenever canonical `turnId` / `streamId` metadata is present; isolate legacy untagged heuristics behind an explicit `isLegacyUntaggedMessage` boundary; backfill/normalize legacy rows at the Hub SQLite boundary so live & persisted canonical turns never hit heuristic inference. |

---

## Workstream 1: Eliminate `StoreTurnBlock` / `partitionTurn` Intra-Turn Re-Projection in React

### Problem Statement & Code Evidence
In `web/src/components/AssistantChat/messages/TurnBlock.tsx:135-162`:
```tsx
const turnLayout = useOptionalSessionTurnLayout(messageId)
const turnHeader = useOptionalSessionTurnHeader(messageId)
...
const partition = useMemo(() => {
    const parts = store?.getLiveTurnParts(messageId) ?? []
    const next = partitionTurn(parts, staticCtx?.metadata ?? null, prevPartitionRef.current)
    prevPartitionRef.current = next
    return next
}, [staticCtx?.metadata, turnLayout, store, messageId])
```
And in `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx:126-130`:
```tsx
const projected = useMemo(() => {
    const next = projectTurn(props.partition, { viewMode, streaming: props.streaming, fallbackTodos: props.fallbackTodos }, prevProjectedRef.current)
    prevProjectedRef.current = next
    return next
}, [props.partition, viewMode, props.streaming, props.fallbackTodos])
```
Why this is still a compromise:
1. When a turn has 40 tool/reasoning steps and step #41 is appended (or step #40 changes state from `running` to `completed`), `turnLayout` changes for that turn.
2. `StoreTurnBlock` pulls `store.getLiveTurnParts(messageId)`—which maps every `VisibleChatBlock` in the turn through `visibleBlockToTurnContentPart`—and re-runs `partitionTurn` ($O(k)$ with backward/forward scans for `trailing` text, recovered tool errors, and latest pinned todo/plan deduplication) plus `projectTurn` ($O(k)$ step coalescing via `coalesceTurnStepRows` and slot filtering).
3. `TurnTextRow`, `TurnReasoningRow`, and `TurnToolRow` still embed `text: string` and `block: ToolCallBlock` from `partitionTurn`, duplicating data that child components (`TurnEntityTextBody` in `TurnAnswerSection.tsx`, `TimelineStepRows.tsx`) already read via `useOptionalSessionVisibleEntity(blockId)` / `useOptionalSessionBlockEntity(blockId)`.

### Remediation Tasks

- [ ] **Task 1.1: Make `TurnRow` & `ProjectedSubturn` Structural-Only in Entity-Store Mode**
  - **Files:**
    - `web/src/components/AssistantChat/messages/turnBlockModel.ts`
    - `web/src/lib/assistant-runtime-blocks.ts`
  - **Changes:**
    - Enrich `TurnLayoutBlock` in `web/src/lib/assistant-runtime-blocks.ts:756-774` with the minimal structural fields needed by `partitionTurn` and `coalesceTurnStepRows`:
      - `verb: string`
      - `intent: string | null`
      - `pinned: boolean`
      - `error: boolean`
      - `permission: boolean`
      - `coalescibleCategory: TurnCoalescedCategory | null`
      - `titleCandidate: string | null` (the first-line summary/title extracted once per block when `TurnLayoutBlock` is cached in `WeakMap<VisibleChatBlock, TurnLayoutBlock>`)
    - Add a `WeakMap<VisibleChatBlock, TurnLayoutBlock>` cache in `SessionEntityStore` so `describeLayoutBlock(block, metadata)` is computed at most once per immutable `VisibleChatBlock` reference.
    - Introduce `partitionTurnFromLayout(layout: TurnLayoutSnapshot, previous?: TurnPartition | null): TurnPartition` in `turnBlockModel.ts` that builds `TurnRow[]` directly from `TurnLayoutBlock[]` without reading `TurnEntityContentPart[]` or touching `part.text.trim()` on every turn layout tick.

- [ ] **Task 1.2: Pre-Project `TurnPartition` & Mode-Indexed `ProjectedTurn` in `SessionEntityStore`**
  - **Files:**
    - `web/src/chat/store/sessionEntityStore.ts`
    - `web/src/hooks/useSessionEntityStore.ts`
    - `web/src/components/AssistantChat/messages/TurnBlock.tsx`
    - `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx`
  - **Changes:**
    - Store `partition: TurnPartition` directly on `TurnLayoutSnapshot` (computed incrementally in `SessionEntityStore` only for turns whose `TurnLayoutBlock[]` changed).
    - Maintain incremental intra-turn state on `TurnLayoutSnapshot`:
      - Track `lastCompactionBoundaryIndex`, `lastSubRoundStepIndex`, `latestPinnedTodoIndex`, `latestPinnedPlanIndex`, and `hasPendingTool` so appending a new `TurnLayoutBlock` updates the turn partition in $O(1)$ amortized time for common tail appends instead of rescanning all prior blocks in the turn.
    - Update `StoreTurnBlock` (`TurnBlock.tsx:135-162`) to read `turnLayout.partition` directly from `useOptionalSessionTurnLayout(messageId)` and remove `store?.getLiveTurnParts(messageId)` from `StoreTurnBlock`.
    - Update `TurnExecutionRail.tsx` and `TimelineStepRows.tsx` so header summary / rail counts use `turnLayout.partition` + per-block entity hooks (`useOptionalSessionBlockEntity`), eliminating the last dependency on full `TurnEntitySnapshot.parts` during turn rendering.

- [ ] **Task 1.3: Verification for Workstream 1**
  - Add a unit test in `web/src/chat/store/sessionEntityStore.test.ts` and `web/src/components/AssistantChat/messages/turnBlockModel.test.ts` verifying:
    - Streaming text deltas into an `agent-text` or `agent-reasoning` block after its first non-empty token keep `TurnLayoutSnapshot` and `turnLayout.partition` reference-identical (`Object.is`).
    - Appending a new tool call to a 50-step turn reuses all 50 prior `TurnLayoutBlock` descriptors from the `WeakMap` cache and does not invoke `getLiveTurnParts`.

---

## Workstream 2: Eliminate `activeTurnId` / `sessionThinking` Full Replays & Transition `SessionEntityStore` to Native Event-Driven Mutation

### Problem Statement & Code Evidence

#### Issue 2A: Spurious Full-Window Replay on `sessionThinking` / `activeTurnId` Changes
In `web/src/chat/store/sessionEntityStore.ts:1200-1203`:
```ts
if (!forceFullReplay
    && prevInput?.activeTurnId === input.activeTurnId
    && prevInput?.sessionThinking === input.sessionThinking
    && canSliceRawTailFromPrefixCache(input, this.reductionCache.prefix)) {
```
And at `web/src/chat/store/sessionEntityStore.ts:1387-1393`:
```ts
const retainedTimelineSuffix = !forceFullReplay
    && prevSnapshot.sessionId === input.sessionId
    && prevInput?.agentState === input.agentState
    && prevInput?.activeTurnId === input.activeTurnId
    && prevInput?.sessionThinking === input.sessionThinking
    && !Object.keys(input.agentState?.requests ?? {}).length
    ? findRetainedTimelineSuffix(normalized, prevSnapshot.normalizedMessages, this.reductionCache.timeline)
    : null
```
Meanwhile, in `web/src/chat/reducerTimeline.ts:308-311`:
`context.activeTurnId` and `context.sessionThinking` are declared in the type signature of `reduceTimeline`, passed through `reducer.ts:274-275`, **and never read anywhere in `reduceTimeline.ts` or `reducer.ts`**!
The only consumer of `sessionThinking` in the entire store projection is `buildTurnHeadersById` (`web/src/lib/assistant-runtime-blocks.ts:951-996`), which computes:
```ts
const isLast = id === lastEntryId
...
const isRunning = (isLast && sessionThinking) || hasRunningTool || hasLiveProse
```
Because of the stale guard in `sessionEntityStore.ts:1201-1202` and `1389-1390`, every time a session starts thinking (`sessionThinking: false -> true`), switches `activeTurnId`, or finishes thinking (`sessionThinking: true -> false`), `SessionEntityStore` bypasses both `SettledPrefixCache` and `retainedTimelineSuffix` and **re-runs a full O(N) window reduction**!

#### Issue 2B: Snapshot-Projection & Post-Hoc Reconciliation Pipeline
Even on incremental tail updates, `SessionEntityStore` (`sessionEntityStore.ts:1294-1600`) still:
1. Slices `tailMessages`, runs `reduceChatBlocks` to produce a fresh `ChatBlock[]`,
2. Runs `reconcileChatBlocks` to diff the new `ChatBlock[]` against `this.prevTailById`,
3. Rebuilds `tailVisibleBlocks`, `tailBlocksWithThreadIds`, `tailTurnsById`, `tailTurnLayoutsById`, `tailTurnHeadersById`,
4. Runs `notifyChangedListeners` by iterating and comparing old vs. new maps.
And whenever `windowOperation.kind === 'replace-window'` arrives (or when a tool result touches a tool call in the prefix that includes `Bash` or `wait`), it falls back to `reductionMode = 'full'`.

### Remediation Tasks

- [ ] **Task 2.1: Remove Dead `activeTurnId` / `sessionThinking` Reducer Inputs & Add O(1) Header-Only Fast Path**
  - **Files:**
    - `web/src/chat/reducer.ts`
    - `web/src/chat/reducerTimeline.ts`
    - `web/src/chat/store/sessionEntityStore.ts`
    - `web/src/lib/assistant-runtime-blocks.ts`
  - **Changes:**
    1. Remove unused `activeTurnId` and `sessionThinking` from `ReduceChatBlocksOptions` (`reducer.ts:67-68, 274-275`) and `reduceTimeline` context (`reducerTimeline.ts:308-309`).
    2. Remove `prevInput?.activeTurnId === input.activeTurnId` and `prevInput?.sessionThinking === input.sessionThinking` from `sessionEntityStore.ts:1201-1202` and `1389-1390`.
    3. In `SessionEntityStore.reconcileInput` (`sessionEntityStore.ts:1170`), add a dedicated **`session-thinking-only` fast path**:
       - When `prevInput` has the same `sessionId`, `messages`, `goalSourceMessages`, `agentState`, `metadata`, `backgroundTaskCount`, `hasMoreMessages`, and `codexExplorationCollapsed`, and only `sessionThinking` or `activeTurnId` changed:
       - Do **not** run `reduceChatBlocks`, `reconcileChatBlocks`, `buildTurnEntitiesById`, or `buildTurnLayoutsById`.
       - Recompute only the last turn's `TurnHeaderSnapshot` in `turnHeadersById` (`lastEntryId = this.snapshot.timelineIndex.at(-1)?.id`), update `this.snapshot`, and notify only `entityListeners.get(lastEntryId)` (plus `storeListeners` if subscribed).
       - Set `reductionMode: 'incremental-tail'` (or `'header-only'`).

- [ ] **Task 2.2: Expand Direct Prefix/Entity Patching to Eliminate Remaining Tail -> Prefix Full Replays**
  - **Files:**
    - `web/src/chat/store/sessionEntityStore.ts`
  - **Changes:**
    - Currently `sessionEntityStore.ts:1221-1230` aborts incremental tail reduction if `tailHasBashOrWaitToolCall` is true while patching a prefix tool result, or if a prefix tool call is a subagent receiving a sidechain child message.
    - Generalize `applyPrefixToolResultMessage` (`sessionEntityStore.ts:890-1085`) into `applyCrossBoundaryEntityMutation`:
      - Allow direct in-place entity updates for any `tool-result` or `agent_run_status` / `permission-request` event targeting a `tool_use_id` in `SettledPrefixCache.prefixById`, updating only that `ToolCallBlock`, its owning `ToolGroupBlock` (if grouped), and its owning `TurnEntitySnapshot` / `TurnLayoutSnapshot` / `TurnHeaderSnapshot` in `SettledPrefixCache`, and adding the exact `tool_use_id` and `turnId` to `dirtyEntityIds`.

- [ ] **Task 2.3: Delta-Resolved `replace-window` & Persistent Incremental Ingestion State**
  - **Files:**
    - `web/src/lib/message-window-store.ts`
    - `web/src/chat/store/sessionEntityStore.ts`
  - **Changes:**
    - In `message-window-store.ts`, when `replaceWindow` is called during SSE reconnect catch-up or pagination recovery on the same `sessionId`, compute whether the new window shares a contiguous prefix with the existing window:
      - If the prefix is identical and only tail messages were appended/upserted, emit an `append-tail` or `upsert-tail-batch` `MessageWindowOperation` instead of an opaque `replace-window`.
      - If older messages were prepended ahead of the existing window while the suffix matches, emit `prepend-history`.
    - In `SessionEntityStore`, maintain a persistent `TimelineCheckpoint` across both prefix and active tail so every `append-tail` and `upsert-live-stream` advances the checkpoint directly by the 1–N changed messages rather than re-reducing the entire tail since the last user message (`splitIndex`).
      - *Why this matters:* In long agent turns (e.g., 150 tool calls within a single user turn), `splitIndex` is at the start of the user turn, so re-reducing "from `splitIndex` to end of tail" currently grows as $O(M_{\text{current\_turn}})$ on every streaming token! Advancing a turn-internal `TimelineCheckpoint` after each settled message inside the active turn reduces per-event ingestion cost from $O(M_{\text{current\_turn}})$ to **$O(1)$ per streaming delta / tool event**.

- [ ] **Task 2.4: Verification for Workstream 2**
  - Add unit tests in `web/src/chat/store/sessionEntityStore.test.ts`:
    - Flipping `sessionThinking: false -> true -> false` on a 500-message window triggers `0` calls to `reduceChatBlocks` and notifies only the tail turn's header subscriber.
    - A single turn with 120 sequential tool calls and streaming text deltas processes message #121 in $O(1)$ message reductions via intra-turn `TimelineCheckpoint` continuation without re-reducing messages #1–#120 of the current turn.
    - Reconnect catch-up via `MessageWindowStore` with overlapping prefix emits an incremental tail operation and avoids `reductionMode === 'full'`.

---

## Workstream 3: Replace `reducerTimeline.ts` Heuristic Boundary Fallbacks with Canonical Turn & Stream Lifecycle Rules

### Problem Statement & Code Evidence
Even after introducing `session_turns` (`turn_id`, `turn_phase`, `status`, `outcome`, `cutoff_source`) in `hub/src/store/messages.ts` and `turnStates` in `web/src/chat/reducer.ts:231-245`, four sequence/role-based heuristics remain active in the hot path of `web/src/chat/reducerTimeline.ts` and `web/src/chat/reducer.ts`:

1. **`isHumanTurnStart` & `closeRunningStepsBeforeHumanTurn` (`reducerTimeline.ts:399-431`)**:
   - Scans all prior `toolBlocksById` and `blocks` when a root user message arrives, mutating any `running` non-subagent tool to `state: 'completed', completionSource: 'inferred'` and any open compaction block to `phase: 'finished', outcome: 'Superseded by next user turn'`.
2. **`completePriorRunningTools` (`reducerTimeline.ts:520-559`)**:
   - Called on every agent text, reasoning, or tool-call item (`reducerTimeline.ts:681, 697, 735`). Scans all prior `toolBlocksById` with `block.createdAt <= msg.createdAt` and forcibly marks running tools (except `bash` and `wait`) as `state: 'completed', completionSource: 'inferred'`.
   - *Flaw:* In parallel tool execution or out-of-order streaming chunks within the same turn, an incoming reasoning/text delta or sibling tool call with `createdAt >= priorTool.createdAt` prematurely marks a genuinely running tool as `'completed'` (`inferred`) before its `tool-result` arrives!
3. **`seenReadyOrAbort` + `hasNewerActivity` post-loop pass (`reducerTimeline.ts:1110-1135`)**:
   - At the end of `reduceTimeline`, if any `ready` or `turn_aborted` event was seen anywhere in the timeline and a tool has `hasNewerActivity(block)` (any later block or timestamp in the timeline), it marks the tool `completed` (`inferred`) or `error`.
4. **Untagged prefix guessing in `collapseAssistantSnapshots` (`reducer.ts:127-205`)**:
   - When `streamId` is absent on non-sidechain assistant messages, `collapseAssistantSnapshots` checks `nextText.startsWith(prevText)` (lines 176-195) to guess whether two separate assistant messages are cumulative snapshots of one stream, merging and discarding the earlier message.

### Remediation Tasks

- [ ] **Task 3.1: Canonical Turn & Stream Tagging Guarantee at Hub SQLite Boundary**
  - **Files:**
    - `hub/src/store/messages.ts`
    - `hub/src/socket/handlers/cli/sessionHandlers.ts`
    - `cli/src/api/apiSession.ts`
  - **Changes:**
    - Ensure every message persisted through `hub/src/store/messages.ts` in an active turn receives a deterministic `turn_id` (falling back at Hub ingest time to the current open `session_turns` row for that session + source if the CLI payload omitted `_hapi.turnId`).
    - When a new user turn starts (`getOrCreateSessionTurnForUserMessage` in `hub/src/store/messages.ts`) or `ready` / `turn_aborted` / `disconnect_cutoff` is recorded, transactionally close any prior open `session_turns` row for that session (`status = 'completed' | 'aborted' | 'cutoff'`) and clear `stream_live = 0` on its open streams in SQLite.
    - Add a deterministic SQLite migration / read-normalizer in `hub/src/store/messages.ts` so historical messages lacking `turn_id` are tagged with a legacy marker (`turnPhase: undefined, turnId: undefined`) that the web reducer can distinguish from canonical turn-tagged messages (`msg.turnId != null`).

- [ ] **Task 3.2: Isolate Heuristics Strictly to `isLegacyUntaggedTurn` in `reducerTimeline.ts` & `reducer.ts`**
  - **Files:**
    - `web/src/chat/reducer.ts`
    - `web/src/chat/reducerTimeline.ts`
  - **Changes:**
    1. **Disable `completePriorRunningTools` for canonical turn-tagged tools (`block.turnId != null`)**:
       - In `reducerTimeline.ts:520-559`, if a `ToolCallBlock` has `block.turnId != null` and `context.turnStates?.has(block.turnId)`, do **not** infer completion from sibling assistant prose/reasoning/tool-call timestamps while the turn is still `'running'`. A tool in a canonical running turn stays `'running'` until:
         - Its explicit `tool-result` arrives (`completionSource: 'tool_result'`), OR
         - Its owning `turnId` transitions to a terminal state in `context.turnStates` (`'completed' | 'aborted' | 'cutoff'`), which settles any still-open non-background tools in that turn at turn-end (`reducerTimeline.ts:1137-1148`).
    2. **Scope `closeRunningStepsBeforeHumanTurn` & `seenReadyOrAbort + hasNewerActivity` to legacy untagged blocks (`!block.turnId`)**:
       - In `closeRunningStepsBeforeHumanTurn` (`reducerTimeline.ts:408-431`) and the post-loop `seenReadyOrAbort` pass (`reducerTimeline.ts:1118-1135`), skip any `ToolCallBlock` that has a canonical `block.turnId` present in `context.turnStates` (since `context.turnStates.get(block.turnId)` at lines 1137–1148 already resolves `cutoff`, `aborted`, and `completed` deterministically per turn!).
       - For `omp-compaction` events with `turnId`, close them via `context.turnStates.get(turnId)` terminal state rather than scanning backward on `isHumanTurnStart`.
    3. **Require `streamId` for snapshot collapsing on canonical messages (`reducer.ts:127-205`)**:
       - In `collapseAssistantSnapshots`, only run the `nextText.startsWith(prevText)` heuristic when **both** `prev.turnId == null` and `msg.turnId == null` (legacy untagged messages). When `turnId` is present, stream snapshot deduplication is governed exclusively by matching `streamSnapshot.id` / `c.streamId`.

- [ ] **Task 3.3: Regenerate Golden Fixtures & Verify Cross-Platform Protocol Conformance**
  - **Files:**
    - `web/src/chat/reducerTimeline.test.ts`
    - `web/src/chat/reducerToolOutcomes.test.ts`
    - `shared/fixtures/**`
    - `ios/Packages/HapiKit/Sources/HapiProtocol/**` (if fixture diff affects Swift port)
    - `android/core/protocol/src/**` (if fixture diff affects Kotlin port)
  - **Changes:**
    - Add unit tests in `reducerToolOutcomes.test.ts` proving that:
      - In a canonical turn (`turnId: 'turn-1'`, `turnStates: Map([['turn-1', 'running']])`), emitting a parallel tool call or subsequent reasoning/text chunk does **not** prematurely flip an earlier running `Read` / `Edit` tool to `completed (inferred)`.
      - Once `turn-1` transitions to `'completed'`, `'aborted'`, or `'cutoff'` in `turnStates`, open tools in `turn-1` settle deterministically via `turnStates` without relying on `isHumanTurnStart` or `hasNewerActivity`.
    - Run `bun run gen:fixtures`, `bun typecheck`, `bun run test`, and `./gradlew :core:protocol:test` (in `android/`) to ensure Web, iOS, and Android protocol pipelines remain 100% conformant.

---

## Execution Order & Acceptance Gates

1. **Phase 2.1 (Quick High-Impact Win — Workstream 2, Task 2.1):**
   - Remove dead `activeTurnId` / `sessionThinking` reducer inputs and land the `session-thinking-only` O(1) header fast path in `SessionEntityStore`.
   - **Gate:** `sessionEntityStore.test.ts` confirms `0` full replays when `sessionThinking` or `activeTurnId` toggles.
2. **Phase 2.2 (Intra-Turn Checkpoint & Direct Entity Mutation — Workstream 2, Tasks 2.2 & 2.3):**
   - Land intra-turn `TimelineCheckpoint` continuation (eliminating $O(M_{\text{current\_turn}})$ tail re-reduction in long turns), cross-boundary entity patching, and delta-resolved `replace-window`.
   - **Gate:** Streaming token #100 in a 100-step turn reduces only the delta message (`rows: 1`).
3. **Phase 2.3 (Store-Projected Structural Turn Layout — Workstream 1, Tasks 1.1–1.3):**
   - Move `partitionTurn` into `SessionEntityStore` over cached `TurnLayoutBlock` descriptors; remove `store.getLiveTurnParts(messageId)` from `StoreTurnBlock`.
   - **Gate:** `StoreTurnBlock` renders directly from `turnLayout.partition` without re-running `partitionTurn` in React render.
4. **Phase 2.4 (Canonical Turn Lifecycle & Heuristic Isolation — Workstream 3, Tasks 3.1–3.3):**
   - Gate `completePriorRunningTools`, `closeRunningStepsBeforeHumanTurn`, `hasNewerActivity`, and `collapseAssistantSnapshots` prefix-guessing behind `!block.turnId` (legacy untagged fallback only); regenerate fixtures and verify all suites.
   - **Gate:** `bun typecheck && bun run test && bun run gen:fixtures` clean with zero regressions.
