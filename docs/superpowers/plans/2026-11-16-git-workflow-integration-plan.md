# HAPI Git workflow integration

## Approved scope

Implement the composer Git workflow in `answer-in-grid`: branch/workspace selection, state-aware Git actions including PR creation, and scope-consistent Changes/File Diff. Preserve existing sidebar/typography work and unrelated edits. Leave all work uncommitted; no push, merge, release or deployment of this checkout. Git write verification is restricted to disposable local repositories/remotes. Never connect a test runner to production.

## User surface

- One quiet Git trigger in the composer status row. Align connection state, icons and text with a common center/line-height; remove per-element top compensation.
- Responsive three-group panel: branch/workspace, actions, Changes. Existing HAPI theme variables and controls, no new UI dependency; desktop popover and phone bottom sheet with 44px targets.
- Show full branch/path in the panel, explicit detached/non-repository/offline/error states and inline operation prerequisites. Long trigger labels truncate without hiding the complete panel identity.
- Search local/remote branches and existing worktrees. Another worktree opens an authorized existing session or prefills New Session; creating from a branch creates a separate worktree/session. Never rewrite or checkout the cwd of an existing agent.
- Changes opens existing Files/per-file Diff surfaces with the chosen comparison scope. Preserve composer draft and scope when navigating back.

## Comparison and commit semantics

- Default `working`: HEAD to final tracked worktree net diff, plus separately identified untracked files. Count unique paths; retain staged/unstaged status even when net line delta is zero.
- `staged` and `unstaged` retain index-layer inspection. `branch`: merge-base(selected baseRef, HEAD) to HEAD, committed changes only.
- Base ref is explicit and retained by repository/session view. Prefer an identified remote default branch; never assume `main`. No count-based scope switching.
- Composer totals and popup/file list derive from the same query result and scope. Reuse existing transport/execution; no independent snapshot protocol or new authorization/retry framework.
- Binary/unknown line counts are not fake zeros. Renames retain old/new identity and count as one entry.
- The conversation preparation requests staged-only commits by default and explicit complete-file selection for additional staging, never implicit `git add -A`. This is an Agent instruction, not a frontend-enforced file boundary.

## Action rules

- Dirty => Commit preparation; clean/ahead/not-behind => Push preparation; clean/behind-only => Pull preparation; divergence => explanation, no automatic sync; clean branch delta/no PR => Create PR preparation. Explicit entries also offer Commit + Push and Commit + Push + PR.
- Choosing an action sends a normal `/git <action>` user message. A strict, matching `hapi-git-draft` JSON result produces an editable in-thread instruction with repository/branch/HEAD and reviewed parameters. Invalid or stale results have no Send control. Explicit Send appends a new user message; this is not assistant-ui's edit-and-branch operation on an earlier message.
- Preparation requests read-only inspection. The follow-up requests state rechecks, explicit staging, normal push, clean ff-only pull, separate default-branch acknowledgement, owning-machine `gh`, first-failure stop and no successful-commit replay. The Agent's current permissions govern execution; neither these prompts nor schema matching enforce those safety properties. The former confirmation dialog and automatic unfinished-suffix continuation are removed.
- Independent Git sends wait for their correlated HTTP settlement, not optimistic acceptance. Failed delivery retains inline edits and is excluded from main-composer recovery. Git sends do not consume the main draft, attachments, schedule or send intent. Cancel retains a local read-only draft with Edit to reopen. Busy/inactive sessions block submission, not inspection.

## Implementation ownership and order

1. Shared validated contracts and existing CLI Git handler extensions: scoped repository reads, refs/worktrees, explicit stage/commit/push/pull/PR. Extend runner worktree spawn with selected base ref.
2. Existing Hub session-authorized REST/RPC and Web API/query integration. Hub derives session target; Git/gh run only on the owning CLI/runner. Browser cannot supply arbitrary shell/cwd. Reuse existing access/path checks.
3. Fork-owned Web source-control components with thin StatusBar/Files/NewSession integration; migrate affected read callers instead of keeping duplicate summary logic.
4. Necessary behavior tests, real temporary-repository smoke, rendered desktop/mobile UI exercise, all-package typecheck and affected test suites; update package docs and this plan with evidence.

## Acceptance

- Scoped totals, unique-file counts, list and clicked Diff agree for staged+unstaged same-path changes, rename, untracked, binary and zero-net-diff states.
- Branch comparison uses the selected merge base and excludes uncommitted changes. Missing base, detached HEAD, unborn branch, no remote, offline and Git failures are explicit.
- Worktree/ref selection never moves the current session or drops its draft. Creation uses the selected start ref and respects runner workspace roots.
- Preparation and edited follow-up appear as ordinary user messages; follow-up is never automatically sent. Mismatched/malformed results cannot become an editable action. Pending sends reject duplicate clicks; failed delivery preserves edits for explicit retry.
- Git delivery failures do not restore Git text or queue intent into the main composer; its schedule and attachment order survive failure and retry. RPC safety tests remain backend-specific, not evidence of Agent execution constraints.
- Desktop keyboard focus/Escape and phone bottom-sheet navigation work with no horizontal overflow; read-only inspection remains available when writes are not.

