# Desktop App Guidance

## Style Guide

Use [../../docs/UI-THEME.md](../../docs/UI-THEME.md) as the visual theme source of truth for renderer UI work.

Use [../../docs/design/desktop-style-guide.md](../../docs/design/desktop-style-guide.md) for broader desktop layout, product tone, component behavior, and copy guidance.

The theme guide defines:

- theme thesis
- palette and token usage
- component theme rules
- interaction constraints
- visual anti-patterns

The desktop style guide defines:

- product tone
- typography
- shell composition
- sidebar and thread-row rules
- component constraints
- copy rules
- anti-patterns

## Non-Negotiables

- Inbox, Recents, and Directories live in one thread lens switch, with Inbox leftmost.
- Unread state uses the orange cookie marker, not punctuation badges.
- The sidebar is an information surface, not a stack of generic cards.
- Do not use browser-default controls in shipped UI.
- Do not ship implementation-status narration in user-facing copy.
- Keep radius at `8px` or below.
- Favor one accent color and neutral surfaces.

## Running the App for Development

To launch the desktop app with live threads and real user state, run from the **repo root** (or worktree root):

```bash
pnpm --filter @pwragent/desktop dev:no-messaging
```

- Do **not** override `HOME` or set `NODE_ENV` — the app needs the real user data directory to load saved threads and Keychain secrets.
- `dev:no-messaging` disables the Telegram/Discord messaging interface, which avoids bot-token prompts and Keychain access issues during development.
- For visual verification of UI changes, use this command so you can see real threads in the sidebar and thread detail pane.
- The `dev` script (without `no-messaging`) also works but will attempt to connect messaging providers.
- If the app starts but shows no threads, you are likely running from the wrong directory or with overridden env vars.

## Thread-State Update Bus

When mutating persistent thread state (model, reasoning effort, fast mode,
permissions/execution mode, name, compaction), `BackendRegistry` MUST emit a
typed `AppServerNotification` from the mutation method on success. That
notification fans out through two existing listeners:

- **Renderer**: `apps/desktop/src/main/ipc/agent-ipc.ts:broadcastAgentEvent` →
  `agent:event` IPC → `desktopApi.onAgentEvent` → `useThreadNavigation`
  patches the navigation snapshot in place.
- **Messaging controllers**: `apps/desktop/src/main/messaging/messaging-runtime.ts`
  fans the event out to every `MessagingController.handleBackendEvent`,
  which routes thread-state methods to `refreshStatusSurfacesForThread`
  to re-render every binding's status surface on its channel.

This is what keeps Telegram, Discord, and the desktop UI in sync when any
surface changes a setting. The cross-surface refresh is automatic — do
NOT add ad-hoc IPC channels or per-controller refresh fan-outs for new
thread-state fields. Instead:

1. Add the new notification method to `AppServerNotification` in
   `packages/shared/src/contracts/normalized-app-server.ts`.
2. Emit from the registry mutation method via `await this.emit(...)`.
3. Add a handler branch in `useThreadNavigation`'s `onAgentEvent`
   subscription, mirroring `applyThreadModelSettingsUpdate` /
   `applyThreadExecutionModeUpdate`.
4. Add a method-name branch in `MessagingController.handleBackendEvent`
   that routes to `refreshStatusSurfacesForThread`.

Mutation handlers in `MessagingController` (e.g. `togglePermissionsMode`)
should NOT call `renderBindingStatus` inline for state that flows through
the bus — the bus is the single source of refresh, and an inline render
would be redundant. Update binding-local preferences before the registry
call so the bus-path render sees fresh prefs.

For binding-local mutations that do NOT flow through the registry
(e.g. `cycleToolUpdateMode`, `syncConversationName`), keep the inline
`renderBindingStatus` call — there's no bus event for those.

### Permission-mode queue events

A toggle of `executionMode` while a turn is active produces additional
notifications beyond `thread/executionMode/updated`:

- `thread/executionMode/queued` — fired when the registry queues a
  pending mode change instead of applying it immediately. Params:
  `{ threadId, queuedExecutionMode, queuedAt }`. Renderer patches
  `NavigationThreadSummary.queuedExecutionMode` and shows the queue
  indicator in the composer; messaging posts an audit message in every
  bound conversation with a Cancel button.
- `thread/executionMode/queueCleared` — fired on either `cancelled`
  (user clicked Cancel) or `applied` (turn ended and the queue
  flushed). Params: `{ threadId, reason: "applied" | "cancelled" }`.
  Renderer clears the queue indicator; messaging edits the previously
  posted audit message in place (or falls back to a fresh message if
  edit fails). On `applied`, this fires AFTER `thread/executionMode/updated`
  — clients should see the apply before the queue-clear so the UI
  transitions cleanly through "queued → applying → applied".

