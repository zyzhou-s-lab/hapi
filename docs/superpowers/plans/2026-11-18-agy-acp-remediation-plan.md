# Antigravity (`agy acp`) Second-Pass Gap Remediation Plan

## Goal & Context
1. Remediate all remaining gaps identified in the second-pass audit of branch `feat/agy-acp-backport` (created atop `a95392e7`, `v0.29.0-fork.57`), building on [2026-11-17-agy-acp-backport-plan.md](file:///data1/home/zhouy1/software/hapi/fork/docs/superpowers/plans/2026-11-17-agy-acp-backport-plan.md).
2. Cover missed upstream prerequisites (`#2102`, `#2403`, `#2299`, `#1898`, `#1672`, `#2261`, `#1814`) plus fork-specific hardening (`hapimcp` / `call_mcp_tool` permission safety & `delete_exploration` scoping, hyphen/underscore MCP server parsing, `agy` skill write roots & dead `mcpEditTarget` cleanup, `usageService` `round-summary` accounting, `usage_update` window-only guard & `session_info_update` preservation, backend lifecycle & mode-sync fixes).
3. **Explicit non-goals**:
   - Do not modify Swift/Kotlin `ReducerTimeline` files (`ReducerTimeline.swift` / `ReducerTimeline.kt`) blindly on this Linux/Java-11 host without macOS Xcode or Java 17 Gradle toolchains, matching upstream `#2331`.
   - Do not commit or push to any remote (`mine` / `origin`), and never connect any test runner to the production hub.

---

## Ordered Execution Steps

### Step 1: Persist Change Plan Document
- Write this plan to `docs/superpowers/plans/2026-11-18-agy-acp-remediation-plan.md` before code edits.

### Step 2: `shared/` Schema & Model Label Fixes
1. `shared/src/schemas.ts`: add `toolCallId: z.string().optional()` to `AgentStateRequestSchema`.
2. `shared/src/models.ts` + `shared/src/agyModels.test.ts`: add stripped-family label fallback in `getAgyModelLabel` across both `AGY_MODEL_LABELS` and `LEGACY_AGY_MODEL_LABELS` (e.g. `gemini-4-argon` -> `'Gemini 4 Argon'`, `gemini-3.5-flash` -> `'Gemini 3.5 Flash'`), preserving exact variant labels.

### Step 3: Shared `cli/` ACP Infrastructure & Session Bootstrap Fixes
1. `cli/src/agent/backends/acp/AcpStdioTransport.ts` (+ `.test.ts`): port `#2403` `this.process.stdin.on('error', ...)` -> `markClosed(markAcpIndeterminate(error))`.
2. `cli/src/agent/backends/acp/AcpMessageHandler.ts` (+ `.test.ts`): port `#2299` (`isMetadataOnlyRawOutput` / `resolveToolResultOutput`) and `#1898` (`TEXT_IDLE_FLUSH_INTERVAL_MS`, `mayBeUnfinishedControlEnvelope`, `flushText('idle' | 'boundary')`), preserving fork `#175` `InlineMediaSource`.
3. `cli/src/agent/types.ts`, `cli/src/agent/backends/acp/AcpSdkBackend.ts` (+ `.test.ts`, `.initialize.test.ts`):
   - Add `nativeName?: string` / `nativeArgs?: unknown` on `PermissionRequest`; cache synchronous `tool_call`/`tool_call_update` metadata in `seenToolCalls` before async `sessionUpdateQueue` so `handlePermissionRequest` always sees `nativeName`, `nativeArgs`, and `rawInput`.
   - In `captureUsageUpdate`: return early on title-only `session_info_update` without wiping `latestUsageUpdate`; preserve known field when only one of `contextTokens`/`contextWindow` arrives.
   - In `beginSoftSteerPrompt`: `await this.sessionUpdateQueue` before draining buffers.
   - In `AcpSdkBackend.initialize.test.ts`: ensure `isAcpIndeterminateError` is present on mocked `./AcpStdioTransport`.
4. `cli/src/agent/sessionFactory.ts` (+ `.test.ts`), `cli/src/claude/utils/startHappyServer.ts` (+ `.test.ts`), `cli/src/codex/utils/buildHapiMcpBridge.ts`:
   - Preserve `acpManualTitle` and `agyProtocol` in `pickExistingSessionMetadata`.
   - Add `onChangeTitle?: (title: string) => void` option to `startHappyServer` and `buildHapiMcpBridge`.

### Step 4: `cli/src/agy/` & Permission / MCP Inventory / Session Config Fixes
1. `cli/src/modules/common/permission/AcpPermissionHandler.ts` (+ `.test.ts`): pass `toolCallId` to `onExplicitToolApproval`; downgrade `approved_for_session` -> `approved` for unattributed `call_mcp_tool` requests.
2. `cli/src/agy/agyToolCards.ts` (+ `.test.ts`): support longest exact/sanitized `knownServers` matching in `parseAgyEagerMcpToolName`, `mapAgyPermissionRequestTool`, and `mapAgyToolCall`; return canonical `'call_mcp_tool'` descriptor when `call_mcp_tool` permission lacks `ServerName`/`ToolName`.
3. `cli/src/agy/agyReactiveWakeup.ts` (+ `.test.ts`): match `^Run\s+(\S+)$` before `expectedDecodedArgs.Path` fallback in `areAgyToolArgsCompatible`.
4. `cli/src/agy/agyAcpRemoteLauncher.ts` (+ `.test.ts`) & `cli/src/agy/legacyStreamJson/index.ts`:
   - Wire `this.titleSync` across launcher lifetime + `enableChangeTitle: true` + `onChangeTitle` (plus `change_title` exact auto-approval in `BasePermissionHandler.ts`).
   - Cache configured `knownMcpServers` and pass to `mapAgyToolCall` / `mapAgyPermissionRequestTool`.
   - Replace integer `approvedDeleteExplorations` counter with `toolCallId`-keyed & target-scoped (`normalizeDeleteExplorationKey`) map, revoking on `tool_result` and deduplicating parked wakeups while `confirmDeleteExploration` is prompting; resolve parked `call_mcp_tool` `delete_exploration` cleanly.
   - Run `backend.initialize()` before `ensureMcpServers()`, clear `hapiMcpUrl` in `legacyStreamJson`, reset `lastContextUsage` on session ID change & set `currentModelId` early, re-apply `applyTurnConfig(..., { quiet: true })` in `advanceBackendCursor()`, preserve mid-turn `pendingIdleModeSync` (`keepPendingPermSync`) when draining an older-mode batch in `runTurn()` without triggering spurious post-turn relaunches, and guard `if (contextTokens === undefined) return;` in `emitContextUsage`.
5. `cli/src/modules/common/sessionInventory.ts`, `cli/src/modules/common/sessionConfigDetail.ts`, `cli/src/modules/common/skills.ts` (+ tests):
   - Use `sanitizeMcpServerToken(serverName)` in `mcpToolMatchesServer`, `liveToolLabels`, and `toolsFromNames` for `mcp_<server>_<tool>`.
   - Remove dead `if (flavor === 'agy')` branch in `mcpEditTarget`.
   - Add `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`, `.agent/skills`, `_agents/skills`, and `_agent/skills` to `userSkillWriteRoots()` / `projectSkillRoots()`.

### Step 5: `hub/` Background Tasks Snapshot & Usage Ledger Fixes
1. `hub/src/sync/backgroundTasks.ts`, `hub/src/sync/sessionCache.ts`, `hub/src/sync/syncEngine.ts`, `hub/src/startHub.ts`, `hub/src/socket/server.ts`, `hub/src/socket/handlers/cli/index.ts`, `hub/src/socket/handlers/cli/sessionHandlers.ts` (+ tests):
   - Add `extractBackgroundTasksSnapshot` (preserving `extractBackgroundTaskDelta` for Claude), `SessionCache.setBackgroundTaskCount`, `SyncEngine.handleBackgroundTaskCount`, and `onBackgroundTaskCount` wiring; intercept `system/background_tasks_changed` in `sessionHandlers.ts` before `store.messages.addMessage`, call `committed()`, and return without writing a DB message row.
2. `hub/src/sync/usageService.ts` (+ `.test.ts`): parse `round-summary` (`provider: 'agy'`, `summary.agy_usage`) in `parseUsageEvent` with `'excludes-cache'` normalization.

### Step 6: `web/` Status Labels, `AgyModelSelector`, `AskUserQuestionFooter`, & `token_count` Model Fixes
1. `web/src/lib/codexStatusLabels.ts` (+ `.test.ts`): include `'agy'` alongside `'pi'` in `getReasoningEffortForFlavor` and `shouldShowReasoningStatusLabel`.
2. `web/src/components/NewSession/AgyModelSelector.tsx` (+ `AgyModelSelector.test.tsx`) & locales (`en.ts`, `zh-CN.ts`): add `withSelectedModel` and `'newSession.agyModel.notListed'`.
3. `web/src/components/ToolCard/AskUserQuestionFooter.tsx` (+ `.test.tsx`): guard `computeAnswersForQuestion` with `question.allowFreeText !== false`.
4. `web/src/chat/normalizeAgent.ts` (+ `web/src/chat/normalize.test.ts`): preserve `model` on normalized `token_count` messages.

### Step 7: Fixture Regeneration & Full Verification Suite
- Run `bun run gen:fixtures`, `bun typecheck`, and `TMPDIR=/tmp bun run test`.

### Step 8: Documentation Evidence & Clean Git Index Staging
- Update `docs/api/client-contract/messages.md`, `fork-features/trunk-patches.md`, and `## Execution evidence` in both plan documents.
- Stage all tracked + untracked branch changes cleanly (`git add -A`), without committing or pushing.

---

## Execution evidence
- **Fixtures (`bun run gen:fixtures`)**: Regenerated `48` chat + `12` sse + `12` pagination fixtures + `catalogs/modes.json` (`fixtureVersion 1`). Only `shared/fixtures/catalogs/modes.json` (`+15` lines for `agy` modes) differs from `HEAD`; zero unexpected diffs across generated chat/SSE/pagination fixtures.
- **Typecheck (`bun typecheck`)**: Exited `0` across all packages:
  - `typecheck:relay`: passed (`1.19s`)
  - `typecheck:hub`: passed (`6.40s`)
  - `typecheck:cli`: passed (`12.54s`)
  - `typecheck:web`: passed (`18.85s`)
- **Full Test Suite (`TMPDIR=/tmp bun run test`)**: Exited `0` across all 5 workspaces (`TMPDIR=/tmp` avoids host `$HOME`-nested `$TMPDIR` breaking `sessionPrompts.test.ts`):
  - `test:cli`: `275` files passed; `3268` passed, `1` skipped (`shellQuote.test.ts` pre-existing), `0` failed (`84.71s`)
  - `test:hub`: `113` files; `1382` passed, `3` skipped (pre-existing `CursorLegacyMigrator` real `agent acp` tests), `0` failed (`28.04s`)
  - `test:web`: `356` files passed; `3657` passed, `0` failed (`11.41s`)
  - `test:shared`: `32` files; `349` passed, `0` failed (`1218.00ms`)
  - `test:fork-features`: `24` files; `178` passed, `0` failed (`345.00ms`)
- **Documentation & Staging**:
  - Updated `docs/api/client-contract/messages.md`, `fork-features/trunk-patches.md`, and both plan documents.
  - Staged all branch changes cleanly via `git add -A` on `feat/agy-acp-backport` with zero unstaged or untracked source/doc files (no commits or remote pushes performed).
- **Platform Note**: Native Android (`:core:protocol:test`, requires Java 17; host has Java 11) and iOS (`swift test`, macOS/Xcode) remain unchanged in this remediation pass (`ReducerTimeline.swift`/`.kt` intentionally not blindly edited without native toolchains, matching upstream `#2331`).
