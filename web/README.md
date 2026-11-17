# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, log in with a per-account API token (`hapi_mu_*`) or the bare `CLI_API_TOKEN` (admin seed token). There is no `:<namespace>` suffix syntax — namespace is a stored attribute of each token.
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Raw message windows, persisted-window ownership and Query data follow the Hub/account identity `${baseUrl}|${user.id}`. A layout-effect admission boundary retires the previous scope before mounting new consumers; logout clears the owner and stored windows. Same-scope client recreation and normal token refresh retain warm windows; retired request/SSE/mutation lifetimes cannot republish into a replacement scope.
- Live updates come from the hub via SSE.
- Notifications use coss-style Toasts backed by Base UI, anchored at the upper-right with safe-area spacing and horizontal slide-in/out: up to three visible cards, newest in front; hover or keyboard focus expands the stack downward and pauses dismissal. Cards keep the same width (up to 360px) and compact 5rem height with 8px vertical padding in both states, without depth scaling; titles use one line and descriptions up to two lines with overflow ellipsis. Closing, timeout and right swipes animate before removal; reduced-motion mode fades in place.
- Toast producers use `useToast().addToast({ title, body, sessionId, url, variant?, durationMs? })`; the default duration is 6 seconds, and `durationMs: 0` keeps a notification open until dismissed.
- Prose uses bundled Source Serif 4 optical-size normal/italic faces with Chinese serif fallbacks; KaTeX fonts are bundled too. `postcss.config.cjs` disables Tailwind's intermediate `optimize` pass to preserve imported declaration source paths for Vite's hashed font-asset URLs. Vite still minifies the final CSS; keep dependency imports in their existing base layer and custom math rules in components.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/share` - Share-target landing (Web Share Target POST → `?id=`, or native `/share#url=&text=&title=`).
- `/settings` - Settings category hub (mobile) and responsive master-detail shell.
- `/settings/general` - Language preferences.
- `/settings/display` - Appearance, typography, colors, and session list preferences.
- `/settings/chat` - Message input, tool card, and conversation color preferences.
- `/settings/voice` - Everyday voice assistant preferences.
- `/settings/voice/voices` - Full-page voice picker.
- `/settings/voice/advanced` - Voice persona, tuning, and diagnostics.
- `/settings/usage` - Cache-aware token usage dashboard for the hub owner.
- `/settings/about` - Application links and version information.