## Execution evidence

Implemented in this worktree without commits:

- Hub: `GET /sessions/:id/git-status` forwards `details`, `scope`, `baseRef`; `GET /sessions/:id/git-diff-file` forwards `scope`/`baseRef`; `POST /sessions/:id/git-action` validates `GitActionRequest`, requires an active session, rejects agent-busy/pending/steering sessions with `409 agent_busy`, derives `cwd` only from session metadata, and forwards `RPC_METHODS.GitAction`. Gateway/engine carry the same option shapes.
- Web transport: `ApiClient.getGitRepository` (`details=true`), `runGitAction`, and `getGitDiffFile(sessionId, path, staged?, {scope, baseRef})`; `queryKeys.gitRepository(sessionId, scope, baseRef)` plus all-scope invalidation; `useGitRepository` shares one scoped key, keeps cached data offline, and returns `null` from `refetch` on any error or unsuccessful response.
- Web surfaces: Files renders one unique `repository.files` list with scope/baseRef picker, staged/unstaged/untracked/rename/binary/unknown/zero-net states; file route carries `{path, scope, baseRef}` and scopes the diff query and scroll-storage identity. Old `useGitStatusFiles`/`gitParsers` summary path removed.

Transport-slice checks reported by its implementation worker:

- `bun run typecheck` → cli, web, hub, relay all completed with no errors.
- `cd hub && bun test src/web/routes/git.test.ts` → 25 pass, 0 fail (scoped read forwarding, scope validation, inactive/busy rejection, browser-cwd rejection).
- `cd web && bunx vitest run src/fork-features/source-control src/routes/sessions/files.test.tsx src/routes/sessions/file.test.tsx` → 26 pass, 0 fail (scope persistence, shared key, offline cache, failed-refresh null, unique/binary/rename/zero-net list, exact scoped diff, dialog/action tests).

The transport slice used a fake engine rather than a live authorized Hub/CLI connection. The parent subsequently added `sourceControl.unknownLines` in both English and Simplified Chinese. No production connection or publication of this checkout.

### Integrated implementation

- Composer: one Git trigger with shared status-row alignment; branch/workspace, actions and Changes groups; desktop popover and phone bottom-sheet styles. Cursor also receives the source-control slot. Existing Files, Diff and New Session routes are reused.
- Workspace selection: authorized existing sessions are opened by machine/path; other worktrees prefill New Session. Selected refs are resolved to immutable commits before creating a separate branch/worktree. Active checkout and existing linked worktrees are not switched. Explicit-ref Cursor sessions avoid nested native worktree creation.
- Conversation actions: `SourceControl` sends ordinary preparation messages through `useGitChatSend`; the Markdown language override renders matching results in `GitDraftEditor`. Explicit Send appends the edited instruction through the same independent chat path. The old action dialog and unfinished-suffix helper/tests are deleted. Existing PRs suppress duplicate creation; PR readiness uses committed branch delta independently of the Changes scope.
- The retained backend Git API uses fixed argv, literal pathspecs, staged-only commit, normal push, clean ff-only pull, state preconditions and per-repository serialization. The current frontend conversation flow does not call that API and must not claim its protections. External Git activity remains non-atomic.
- Scoped state: working/staged/unstaged/branch persist per session, including an explicitly empty scope. Composer, Files and per-file Diff share scope/base identity. Renames are unique paths; binary/unknown line counts remain nullable. No guessed default branch and no nonempty-scope substitution.
- Package documentation updated in `web/README.md`, `hub/README.md` and `cli/README.md`, including `git-action`, comparison semantics, owning-machine prerequisites and selected-ref runner requirements.

### Historical verification before the conversation cutover