The persistent `permissionTransitionLog` on `ThreadOverlayState` (capped
at 100 entries, sqlite-backed) is the audit trail. Renderer materializes
log entries into the transcript as synthetic activity entries with id
prefix `permission-transition-`. The queue itself (`queuedExecutionMode`,
`queuedExecutionModeAt`) lives in registry memory only and is cleared on
app restart — that's intentional, since the active turn would have been
interrupted on shutdown.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

The desktop app sits at the **top** of the dependency hierarchy and may import any `@pwragent/*` package. However:

- The **renderer** (`src/renderer/`) may only import `@pwragent/shared`. All other package access must go through IPC to the main process.
- The **main process** may import any package but must not create circular dependencies.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** import provider SDKs (`grammy`, `discord.js`, `telegraf`) in `src/main/messaging/core/`
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.

## SQLite Query Rules

- Never interpolate user-sourced values into SQL strings. Always use
  `better-sqlite3` prepared statements with positional or named bindings.
- Messaging-platform inbound text is the highest-risk SQLite input category:
  public Telegram, Discord, Mattermost, Slack, Signal, Feishu, and future
  adapter traffic must be treated as hostile even when the local desktop user
  trusts the bound thread.
- Generated SQL fragments are only allowed for non-data structure, such as a
  generated `?, ?, ?` placeholder list. Hardcoded maintenance table names must
  stay allowlisted by the SQL-template lint guard.
- Run `pnpm lint:sql` after changing desktop main-process SQLite code. It flags
  interpolated SQL template strings in the messaging/state persistence surface.

## Implementation Notes

- Centralize visual tokens in `styles/app.css` before expanding renderer surfaces.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
- Use the project-local [desktop E2E fixture seeding skill](../../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when capturing or refreshing replay-backed desktop E2E fixtures.

## Third-Party Brand Assets

- Vendor-supplied brand assets (logos, marks, icons) live under `src/renderer/src/assets/<vendor>/` as **verbatim files from the vendor's official brand kit** — never hand-redrawn, recolored, or otherwise altered.
- Each asset directory MUST include a `README.md` documenting: the source URL, the vendor's usage rules, and the procedure for re-fetching on update. See [`src/renderer/src/assets/mattermost/README.md`](src/renderer/src/assets/mattermost/README.md) as the reference example.
- Render verbatim assets via `<img>`, NOT inline `<svg>` with `currentColor`. The `<img>` tag is structurally insulated from parent CSS `color` rules, which protects the asset from accidental recoloring.
- Do not add hand-drawn `currentColor` vendor silhouettes. If a platform has a recognizable mark, follow the Mattermost/Telegram/Discord pattern instead.

## Worktree Path Computation

- **All worktree paths** must use the shared `computeWorktreePath` from `src/main/app-server/git-directory-service.ts`.
- There are two code paths that create worktrees: `prepareLaunchpadWorkspace` (in `git-directory-service.ts`) and `handoffLocalToWorktree` / `handoffLocalChangesToDetachedWorktree` (in `git-workspace-handoff-service.ts`). Both must use the same path builder.
- The naming pattern is `<root>/<hash>/<project-folder-name>` where `<hash>` is `Date.now().toString(36)` and `<project-folder-name>` is `path.basename(repoRoot)` preserving original casing.
- Do not introduce additional worktree path builders — centralize in `computeWorktreePath`.

## Release Notes

- The first signed v1.x build is signed under the PwrDrvr LLC Developer ID
  (Team ID `T44CNHC4UH`) with bundle id `com.pwrdrvr.pwragent`. macOS Keychain
  scopes `safeStorage` keys by signing identity + bundle id, so any pre-v1.0
  development build's encrypted secrets at
  `~/.local/state/pwragent/settings-secrets.json` (Telegram / Discord bot
  tokens) WILL fail to decrypt under the new signed build. The
  `desktop-secret-store` returns `undefined` on decrypt failure and prompts the
  user to re-enter the secret in Settings — no crash, no stale ciphertext
  re-used as plaintext. Document this in v1.0.0 release notes for any internal
  testers upgrading from pre-v1.0 dev builds.
- Hardcoded version strings in shipped code are an anti-pattern. Always use
  `app.getVersion()` (main process) or `desktopApi.readAppMetadata()` (renderer)
  so every release reports its real version.