## Features

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent flavor label (claude/codex/gemini).
- Model mode display.
- Directory, in-progress, and pinned groups use a flat list without tree rails or nested horizontal indentation. Group headers and full-width session rows share an alignment edge, with 8px list gutters and row insets (desktop rows retain extra right-side room for More actions). Secondary group headings and compact count badges distinguish sections without shrinking session text, icons, timestamps, or row height.
- Only the selected session becomes a card: a theme-aware surface, 10px corners, a uniform 1px inset border instead of a left accent, and a subtle outer shadow (0 1px 2px, black at 5%). The border and shadow do not change row geometry or spacing. Selected titles use the normal foreground even for inactive sessions; hover does not replace the selected surface, and the keyboard focus ring remains visible. Unselected rows stay flat with hover feedback.
- Desktop session rows reveal a separate More actions button on hover or keyboard focus; Escape returns focus to that button. Right-click and mobile long-press open the same action menu without selecting the session.
- Session rows use default shallow `React.memo` and a dependency-complete stable router selection callback. Immutable session/status updates, global last-seen versions, context and local menu state remain authoritative; no custom comparator suppresses them. Memoization does not avoid remounts or guarantee that only two rows render.
- Desktop sidebar content uses its available width rather than the chat prose width cap. Settings/account navigation stays at the bottom, outside the scrolling list.
- At widths of 920px and above, the main header's sidebar button or Ctrl/Cmd+B fully hides/restores the sidebar and resize handle; it remains available without session tabs. The collapsed header also offers New Session.
- Desktop toggles use a coordinated 200ms sidebar/resize-handle transition, preserving the list's expanded content width while the main pane fills the released space. The toggle icon and collapsed New Session action transition with it. Hidden content immediately leaves keyboard and accessibility navigation; reduced-motion mode, viewport changes, and manual resizing switch immediately. Dragging is ignored while a sidebar transition is running.
- Collapse state (`hapi-sidebar-collapsed`) and resize width (`hapi-sidebar-width`) persist independently. Hiding the sidebar keeps the list mounted, retaining search, group expansion, selection, and scroll position.
- Below 920px, the existing single-column phone navigation ignores desktop collapse. The shortcut leaves editors, terminals, dialogs, menus, and composition events untouched.
- Shell, persistence, footer, responsive width cap, and desktop-only motion styles live in `src/fork-features/sidebar-shell/`.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Sent messages retain their display identity when the server confirms them, preserving message state and conversation-outline anchors. Message removal and rewind update the rendered list before removed message consumers can read stale runtime IDs.
- Store-backed threads keep stable direct-child message anchors while mounting historical message trees only near the viewport. `src/fork-features/thread-windowing/useThreadEntryWindow.ts` seeds the latest two entries (all entries for threads of three or fewer), then progressively fills the viewport plus 600px overscan, admitting at most two ordinary entries per frame. Unknown heights start at 300px; giant individual entries remain unbounded by this outer window.
- Height measurements belong to the current Store instance, not a cross-session cache. Width changes invalidate estimates; measured changes preserve tail-follow intent or the visible anchor offset. Outline selection explicitly materializes its target before final alignment and cancels stale session/navigation work.
- Session-keyed chat remounts, drafts, subscriptions, raw-window caching and background tail synchronization are unchanged. Warm-switch measurements and the still-unmet 150ms painted/interactive / 100ms task targets are recorded in `docs/superpowers/specs/2026-11-13-chat-performance-benchmark-spec.md`.
- A tail synchronization that invalidates a pending older page rechecks covered history when that request settles, even if synchronization already finished. Epoch-reset, exhausted/no-progress, backoff and user-cancellation pauses remain authoritative.
- Composer for sending messages.
- Permission mode toggle (default/acceptEdits/auto/bypassPermissions/plan).
- Model selection (default/sonnet/sonnet[1m]/opus/opus[1m]).
- Session abort and mode switch controls.
- Context size display.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Persists across reloads via `localStorage` keyed per session.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

- Task checklists preserve blocked task state without treating a pause as an error.
  - The floating task panel hides when every unfinished task is blocked and returns when a task becomes pending or active. Completed-only panels retain their normal lifecycle.
  - A finished, collapsed turn hides its blocked-only checklist; expanding the turn restores the recorded checklist.
  - Session-level fallback checklists appear only while a reply is streaming and a task is pending or in progress, so paused tasks do not repeat in later idle replies.

- Execution rail information hierarchy:
  - Normal mode groups consecutive routine tools into mixed activity segments; commentary, reasoning, subtasks, Todo, compaction, and interactive tools remain boundaries. Thinking keeps same-category groups; verbose keeps atomic calls.
  - Completed activity summaries open directly to original tool previews. Running, queued, failed, permission-gated, individually expanded, and focused members remain visible; entity-only updates can reveal errors without rebuilding the turn. An exceptional member does not expand unrelated successes; when fewer than two eligible members remain, the summary disappears and the remaining members are shown.
  - Subtask cards use verified agent IDs and lifecycle state, results, and timing. Explicit native agent labels take title precedence over assignment summaries; original instructions remain in details. Dispatch completion is not task completion; missing identity or lifecycle retains the original tools rather than inventing a terminal state or navigation target.
  - Explicit step expansion survives rail collapse and view-mode changes within the mounted turn. Final answers stay outside the rail; sharing includes original activity members. See `docs/superpowers/plans/2026-11-16-execution-rail-information-hierarchy-plan.md` for scope and verification.

### Composer Git workflow (`src/fork-features/source-control/`)

