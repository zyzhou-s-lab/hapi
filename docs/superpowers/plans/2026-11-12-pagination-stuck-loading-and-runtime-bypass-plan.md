# Pagination Stuck-Loading, Subagent Stream Compaction & Runtime Bypass Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 3.6s–13s session load/pagination stalls, mid-turn window truncation, stuck `Loading...` multi-page loops, initial-pin scroll snapbacks, and redundant `@assistant-ui` runtime message reconciliation + offscreen DOM accumulation on `hapi-answer-in-grid`.

**Baseline Commit:** `a9ead09` (`hapi-answer-in-grid`)

**Reference Implementations & Diagnostics:**
- Screen recording diagnosis (`Snapzy_Recording_2026-11-12_20-34-33.mp4`, session `80600201-a0f3-42b3-9ba0-af9b887f2a94` on `http://10.202.2.224:5174/`)
- `bobmcmxciv/hapi` (`feat/beta-20261111`, commits `2bc398c8` and `c1e2bbc9`)
- Comparative 10-metric profiling from `t3-thread://v2/799beb02-6d70-49d6-bed9-d247483e7969/bc4003da-5f4f-4ee3-8d09-3266e40a9b56`

---

## Executive Diagnosis of Root Causes

| # | Bottleneck / Bug | Exact Location on `a9ead09` | Observed Symptom & Quantitative Impact | Target End-State |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Uncompacted `codex:agent-run-update` rows & unbounded byte size per turn page** | `shared/src/turnBoundary.ts:17-19`<br>`shared/src/messages.ts:76-98`<br>`hub/src/sync/messageService.ts:58-60, 319-374` | `collectTurnRows` scans up to `TURN_PAGE_ROW_MAX = 2000` rows for `TURN_PAGE_SIZE = 20` turns with no byte cap, and `readMessageStreamId` ignores `codex:agent-run-update`. On session `80600201`, initial `?turns=20` returns **1,097 rows / 8.08 MB JSON in 3.62s** (`641` `agent-run-update` rows = `5.34 MB`); older page `?beforeSeq=34307` returns **2,000 rows / 14.05 MB JSON in 7.14s** (`1,636` `agent-run-update` rows = `12.38 MB`). | `TURN_PAGE_SIZE = 8`, `TURN_PAGE_BYTE_BUDGET = 1024 * 1024` (1 MB), and `compactAgentRunUpdateMessages` collapses intermediate running snapshots per `callId` (keeping first + latest running + terminal updates). Initial/older page payload drops to **< 300 KB (< 150 ms)**. |
| **2** | **`trimConversation` slices turn-paginated windows with `VISIBLE_WINDOW_SIZE = 400`** | `web/src/lib/message-window-store.ts:755-818, 1347` | Even when `ordered.some(isHumanTurnStart)` is true and turns are sliced to `turnLimit`, line 813 still runs `sliceForTrim(regularKept, Math.max(0, regularLimit - queuedBudget), mode)` with `VISIBLE_WINDOW_SIZE = 400`. On `80600201`, this discards **697 of the 1,097 just-downloaded rows (`seq 34307..35066`, 4.17 MB)**, cutting mid-turn at `seq 35067` (`codex:agent-run-update`) and advancing `oldestPositionSeq` to `35067`. | Turn-mode windows bypass the 400-row mid-turn slice, bound total rows by `MAX_TURN_WINDOW_ROWS = TURN_PAGE_ROW_MAX * 4` (`8000`), and snap any trim boundary to `isHumanTurnStart`. |
| **3** | **`loadUntilVisibleBoundaryChanges` multi-page loop on headless turns** | `web/src/components/AssistantChat/threadScrollHelpers.ts:685-719`<br>`web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts:702-729` | Because `trimConversation` (or a >2,000-row turn) leaves a headless assistant turn at the top of the viewport (`isTopTurnHeadlessAssistant === true`), `loadUntilVisibleBoundaryChanges` loops up to `maxPages = 8` while `!nextTopTurnComplete`, firing back-to-back multi-megabyte HTTP requests and locking `Loading...` for **13–20+ seconds**. | `loadUntilVisibleBoundaryChanges` stops immediately once a page adds visible blocks (`nextCount > initialCount` or `nextTopAnchorId !== initialTopAnchorId`), only retrying up to `MAX_CONSECUTIVE_EMPTY_OLDER_LOADS = 3` when a page yields 0 renderable blocks. |
| **4** | **`INITIAL_PINNING` (1.2s) ignores upward wheel over `<pre>` at `scrollTop === 0`** | `web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts:340-426, 777-803` | For 1,200ms after initial render, `handleViewportScrollDuringInitialPin` and `ResizeObserver` call `scrollToBottomInstant()`. `handleUpwardWheelDuringInitialPin` ignores `deltaY < 0` whenever the cursor is inside `[data-hapi-nested-scroll="true"], pre`—even when `nestedEl.scrollTop === 0`—snapping the user back to the bottom. | Upward wheel over a nested scrollable element with `scrollTop <= 0` (or any upward touch/pointer drag) immediately exits `INITIAL_PINNING` (`transitionTo('UNPINNED')`). |
| **5** | **`useHappyRuntime` duplicates `ThreadMessage[]` into `@assistant-ui` in `entityStore` mode** | `web/src/lib/assistant-runtime.ts:481-680, 720` | `StoreThreadMessagesById` renders directly from `SessionEntityStore`, and no `storeBacked` message component reads `@assistant-ui` message state. Yet `useHappyRuntime` still subscribes to `subscribeRuntimeTopology` and runs `HappyThreadMessageCache.reconcile` + `fromThreadMessageLike` on every turn/history update, keeping a duplicate `ThreadMessage[]` in V8 heap and triggering `useExternalStoreRuntime` reconciliation. | When `props.entityStore` is provided, `useHappyRuntime` passes `COMPOSER_ONLY_THREAD_MESSAGES = []` to `useExternalStoreRuntime` and skips `subscribeRuntimeTopology` + `HappyThreadMessageCache.reconcile`. |
| **6** | **`StoreThreadMessagesById` mounts all historical turns without offscreen virtualization** | `web/src/components/AssistantChat/HappyThread.tsx:110-131` | Scrolling up through multiple history pages keeps every turn's full DOM subtree mounted (`2,200–5,200+` DOM nodes), increasing layout/recalculate-style cost and JS heap compared to `bobmcmxciv/hapi`'s windowed virtualizer. | Offscreen historical turns outside `OVERSCAN_PX = 900` around the viewport collapse to measured-height anchor placeholders (`id={getConversationMessageAnchorId(entry.id)}`), keeping mounted DOM nodes bounded while preserving outline jumps and scroll anchoring. |

