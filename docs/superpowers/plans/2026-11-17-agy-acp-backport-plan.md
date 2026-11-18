# Antigravity (`agy acp`) Upstream Backport + Fork `hapimcp` & `usage_update` Plan

## Goal & Scope
1. Create a new feature branch `feat/agy-acp-backport` from `HEAD` (`a95392e7`, `v0.29.0-fork.57`).
2. Backport upstream `tiann/hapi` Antigravity ACP integration (`main` up to `37446bcf`: PRs `#2244`, `#2248`, `#2319`, `#2330`, `#2309`, `#2387`, `#2405`, `#2401`, `#2332`, `#2331`, `#2454`) **plus** open PR `#2399` (`ce377fa0..77e75caa`: `--dangerously-skip-permissions` for `always-proceed`, `auto` permission mode, zero hidden wakeup prompts) onto this fork, preserving all fork-owned features (`omp`, `TurnExecutionRail`, `sessionInventory`, `multi-user`, `session-fork`, `#175` inline media, `#176` `send_file`).
3. Add two fork-specific enhancements that upstream lacks:
   - **`hapimcp` injection**: Start `buildHapiMcpBridge` in `AgyAcpRemoteLauncher` and pass `hapi` stdio MCP in `mcpServers` to `newSession` / `resumeSession`; expose `'hapi'` (injected) + user `mcp_config.json` in `cli/src/modules/common/sessionInventory.ts`.
   - **`usage_update` context window bar**: Forward context-only `token_count` (`contextTokens` / `contextWindow` from `agy 1.5.10`'s `usage_update`) so the Web Composer context meter works without double-counting round tokens.
4. **Out of scope**: Do NOT port `#2389` / `#2471` (`cli/src/modules/common/usage/*` is `fork-owned #173`). Do NOT push to any remote (`mine` / `origin`) and never connect any test runner to the production hub.

---

## Ordered Execution Steps

### Step 0: Branch Setup, Plan Persistence & Temporary Upstream Fetch
1. Verify clean working tree (`git status -sb`), create and switch to `feat/agy-acp-backport`.
2. Persist this plan to `docs/superpowers/plans/2026-11-17-agy-acp-backport-plan.md`.
3. Fetch the exact upstream commits into temporary local refs (`refs/tmp/tiann-main`, `refs/tmp/tiann-pr2399-base`, `refs/tmp/tiann-pr2399`).
   - Always take `refs/tmp/tiann-main` (`37446bcf`) first for `cli/src/agy/*`, and then apply `refs/tmp/tiann-pr2399-base..refs/tmp/tiann-pr2399` on top so `#2454`'s `/swarm` & slash-command negotiation is preserved.

---

### Step 1: `shared/` Protocol, Schemas & Catalog Parity
1. **Add `shared/src/agyModels.ts` & `shared/src/agyModels.test.ts`** (from `refs/tmp/tiann-main`), re-export from `shared/src/index.ts`, keep `shared/src/models.ts` (`AGY_MODEL_LABELS` & `LEGACY_AGY_MODEL_LABELS`) intact.
2. **Edit `shared/src/modes.ts` & `shared/src/modes.test.ts`**:
   - Update `AGY_PERMISSION_MODES` to `['request-review', 'acceptEdits', 'auto', 'plan', 'always-proceed'] as const` (includes `'auto'` from `#2399`). Keep `OMP_PERMISSION_MODES` untouched.
   - Update `isSteeringSupportedForSession(metadata)` so `flavor === 'agy'` returns `metadata?.agyProtocol === 'acp'`.
3. **Edit `shared/src/schemas.ts`**:
   - Add `agyProtocol: z.enum(['acp']).optional()` to `MetadataSchema`.
   - In `SessionModelRequestSchema`, add optional `effort: z.string().trim().min(1).nullable().optional()`.
4. **Edit `shared/src/agentConfig.ts` & `shared/src/flavors.ts` (+ tests)**:
   - `agentConfig.ts`: add `effort` field descriptor to `BUILTIN_DESCRIPTORS.agy`.
   - `flavors.ts`: include `'agy'` in `supportsEffort(flavor)` (preserving `'omp'`).
5. **Edit `shared/src/slashCommands.ts` & `shared/src/sessionCitation.ts`**:
   - Port `#2454` changes to `shared/src/slashCommands.ts` (`agy` built-in slash commands `/goal`, `/compact`, `/schedule`, `/browser`, `/plan`, `/grill-me`, `/teamwork`, `/learn`, `/boost`, `/run-workflow`, `/swarm` + `mergeSlashCommands`), and port `#2319` update to `shared/src/sessionCitation.ts` if applicable.
6. **Sync native catalogs**:
   - Update `shared/fixtures/catalogs/modes.json`, `android/core/protocol/src/main/kotlin/app/hapi/protocol/catalog/Modes.kt` (+ `CatalogTest.kt`), and `ios/Packages/HapiKit/Sources/HapiProtocol/Catalog/PermissionModes.swift` (+ `CatalogTests.swift`).

---

### Step 2: `cli/` Shared ACP Infrastructure Extensions
1. **Add `cli/src/agent/generationClock.ts`** (+ test if upstream has one).
2. **Edit `cli/src/agent/types.ts`**:
   - Add `FormElicitationRequest`, `FormElicitationResponse`, `AcpPromptHooks` (`onSent`, `onAnswered`), `nativeName`/`nativeArgs` on `tool_call`, `numTurns` on `usage`, optional `round_summary` if needed; preserve `InlineMediaSource`.
3. **Edit `cli/src/agent/backends/acp/AcpStdioTransport.ts` (+ `.test.ts`)**:
   - Preserve JSON-RPC error `code` / `data` on rejected requests.
4. **Edit `cli/src/agent/backends/acp/AcpMessageHandler.ts` (+ `.test.ts`)**:
   - Forward `nativeName` (`update.name`) and `nativeArgs` (`update.args`) on `tool_call` / `tool_call_update`, preserving fork `#175` `emitGeneratedImageFromAcpContent` / `buildAcpInlineMediaSource`.
5. **Edit `cli/src/agent/backends/acp/AcpSdkBackend.ts` (+ tests & `__fixtures__/agy-*.json`)**:
   - `elicitationForm?: boolean`, `supportsSessionResume()`, `resumeSession()`, `isTransportAlive()`, `setUserMessageChunkListener`, `onSent`/`onAnswered` hooks, `numTurns` extraction, full `AcpAvailableCommand` retention + `getAvailableCommands` + `setAvailableCommandsUpdateListener`.
6. **Edit `cli/src/modules/common/permission/AcpPermissionHandler.ts` (+ `.test.ts`)**:
   - Port `#2319`, `#2309`, `#2399` additions (`autoApprovalRules`, `autoApproveOnce`, `requiresUser`, `onUserWait`, parked wakeup seeding/claiming).
7. **Edit `cli/src/agent/sessionConfigRpc.ts` (+ `.test.ts`)**, `cli/src/modules/common/skills.ts`, `cli/src/modules/common/slashCommands.ts`, `cli/src/api/apiSession.ts`, and `cli/src/modules/pingPeer/pingPeer.ts`.

---

### Step 3: `cli/src/agy/` Full Port + Fork `hapimcp` & `usage_update` Enhancements
1. **Replace `cli/src/agy/` with `refs/tmp/tiann-main` (`37446bcf`) + PR `#2399` delta**:
   - Remove obsolete `cli/src/agy/headless/*` and old `cli/src/agy/utils/agy{ConversationModel,MessageText,SessionTitle,TranscriptTypes}*`.
   - Checkout `cli/src/agy/` and `cli/src/commands/agy.test.ts` from `refs/tmp/tiann-main`, then apply PR `#2399`'s delta and reconcile `legacyStreamJson/agyHeadlessDriver.ts` with local `a95392e7`.
2. **Fork Enhancement A — Inject `hapimcp` (`buildHapiMcpBridge`) in `cli/src/agy/agyAcpRemoteLauncher.ts`**:
   - Start `buildHapiMcpBridge(session.client, { enableChangeTitle: true, onChangeTitle: () => this.titleSync.markManualTitle(), skillLookup: { workingDirectory: session.path, flavor: 'agy' }, confirmDeleteExploration: (args) => this.confirmDeleteExploration(args) })` after `backend.initialize()` succeeds, and stop `happyServer` in `cleanup()`.
   - Pass `mcpServers` (`toAcpMcpServers(mcpServers)`) into `resumeSession` in `startBackendInner`, `newSession` in `startBackendInner`, and `resumeSession` in `advanceBackendCursor()`.
3. **Fork Enhancement B — Forward `usage_update` Context Meter in `cli/src/agy/agyAcpRemoteLauncher.ts`**:
   - Wire `backend.setUsageUpdateListener` and forward context-only `token_count` (`contextTokens`, `contextWindow`) while preserving `agyRoundSummary`.
4. **Update Fork `cli/src/modules/common/sessionInventory.ts` (+ `.test.ts`)**:
   - Replace `case 'agy': return EMPTY_FLAVOR_INVENTORY;` with `loadAgyInventory(input.cwd)` listing `{ name: 'hapi', source: 'injected' }` + `~/.gemini/config/mcp_config.json` + `.agents/plugins/*/mcp_config.json`.

---

### Step 4: `hub/` & `web/` Surgical Integration
1. **Hub (`hub/src/sync/syncEngine.ts`, `hub/src/sync/steerQueuedMessage.test.ts`, `hub/src/web/routes/sessions.ts`, `hub/src/web/routes/sessions.test.ts`)**:
   - `syncEngine.ts`: return AGY ACP-specific Steer error when `flavor === 'agy' && agyProtocol !== 'acp'`.
   - `sessions.ts`: allow atomic `{ model, effort }` for `claude` and `agy`.
2. **Web Chat Pipeline & Question Card (`web/src/chat/*`, `MessageMetadata.tsx`, `AskUserQuestionFooter.tsx`)**:
   - `types.ts`, `reconcile.ts`, `normalizeAgent.ts` (`normalizeAgyRoundSummary`), `reducerTimeline.ts`, `MessageMetadata.tsx` (`formatTokensPerSecond`, `buildAgyRoundLabels`), `AskUserQuestionFooter.tsx` + `askUserQuestion.ts` + `cursorAskQuestion.ts` + locales (`en.ts`, `zh-CN.ts`).
3. **Web Model / Effort / Permission Pickers (`NewSession` & Active Session Composer)**:
   - `web/src/api/client.ts`, `useSessionActions.ts`, `sessionChatHelpers.ts` (support `{ effort }` in `setModel`).
   - `modelOptions.ts`, `sessionModelLabel.ts`, `HappyComposer.tsx`, `useSessionFlavorModelController.ts` (reconcile `#2244` `getAgyModelChoices` + `splitAgyModelSelection` with `a95392e7`).
   - `NewSession/` (`PermissionField.tsx`, `EffortField.tsx`, `index.tsx`, `preferences.ts`, `newSessionFormDraft.ts`) & `codexFamilyPermissionAgents.ts` (`#2244`, `#2319`, `#2399`).

---

### Step 5: Fixtures, Docs, Verification & Cleanup
1. Update `web/scripts/fixtures/cases/agy.ts` (if changed upstream) and run `bun run gen:fixtures`.
2. Update `docs/guide/agents.md`, `cli/README.md`, and `docs/api/client-contract/rest.md`.
3. Run `bun typecheck` and `bun run test` (and Android `:core:protocol:test` if toolchain available).
4. Run isolated `agy 1.5.10` real-binary smoke check (`createAgyAcpBackend` + `startHappyServer` + `happyMcpStdioBridge`), killing all child processes immediately afterward.
5. Delete temporary git refs (`refs/tmp/tiann-*`) and populate `## Execution evidence` below.

---

## Execution evidence
- **Branch & Base**: `feat/agy-acp-backport` created from `a95392e7` (`v0.29.0-fork.57`); all branch changes staged cleanly (`git add -A`, no commits or remote pushes performed). Temporary upstream refs (`refs/tmp/tiann-main`, `refs/tmp/tiann-pr2399`, `refs/tmp/tiann-pr2399-base`) deleted and verified absent (`git show-ref | grep refs/tmp/tiann` empty). Further follow-up gap remediation recorded in [2026-11-18-agy-acp-remediation-plan.md](file:///data1/home/zhouy1/software/hapi/fork/docs/superpowers/plans/2026-11-18-agy-acp-remediation-plan.md).
- **Fixtures (`bun run gen:fixtures`)**: Regenerated `48` chat + `12` sse + `12` pagination fixtures + `catalogs/modes.json` (`fixtureVersion 1`); only `shared/fixtures/catalogs/modes.json` changed (`+15` lines adding `acceptEdits`, `auto`, `plan` for `agy`).
- **Typecheck (`bun typecheck`)**: Passed across `relay` (`1.19s`), `hub` (`6.40s`), `cli` (`12.54s`), `web` (`18.85s`), exit code `0`.
- **Full Test Suite (`TMPDIR=/tmp bun run test`)**: Passed exit code `0` (`TMPDIR=/tmp` avoids the host's `$HOME`-nested `TMPDIR` causing `sessionPrompts.test.ts` upward walk to hit `~/.claude/CLAUDE.md`):
  - `test:cli`: `275` files passed; `3268` passed, `1` skipped (`shellQuote.test.ts`), `0` failed (`84.71s`).
  - `test:hub`: `113` files; `1382` passed, `3` skipped (pre-existing `CursorLegacyMigrator` real `agent acp` integration tests), `0` failed (`28.04s`).
  - `test:web`: `356` files passed; `3657` passed, `0` failed (includes `fixtures.test.ts`, `NewSession/index.test.tsx`, `AgyModelSelector.test.tsx`, `AskUserQuestionFooter.test.tsx`, `normalizeAgent.test.ts`, `normalize.test.ts`, `reducer.test.ts`).
  - `test:shared`: `32` files; `349` passed, `0` failed (`1218.00ms`).
  - `test:fork-features`: `24` files; `178` passed, `0` failed (`345.00ms`).
- **Real-Binary Smoke Check (`agy 1.5.10` + `hapimcp` stdio bridge)**: Isolated one-shot Bun check (`TMPDIR=/tmp`, stub `ApiSessionClient`, zero hub connection) initialized `createAgyAcpBackend({ skipPermissions: true })` with `startHappyServer` + `hapi mcp` stdio bridge: `supportsResume=true`, `sessionId=18c5ff76-f94b-4e77-a1d8-c695aab0d255`, `toolNamesCount=26`, `currentModelId="gemini-4-carbon-medium"`, `availableModelsCount=28`, `availableCommandsCount=14`. Post-exit `ps -ef` confirmed zero orphan `hapi-agy-smoke` or `mcp --url` processes.
- **Native Catalogs (Android / iOS)**: Kotlin (`Modes.kt`, `Flavors.kt`, `CatalogTest.kt`) and Swift (`PermissionModes.swift`, `AgentFlavor.swift`, `CatalogTests.swift`) updated to match `shared/fixtures/catalogs/modes.json`. Local `./gradlew :core:protocol:test` could not run on this machine because Android Gradle Plugin 8.11.1 requires Java 17 while only Java 11 (`/usr/lib/jvm/java-11-openjdk-11.0.20.1.1-2.el9.x86_64`) is installed; iOS tests require macOS/Xcode (`ios.yml`).
