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

## Implementation Notes

- Centralize visual tokens in `styles/app.css` before expanding renderer surfaces.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
- Use the project-local [desktop E2E fixture seeding skill](../../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when capturing or refreshing replay-backed desktop E2E fixtures.

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