---

## Phase 1: Backend Turn Pagination Byte Budget & `codex:agent-run-update` Stream Compaction

### Problem Statement & Code Evidence
1. In `shared/src/turnBoundary.ts:17-19`:
   ```ts
   export const TURN_PAGE_SIZE = 20
   export const TURN_PAGE_MAX = 50
   export const TURN_PAGE_ROW_MAX = 2000
   ```
2. In `shared/src/messages.ts:76-98`, `readMessageStreamId(content)` only checks `codex:reasoning`, `codex:message (streamSnapshot === true)`, and `output:assistant (streamSnapshot === true)`. It returns `null` for `codex:agent-run-update`.
3. In `web/src/chat/reducerTimeline.ts:568-675`, `reduceTimeline` processes `agent_run_update` items for a given `callId` by:
   - Using the **first** update to initialize `startedAt = Math.min(existing.createdAt, item.createdAt)` and initial `input` (`label`, `agentId`, `parentId`, `provider`, `mode`);
   - Overwriting `progress`, `activity`, `statusText`, and `detail` with the **latest** `running` update;
   - Applying any **terminal** update (`status === 'completed' | 'failed' | 'errored' | 'cancelled' | 'aborted' | 'stopped' | 'interrupted'`) to close the tool call (`completedAt`, `summary`, `output`, `error`).
   - All intermediate `running` updates (often 50–300 per subagent call, each carrying 8–12 KB of cumulative `progress` / `activity` payload) are completely overwritten and discarded by `reduceTimeline`!
4. In `hub/src/sync/messageService.ts:58-60, 319-374`:
   - `toVisibleDecryptedMessages` maps stored rows directly without compacting superseded `codex:agent-run-update` snapshots.
   - `collectTurnRows` scans up to `TURN_PAGE_ROW_MAX = 2000` rows without a payload byte cap.