- Parent final integration check: `bun run typecheck` completed successfully for CLI, Web, Hub and Relay after the locale additions.
- Parent focused regressions: actions 7, confirmation dialog 3, StatusBar 7, SourceControl 2 — 19 passing tests across separate runs. SourceControl covers empty staged-scope persistence through remount and remote-ref navigation to a separate worktree session without calling a Git write. Dialog tests cover explicit staging/reviewed digests, successful-commit/failed-push continuation and default-branch acknowledgement.
- An expanded affected-Web command also exercised source-control, Files/Diff, New Session and composer-draft suites. Its captured output was truncated; no aggregate pass count or final success is claimed from that capture.
- CLI worker: scoped repository/action/RPC-smoke suites reported 23 passing tests. The real temporary-repository smoke staged and committed, pushed to a disposable local bare remote, then fetched and ff-only pulled in another clone; returned heads matched bare refs. No GitHub remote was used; PR tests use an executable fake `gh`.
- Worktree worker: worktree 5 and CLI-argument 41 tests passed; a real temporary repository created the new worktree from the selected earlier commit while the original checkout, linked worktree and uncommitted files remained unchanged. Unknown refs and option-like refs were rejected without creating directories. Its full CLI run reported 2,850 pass / 1 skipped across 255 files; shared tests reported 338 pass.
- Transport worker subsequently reported full Hub tests: 1,376 pass / 0 fail, including the corrected positional spawn arguments. Its scoped Git route tests reported 25 pass / 0 fail.
- Parent isolated Chromium smoke mounted the real `StatusBar`, `SourceControl` and `useComposerDraft` under the existing Query/I18n providers and an in-memory router, using the component tests' mock-API pattern. At 1280×900: the panel rendered the full branch/path, Escape returned focus to the Git trigger, empty staged scope survived Files navigation/back, branch Diff navigation carried the exact path/scope/base, and selecting `origin/topic` navigated to a separate worktree New Session target. These navigation/inspection checks made zero Git-action calls.
- At 390×844: the actual phone Dialog occupied x=0…390, bottom=844, height=626 (within 88dvh), with document width=390. All ten visible panel button/summary/select targets measured 44px. Tab stayed inside the modal and Escape restored trigger focus. The commit confirmation stayed at x=12…378, its three buttons measured 44px, and Confirm remained disabled for an unstaged-only commit. Phone scoped-Diff navigation/back restored the draft-hook text. No page errors were observed. Inspected screenshots: `/tmp/hapi-git-verified-desktop.png` and `/tmp/hapi-git-verified-mobile.png`.
- The lightweight fixture used navigation-target probes, not the full Files/New Session pages or the real chat composer adapter; existing route/component tests separately cover those destinations. Two smoke locator mismatches (base-selector label and duplicate Close buttons) were corrected without changing product code. The owned browser/context closed successfully, temporary fixture files were deleted, and Vite session 3 was stopped (SIGTERM, exit 143). An earlier existing-app browser attempt timed out; no full authenticated-app pass is claimed.

### Verification boundaries and operational requirements

- The isolated smoke proves rendered light-theme desktop/phone controls and draft-hook text restoration across navigation, not a full authenticated chat composer/attachment → Files/Diff → back round-trip. Dark/OLED, other browsers and real mobile devices were not exercised in this Git-panel pass.
- Full structured Web → Hub → CLI integration and real GitHub PR creation have not passed live acceptance. A later authorized read-only probe observed the legacy runtime response documented below. No final full-repository test suite was run after every integration change; current cutover checks are recorded separately below.
- Update/restart the owning runner before selected-ref creation. Older runners can ignore `worktreeStartRef` and start at HEAD; no mixed-version capability gate is implemented. Do not claim selected-ref correctness against an old runner.
- Dirty/untracked content hashing scales with file contents. Reviewed digests reject observed state changes but cannot freeze external processes. Repository-queue entry cleanup was requested during implementation but not independently verified.
- Source remains uncommitted and unpushed. A separately authorized test-runtime rollout used isolated Hub 3016 / Web 5174 and restarted only the grid runner; production and existing session CLIs were untouched. Task bookkeeping is not marked `DONE` because that operation would commit the dirty worktree.

### Live protocol-mismatch diagnosis

- Through the existing local Web entry on port 5174, an authorized read of active session `fabd33e2-1164-460a-9496-a32fbe13a907` (`/data1/home/zhouy1/Projects/gene_perturb_predict`) with `details=true&scope=working` returned HTTP 200, `success:true`, keys `success/stdout/stderr/exitCode`, 319 characters of porcelain stdout, empty stderr, and no `repository`. No active session matched this implementation worktree; the sampled session was not proven to be the screenshot's session.
- The same endpoint accepted `scope=invalid-scope` with HTTP 200 and the same legacy shape; the new Hub route would reject that scope with HTTP 400. This entry has not loaded the new validated route. The observation does not identify which session CLI build is running.
- The Web hook now identifies a successful response missing structured status as `git_protocol_mismatch`, preserving actual execution/network errors. Composer and Files share localized update guidance; refresh returns null and actions remain unavailable until a structured response arrives. No legacy parser or synthetic repository was added.
- Regression failed before the fix (`Git status unavailable` instead of `git_protocol_mismatch`) and passed afterward, covering legacy-response rejection and recovery to structured status. Web typecheck passed; the focused hook/component/formatter/Files run passed 4 files / 15 tests.
- A single later real-entry Chromium attempt timed out waiting for the composer Git trigger, so the new alert has no successful live visual verification. Its owned browser closed in `finally`; its temporary script was removed. The earlier isolated rendered-panel evidence above is unchanged and is not a live protocol-mismatch pass.
- Hub/session CLI update and restart remain operator-controlled prerequisites for live structured status. No Hub, runner or session was restarted; no Git write, commit, push or deployment was performed by this diagnosis.