- One status-row entry opens branch/workspace selection, Git actions and scoped Changes. Desktop uses a popover; phones use a bottom sheet with 44px controls. Git actions no longer open a confirmation dialog.
- Selecting a branch creates a separate worktree/session; selecting a worktree opens an authorized existing session or prefills New Session. The active agent's checkout is never switched. Selected-ref creation requires an updated runner.
- Comparison scope persists per session: `working` is HEAD → final worktree, `staged` is HEAD → index, `unstaged` is index → worktree, and `branch` is merge-base(selected base, HEAD) → HEAD. Untracked paths are identified separately; branch comparisons exclude uncommitted changes. No nonempty-scope fallback and no guessed `main` base.
- Composer totals, Changes and clicked Diff use the same scope/base. Unique paths retain staged/unstaged/rename identity; binary or unknown line counts display `?`, not invented zeros.
- Choosing an action sends an ordinary `/git <action>` preparation message in the conversation. A matching `hapi-git-draft` result becomes a prefilled, editable instruction; malformed or stale results remain read-only. Review and explicitly Send to append a new user message, not edit or branch an earlier message. Cancel keeps the local draft available for re-editing.
- Hyphenated fence names are parsed as complete language tokens in both Markdown paths. The Bun patch for `@assistant-ui/react-markdown@0.14.8` includes its source and executed `dist` parser; re-evaluate/remove it when upgrading the dependency.
- Preparation IDs use the shared `randomId()` helper: when non-secure HTTP lacks `crypto.randomUUID()`, `crypto.getRandomValues()` supplies a UUID v4. Preparation and draft UUID validation remain unchanged.
- Preparation and reviewed instructions use the current Agent's permissions, not `runGitAction` or the former dialog's fixed-argv/state-digest safeguards. Prompts request read-only preparation, explicit file scope, normal push, clean ff-only pull, separate default-branch acknowledgement and stop-on-failure; the frontend cannot enforce those requests or prevent repository prompt injection. Review the files and instructions before sending.
- The independent Git send waits for its own HTTP settlement before marking delivery. A failed send retains inline edits without entering main-composer recovery; the main draft, attachment order, schedule and one-shot send intent are not consumed. Busy/inactive sessions block Git submissions while inspection remains available. Existing PRs open directly; PR eligibility uses committed branch delta independently of the Changes scope.
- Review edits, pending delivery, errors and sent state belong to a session-keyed provider above the answer-remount boundary. Identical original fence text shares one in-memory review; leaving/recreating the session provider or reloading resets it. This is not persisted delivery history or an idempotency guarantee.
- Structured Git status requires the updated Hub and session CLI. A successful legacy porcelain response without `repository` shows an explicit protocol-mismatch message in the composer and Files; no empty repository or raw-output fallback enables actions. Refreshing the browser cannot update backend processes. Updating/restarting a runner affects newly spawned sessions; existing session CLIs must be updated/restarted separately by the operator.

### File browser (`src/routes/sessions/files.tsx`)

- Scoped Changes list shared with the composer, including working/staged/unstaged/branch comparison and base selection.
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Diff preserves the selected scope/base, including a separate scroll position for each comparison.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js
- Real-time via Socket.IO
- Resize handling

### Voice assistant

- ElevenLabs integration (@elevenlabs/react)
- Real-time voice control
- Standard and realtime composer dictation with provider capability selection

### New session (`src/components/NewSession/`)

Modular session creation:

- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Permission mode toggle (YOLO mode)
- Worktree name and start-ref inputs; Git-panel selection prefills machine, repository and start ref without changing the current session.

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses a per-account API token (`hapi_mu_*`) or the bare `CLI_API_TOKEN` (admin seed token) from the login prompt.
- JWT tokens with auto-refresh.
- Browser Settings includes **Log out**. It clears the current Hub's token/password credential and retires its message-window/Query scope; credentials for other Hubs are preserved. URL `token` parameters are consumed before browser authentication and removed again on logout, preserving other location parameters and history state.
- Retired token/password login forms and auth refreshes cannot restore a logged-out identity. Normal same-account refresh keeps warm windows. Automatic Telegram authentication does not offer this browser-only logout action.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


If testing in Telegram, set:

- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

End-to-end browser tests for the scratchlist component (real Chromium, real
`inert` focus blocking, real localStorage round-trips) live at the repo root
under `e2e/`:

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The spec drives a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the hapi hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.