### Remediation Tasks

- [ ] **Task 1.1: Lower Default `TURN_PAGE_SIZE` to `8` & Export `TURN_PAGE_BYTE_BUDGET`**
  - **Files:**
    - `shared/src/turnBoundary.ts`
  - **Changes:**
    - Update `TURN_PAGE_SIZE = 8` (matching `bobmcmxciv/hapi`'s `DEFAULT_MESSAGE_TURNS = 8`).
    - Export `export const TURN_PAGE_BYTE_BUDGET = 1024 * 1024` (1 MiB).

- [ ] **Task 1.2: Implement `compactAgentRunUpdateMessages` in `@hapi/protocol`**
  - **Files:**
    - `shared/src/messages.ts`
    - `shared/src/index.ts` (if re-exported)
  - **Changes:**
    - Add a pure helper `readAgentRunUpdateMeta(content: unknown): { callId: string; status: string } | null` that extracts `callId` (from `callId | id | tool_use_id | runId`) and normalized `status` when `content` is a `{ role: 'agent', content: { type: 'codex', data: { type: 'agent-run-update', ... } } }` envelope.
    - Add `compactAgentRunUpdateMessages<T extends { content: unknown }>(messages: readonly T[]): T[]`:
      - For each `callId`, preserve:
        1. The **first** `agent-run-update` message in window order (preserves earliest `createdAt` / `startedAt` and initial `input` metadata);
        2. The **last** non-terminal (`status === 'running' | 'in_progress' | 'pending' | ''`) `agent-run-update` message in window order (preserves latest `progress`, `activity`, `statusText`, `detail`);
        3. Every **terminal** `agent-run-update` message (`completed`, `failed`, `errored`, `cancelled`, `aborted`, `stopped`, `interrupted`).
      - All superseded intermediate `running` updates for the same `callId` are dropped.
      - Fast path: if no superseded intermediate `agent-run-update` exists, return `messages as T[]` without allocation.

- [ ] **Task 1.3: Enforce `TURN_PAGE_BYTE_BUDGET` & Stream Compaction in `hub/src/sync/messageService.ts`**
  - **Files:**
    - `hub/src/sync/messageService.ts`
  - **Changes:**
    - In `toVisibleDecryptedMessages(rows)` (`hub/src/sync/messageService.ts:58-60`), apply `compactAgentRunUpdateMessages` after filtering with `isWebVisibleStoredMessage` so REST `/messages` responses never serialize hundreds of obsolete subagent progress snapshots.
    - In `collectTurnRows` (`hub/src/sync/messageService.ts:319-374`):
      - Track accumulated serialized byte estimate (`rowByteEstimate(row)`) over the retained compacted rows.
      - When accumulated bytes exceed `TURN_PAGE_BYTE_BUDGET` (`1024 * 1024`):
        - If at least 1 human turn boundary (`lastBoundaryIndex >= 0`) has been reached, slice at `lastBoundaryIndex` (`collected.slice(lastBoundaryIndex)`) and return `hasMore: true`.
        - If 0 human turn boundaries have been reached yet (a single giant turn exceeding 1 MB), stop scanning further batches and return the compacted slice with `hasMore: true`.

- [ ] **Task 1.4: Unit Tests for Phase 1**
  - **Files:**
    - `shared/src/messages.test.ts` (or `shared/src/turnBoundary.test.ts`)
    - `hub/src/sync/messageService.test.ts` (or `hub/src/store/messages.test.ts`)
  - **Changes:**
    - Verify `compactAgentRunUpdateMessages` reduces 100 intermediate `running` updates for `callId: "subagent-1"` down to 2 rows (first + latest running) or 3 rows (first + latest running + completed), and verify `reduceTimeline` produces deep-equal `ToolCallBlock` output before and after compaction.
    - Verify `getMessagesPage` with `turns` respects `TURN_PAGE_BYTE_BUDGET = 1024 * 1024` and cuts cleanly at a human turn boundary when possible.

---

## Phase 2: Turn-Preserving Frontend Window Trimming & `@assistant-ui` Runtime Message Bypass

### Problem Statement & Code Evidence
1. In `web/src/lib/message-window-store.ts:755-818` (`trimConversation`):
   ```ts
   const turnLimit = options?.turnLimit ?? TURN_WINDOW_MAX
   if (turnLimit > 0 && ordered.some(isHumanTurnStart)) {
       const keptTurns = mode === 'tail'
           ? sliceTailTurns(ordered, turnLimit)
           : sliceHeadTurns(ordered, turnLimit)
       const regularKept = keptTurns.filter((message) => !isQueuedMessage(message))
       const regularTrimmed = sliceForTrim(regularKept, Math.max(0, regularLimit - queuedBudget), mode)
       return mergeTrimmedWithQueued(ordered, regularTrimmed, queued)
   }
   ```
   Because `regularLimit` defaults to `VISIBLE_WINDOW_SIZE = 400`, any turn-paginated response with >400 raw messages (e.g. `1,097` rows on `80600201` or even 8 turns with 60 tool/subagent rows each = 480 rows) gets sliced mid-turn at 400 rows, discarding the user prompt at the start of the turn and updating `oldestPositionSeq` to the mid-turn row (`applyLatestResponse`, line 1347).
2. In `web/src/lib/assistant-runtime.ts:603-680, 720`:
   When `props.entityStore` is active, `HappyThread` renders `StoreThreadMessagesById` (`HappyThread.tsx:110-131`), which reads `useSessionTimelineIndex(store)` directly and never uses `@assistant-ui`'s `ThreadMessage` list. Yet `useHappyRuntime` still subscribes to `props.entityStore.subscribeRuntimeTopology` and runs `messageCacheRef.current.reconcile(...)` on every turn/history update.

### Remediation Tasks

- [ ] **Task 2.1: Compact `agent-run-update` & Preserve Turn Boundaries in `web/src/lib/message-window-store.ts`**
  - **Files:**
    - `web/src/lib/message-window-store.ts`
  - **Changes:**
    - Export `MAX_TURN_WINDOW_ROWS = TURN_PAGE_ROW_MAX * 4` (`8000`).
    - In `dropSupersededStreamSnapshots(messages)` (`message-window-store.ts:697-728`), also pipe through `compactAgentRunUpdateMessages` so live SSE + older page merges in the browser automatically drop superseded `agent-run-update` snapshots.
    - In `trimConversation(messages, mode, limit, options)` (`message-window-store.ts:755-818`):
      - When `options?.limit === undefined` (no explicit row limit passed by caller) and `turnLimit > 0 && ordered.some(isHumanTurnStart)`:
        - Slice turns via `sliceTailTurns(ordered, turnLimit)` / `sliceHeadTurns(ordered, turnLimit)`.
        - Do **not** slice `regularKept` down to `VISIBLE_WINDOW_SIZE = 400`!
        - Only apply a safety ceiling at `MAX_TURN_WINDOW_ROWS` (`8000`), and if `regularKept.length > MAX_TURN_WINDOW_ROWS`, snap the cut index to the nearest `isHumanTurnStart` boundary (if one exists after index 0) so trimming never creates an avoidable headless turn.
      - When an explicit `options.limit` *is* passed (e.g., unit tests explicitly testing row-count trimming with `{ limit: 5 }`), honor `options.limit`.

- [ ] **Task 2.2: Bypass `@assistant-ui` `ThreadMessage[]` Reconciliation in `useHappyRuntime` When `entityStore` Is Active**
  - **Files:**
    - `web/src/lib/assistant-runtime.ts`
  - **Changes:**
    - Define `const COMPOSER_ONLY_THREAD_MESSAGES: readonly ThreadMessage[] = []`.
    - In `useHappyRuntime` (`web/src/lib/assistant-runtime.ts:601-743`):
      - When `props.entityStore != null`:
        - Do **not** subscribe to `props.entityStore.subscribeRuntimeTopology` (`NO_STORE_SUBSCRIBE` / `NO_STORE_VERSION`).
        - Skip `standaloneEntries`, `standaloneTurns`, `findTailAssistantBlock`, and `messageCacheRef.current.reconcile(...)`.
        - Pass `messages: COMPOSER_ONLY_THREAD_MESSAGES` to `useExternalStoreRuntime(adapter)`.
      - Preserve the existing `HappyThreadMessageCache.reconcile` path when `props.entityStore == null` (standalone/legacy runtime tests).

- [ ] **Task 2.3: Unit Tests for Phase 2**
  - **Files:**
    - `web/src/lib/message-window-store.test.ts`
    - `web/src/lib/assistant-runtime.test.ts` (or `web/src/components/SessionChat/SessionChatIsolation.test.tsx`)
  - **Changes:**
    - Verify `applyLatestResponse` with 600 messages across 5 human turns retains all 5 turns and keeps `oldestPositionSeq` at the first human turn instead of slicing to 400 messages mid-turn.
    - Verify `useHappyRuntime` with `entityStore` does not invoke `HappyThreadMessageCache.prototype.reconcile` and keeps `adapter.messages` at `COMPOSER_ONLY_THREAD_MESSAGES` (`length === 0`) across `prepend-history` and new turns.

---

## Phase 3: Single-Step History Load Termination, Initial-Pin Nested Scroll Fix & Offscreen Turn Windowing

### Problem Statement & Code Evidence
1. In `web/src/components/AssistantChat/threadScrollHelpers.ts:692-719` (`loadUntilVisibleBoundaryChanges`):
   ```ts
   while (pagesLoaded < maxPages) {
       ...
       const nextCount = countVisibleMessageElements(viewport)
       const nextTopAnchorId = getTopMessageAnchorId(viewport)
       const nextTopTurnComplete = !isTopTurnHeadlessAssistant(viewport)
       if ((nextCount > initialCount || (nextTopAnchorId !== null && nextTopAnchorId !== initialTopAnchorId))
           && nextTopTurnComplete) {
           return outcome
       }
   }
   ```
   When a turn has >2,000 raw rows or exceeds the 1 MB byte budget, a single `loadOlder()` page legitimately prepends new tool/subagent blocks (`nextTopAnchorId !== initialTopAnchorId`) while the top turn is still an assistant continuation (`nextTopTurnComplete === false`). Requiring `&& nextTopTurnComplete` forces up to `maxPages = 8` sequential network requests before releasing `isLoadingMoreMessages`.
2. In `web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts:408-426` (`handleUpwardWheelDuringInitialPin`):
   ```ts
   if (target && target.closest('[data-hapi-nested-scroll="true"], pre')) {
       return
   }
   ```
   If the user scrolls up while their pointer is over a `<pre>` block that is already at `scrollTop === 0`, the wheel event is ignored by `handleUpwardWheelDuringInitialPin`, the browser scrolls the outer `viewport`, and `handleViewportScrollDuringInitialPin` (`398-407`) immediately snaps `viewport.scrollTop` back to the bottom!
3. In `web/src/components/AssistantChat/HappyThread.tsx:110-131` (`StoreThreadMessagesById`):
   Every entry in `timelineEntries` is unconditionally mounted into the DOM, causing DOM node counts to grow unboundedly as the user scrolls up through history.

### Remediation Tasks

- [ ] **Task 3.1: Stop `loadUntilVisibleBoundaryChanges` as Soon as Visible Content Changes**
  - **Files:**
    - `web/src/components/AssistantChat/threadScrollHelpers.ts`
  - **Changes:**
    - Export `MAX_CONSECUTIVE_EMPTY_OLDER_LOADS = 3`.
    - In `loadUntilVisibleBoundaryChanges`:
      - As soon as `nextCount > initialCount || (nextTopAnchorId !== null && nextTopAnchorId !== initialTopAnchorId)` is true, return `outcome` immediately (1 page per user scroll gesture when the page contains visible blocks).
      - Only continue looping (up to `Math.min(maxPages, MAX_CONSECUTIVE_EMPTY_OLDER_LOADS)`) when a fetched page produced **zero** new visible elements (`nextCount === initialCount && nextTopAnchorId === initialTopAnchorId`), e.g. a page consisting solely of hidden metadata/receipts.

- [ ] **Task 3.2: Unpin `INITIAL_PINNING` When Nested Scrollable `<pre>` Cannot Scroll Up Further**
  - **Files:**
    - `web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts`
  - **Changes:**
    - Add helper `canNestedElementScrollUp(target: Element | null, viewport: HTMLElement): boolean`:
      - Walk up `.closest('[data-hapi-nested-scroll="true"], pre')` inside `viewport`.
      - Return `true` **only** if an ancestor element has `el.scrollHeight > el.clientHeight && el.scrollTop > 0`.
    - In `handleUpwardWheelDuringInitialPin`:
      - Only early-return when `canNestedElementScrollUp(target, viewport)` is `true`. When the nested `<pre>` is at `scrollTop <= 0` (or is not vertically scrollable), `event.deltaY < 0` immediately transitions `scrollPhaseRef` from `'INITIAL_PINNING'` to `'UNPINNED'` and clears `initialPinningUntilRef`.

- [ ] **Task 3.3: Height-Cached Offscreen Turn Windowing in `StoreThreadMessagesById`**
  - **Files:**
    - `web/src/components/AssistantChat/HappyThread.tsx`
  - **Changes:**
    - In `StoreThreadMessagesById`, track measured heights per `entry.id` via a shared `ResizeObserver` and maintain the active visible range `[startIndex, endIndex]` with generous overscan (`OVERSCAN_PX = 1200`, always keeping the tail 6 entries and head 2 entries mounted so top/bottom sentinels and live tail streaming never flicker).
    - When `timelineEntries.length > 24`, render entries outside the overscan window that already have a recorded height as lightweight anchor placeholders:
      ```tsx
      <div
          key={entry.id}
          id={getConversationMessageAnchorId(entry.id)}
          data-message-id={entry.id}
          data-thread-entry-id={entry.id}
          data-hapi-message-role={entry.role}
          data-hapi-virtual-placeholder="true"
          className="aui-message-root happy-message scroll-mt-4"
          style={{ height: `${measuredHeight}px` }}
      />
      ```
    - Keeping `id={getConversationMessageAnchorId(entry.id)}` and `className="aui-message-root happy-message"` on placeholders ensures `captureThreadScrollState`, `restoreThreadScrollState`, `getTopMessageAnchorId`, and outline `document.getElementById(anchorId)?.scrollIntoView()` work seamlessly without layout jumps.

- [ ] **Task 3.4: Unit Tests for Phase 3**
  - **Files:**
    - `web/src/components/AssistantChat/useThreadScrollAndHistoryController.test.tsx`
    - `web/src/components/AssistantChat/HappyThread.pagination.test.tsx`
  - **Changes:**
    - Update/add test in `useThreadScrollAndHistoryController.test.tsx` verifying that:
      - When a page prepends a headless assistant turn (`nextTopAnchorId !== initialTopAnchorId`), `loadUntilVisibleBoundaryChanges` resolves after **1** `loadMore()` call instead of looping 8 times.
      - When a page adds 0 visible DOM elements, `loadUntilVisibleBoundaryChanges` retries up to `MAX_CONSECUTIVE_EMPTY_OLDER_LOADS = 3` until a visible block appears.
      - Scrolling up with the wheel (`deltaY < 0`) over a `<pre>` whose `scrollTop === 0` during `INITIAL_PINNING` unpins immediately and does not snap back to the bottom.

---

## Phase 4: Golden Fixtures, Cross-Package Tests & Live Runtime Verification

- [ ] **Task 4.1: Regenerate Golden Fixtures & Run Full Test Suite**
  - **Commands:**
    - `bun run gen:fixtures`
    - `bun typecheck`
    - `bun run test`
  - **Gate:** Zero TypeScript errors, all `shared`, `hub`, `cli`, `web`, and `fork-features` tests green, and `shared/fixtures/**` up to date.

- [ ] **Task 4.2: Live Verification on `http://10.202.2.224:5174/`**
  - Verify against session `80600201-a0f3-42b3-9ba0-af9b887f2a94` (`新训练 ScaleGPP-Step2`) and `90bfb47e` (`2026未见细胞系基因扰动高性模型调研`):
    - Initial window preserves all downloaded turns without slicing at 400 raw messages;
    - `agent-run-update` compaction collapses redundant subagent progress snapshots;
    - Scrolling up triggers a single-page load that completes immediately without sticking on `Loading...` or snapping back to the bottom;
    - `@assistant-ui` runtime holds `0` `ThreadMessage` copies in `entityStore` mode.