### Conversation cutover verification

- Focused bridge regression exercises Git delivery failure and explicit retry beside the real composer send bridge. The main schedule, attachment order, send intent and send acceptance stay intact; a subsequent main-composer send still clears its own schedule normally.
- Affected Web regressions passed: 14 files / 80 tests, covering source-control, Markdown/code blocks, session isolation, Files/Diff and composer drafts. The jsdom/xterm canvas warning and stale Browserslist-data warning were non-failing; no dependency was added to silence them.
- The final root typecheck passed CLI, Hub and Relay; Web initially rejected five missing model fields in the new test's Session fixture. After completing that typed fixture, `bun run typecheck:web` passed, and the focused bridge regression passed again (1 file / 1 test). No product-code workaround or type assertion was introduced for that error.
- A full-chat browser fixture failed on a missing transcription-provider mock before exercising Git. It and its HTML entry were removed and its preview tab closed. The subsequent browser pass used the actual authenticated app, with controlled message delivery rather than expanding that mock fixture.

### Bounded browser verification and repairs

- Production rendering exposed a real dispatch defect: `/language-(\w+)/` truncated `hapi-git-draft` to `hapi`. Both the standalone renderer and the dependency now preserve the complete language token. A durable Bun patch covers `@assistant-ui/react-markdown@0.14.8` source and executed `dist`; normal/standalone real-render regressions failed before the correction and passed afterward.
- An explicit follow-up exposed a second defect: optimistic message insertion invalidated preparation and remounted the prior answer, losing editor-local edits and pending state. A session-keyed `GitChatProvider` above the runtime host now owns the review state and settlement cleanup. The forced-child-remount regression failed before that change; it now covers retained text, disabled duplicate send, failure, explicit successful retry and sent state. A separate regression covers late completion after a session change.
- Latest focused verification after both repairs: `bun run --cwd web test src/fork-features/source-control src/components/MarkdownRenderer.test.tsx` passed 8 files / 37 tests; `bun run typecheck:web` passed. These are separate from, not additive to, the historical 80-test run. The whole repository suite was not rerun.
- In the authenticated desktop app, the Git menu emitted an ordinary `/git commit` preparation request. A clearly labeled synthetic assistant reply was inserted only into the production client message store. The resulting editor rendered, retained edits across Cancel/reopen, and sent the exact edited follow-up only after explicit Send. With the source-confirmed fetch transport intercepted, the post-fix optimistic transition retained the read-only pending editor; clicking disabled Sending left the request count at 4. A controlled HTTP 503 retained editable text, showed an inline delivery error and enabled explicit retry without automatic retry. The main composer marker remained unchanged. Attachments, schedule and one-shot intent isolation are component/bridge-test evidence, not this browser pass.
- Desktop layout measured 1280×800 with document width 1280; review bounds were x=482.8–1221.2, y=192.2–636.2 and Cancel/Send were 44px high. After the original tab disappeared, no interceptor was rebuilt. Per the user's bounded closeout instruction, one 390×844 responsive inspection checked the real Git bottom sheet: x=0, y=182, width=390, height=662, bottom=844; document width stayed 390 and visible scope/action/file/refresh/close controls were 44px high. The screenshot was observed and saved as `/data1/home/zhouy1/.t3/userdata/browser-artifacts/browser-screenshot-localhost-mwjhx7er-735aeaa5.png`. The replacement tab had an empty composer, no synthetic reply and no interceptor, and was closed after inspection.
- Browser success-after-retry was not completed; existing component tests prove that transition. Phone review-editor input, a real soft keyboard/device, other browsers, natural Agent/SSE delivery and actual Git/GitHub execution remain unverified. The desktop send boundary used synthetic responses and blocked other API mutations by pathname; it was not an independent repository/Hub audit and had no forwarding counter. No Git instruction was delivered to a real Agent, and no Git write, commit, push or production change was performed by this pass.
- Review ownership is memory-only and keyed by exact original fence text: identical fences share state, entries live until provider teardown, and provider recreation/reload resets them. No persistent consumption marker, transcript-derived delivery state or durable idempotency is claimed. The existing browser mentor received the observed repairs, test results, browser evidence and these limits; further interception work was stopped.

