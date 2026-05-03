---
title: Configurable Worktree Storage Location And Hash-Folder Naming
type: feat
status: completed
date: 2026-05-02
---

# Configurable Worktree Storage Location And Hash-Folder Naming

## Overview

Replace the current single-string worktree folder name (`launchpad-<label>-<branch>-<hash>`) with a two-segment layout — `<root>/<hash>/<project-folder-name>` — and let the user choose where `<root>` lives via a new **Worktrees** settings tab. The two location options are:

1. **In repo** at `<repoRoot>/.worktrees` (current behavior, structurally cleaner names)
2. **In user home** at `~/.pwragnt/worktrees`

Old `launchpad-…` worktrees keep working: `git worktree list --porcelain` still discovers them, and the cleanup path operates on the stored absolute `worktreePath` rather than recomputing it. No physical migration.

## Problem Statement / Motivation

The current naming pattern was added in [git-directory-service.ts:32-45](apps/desktop/src/main/app-server/git-directory-service.ts:32):

```ts
function buildWorktreeDirectoryName({ baseBranch, directoryLabel, timestamp }) {
  const base = sanitizeBranchName(baseBranch) || "main";
  const label = sanitizeBranchName(directoryLabel.toLowerCase()) || "launchpad";
  const suffix = (timestamp ?? Date.now()).toString(36);
  return `launchpad-${label}-${base.replace(/\//g, "-")}-${suffix}`;
}

function buildWorktreePath(repoRoot, worktreeName) {
  return path.join(repoRoot, ".worktrees", worktreeName.replace(/[\\/]/g, "-"));
}
```

Concrete pain:

- The `launchpad-<label>-<branch>-<hash>` slug is long, hard to scan in a `ls`, and bakes branch + project-label into a flat string that becomes meaningless after rename. It also pollutes terminal prompts and editor titlebars (e.g. VS Code title shows `.worktrees/launchpad-pwragnt-main-moit6ddw`).
- The location is hardcoded to **in-repo** (`<repoRoot>/.worktrees`). Users who keep many repos and want all worktrees in one place (`~/.pwragnt/worktrees`) cannot pick that today.
- The folder basename does not match the project — when a worktree is opened in an editor, recent-projects lists and titlebars all read `launchpad-…` instead of the project name. Codex already uses a `<hash>/<name>` two-segment convention (see `formatRuntimePath` in [runtime-identity.ts:47-55](apps/desktop/src/renderer/src/lib/runtime-identity.ts:47)) and the user prefers that shape for parity and ergonomics.

## Proposed Solution

Two changes, kept separable:

**A. Naming change (always-on, no setting).** Replace the single flat slug with a two-segment layout:

- `<root>/<hash>/<project-folder-basename>`
- `<hash>` keeps `Date.now().toString(36)` (user confirmed this is fine).
- `<project-folder-basename>` = `path.basename(repoRoot)` (the actual checkout folder name; e.g. `PwrAgnt` for this repo).
- Branch name and directory label move out of the path and live only in thread metadata, where they already exist.

Examples:
- In-repo: `<repoRoot>/.worktrees/moit6ddw/PwrAgnt`
- User-home: `~/.pwragnt/worktrees/moit6ddw/PwrAgnt`

**B. Storage location setting (new tab).** Add a Worktrees section to the Settings screen exposing one selector:

| Option | Stored value | Effective path |
| --- | --- | --- |
| In repo (default) | `in-repo` | `<repoRoot>/.worktrees` |
| User home | `user-home` | `~/.pwragnt/worktrees` |

The settings panel computes and displays the resolved effective path so the user sees `~/.pwragnt/worktrees` (with `~` rendered) rather than just an enum label.

**Backward compat:** No code changes to discovery — git tracks every worktree via `.git/worktrees/<name>`, and `cleanupThreadWorktrees` (see [git-directory-service.ts:337-371](apps/desktop/src/main/app-server/git-directory-service.ts:337)) uses the stored `linkedDirectories[].worktreePath` verbatim. Existing `launchpad-…` worktrees keep functioning until they are explicitly archived.

## Technical Considerations

- **Single source of truth.** Path computation is centralized in `buildWorktreeDirectoryName` + `buildWorktreePath`. Replacing those two helpers (and their call site at [git-directory-service.ts:323-329](apps/desktop/src/main/app-server/git-directory-service.ts:323)) is the entire core change.
- **Settings infrastructure already supports this.** `DesktopSettingsConfig` ([desktop-config.ts:17-53](apps/desktop/src/main/settings/desktop-config.ts:17)) is a flat record of optional groups; the merge/prune/parse/stringify helpers handle a new top-level group additively. The settings UI already uses an enum-driven `SECTIONS` array ([SettingsScreen.tsx:14-19](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx:14)) — adding `"worktrees"` is a one-line tab list change plus one new component.
- **TOML round-trip.** The hand-rolled parser/stringifier in `desktop-config.ts` does not auto-handle new tables; both `stringifyDesktopSettingsToml` and `normalizeDesktopConfig` need explicit cases for `[worktrees]`.
- **Path collisions in the hash bucket.** Two worktrees of two different repos that happen to land at the same `Date.now()` ms in the shared `~/.pwragnt/worktrees/<hash>/` bucket would each create a different `<project-folder-name>` subdir — fine. But two worktrees of the **same** repo at the same ms would collide on `<hash>/<sameProjectName>`. Mitigation: detect existence on the chosen path; if it exists, append `-2`, `-3`, … to the hash segment until unique.
- **Display layer.** `formatRuntimePath` ([runtime-identity.ts:39-58](apps/desktop/src/renderer/src/lib/runtime-identity.ts:39)) hard-codes pattern recognition for `.worktrees/<one-segment>` and `.codex/worktrees/<hash>/<name>`. Extend it for the new pattern (`.worktrees/<hash>/<name>` and `.pwragnt/worktrees/<hash>/<name>`) so the runtime chip stays readable.
- **Workspace launchpads (`directoryKind === "workspace"`)** short-circuit in `prepareLaunchpadWorkspace` ([git-directory-service.ts:296-301](apps/desktop/src/main/app-server/git-directory-service.ts:296)) and never reach the worktree path. Out of scope.
- **Setting precedence.** Follow the established TOML + env-override precedence (see R2/R6 in [desktop-settings-config requirements](docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md)). New env override: `PWRAGNT_WORKTREE_STORAGE` accepting `in-repo` | `user-home`.

## System-Wide Impact

- **Interaction graph**: `prepareLaunchpadWorkspace` is invoked from `BackendRegistry.materializeDirectoryLaunchpad` (see backend-registry.ts:~2031). It reads the new setting via the desktop settings service, computes the path, calls `mkdir -p` on the parent, then `git worktree add --detach`. No callbacks fire on the rename — but every downstream consumer that reads the worktree path (thread snapshot creation, snapshot ref hashing, archive cleanup, runtime identity chip) sees the new path verbatim.
- **Error propagation**: `prepareLaunchpadWorkspace` already lets `git worktree add` errors propagate. New error sources are minor: `mkdir` of `~/.pwragnt/worktrees/<hash>` (covered by existing `recursive: true`) and the new collision-disambiguator loop. The settings read at workspace-prep time must not throw if config is missing — fall back to default (`in-repo`).
- **State lifecycle risks**: If a user creates a worktree under `user-home`, then flips the setting to `in-repo`, then archives the thread — the thread's stored `worktreePath` still points at the user-home location, so cleanup removes the right thing. Verified by reading [git-directory-service.ts:343-356](apps/desktop/src/main/app-server/git-directory-service.ts:343): the stored path wins over recomputation.
- **API surface parity**: The two helpers are the sole producer of worktree paths. No other interface (CLI, IPC) lets a caller mint a worktree path independently. Display is a separate concern handled by `formatRuntimePath`.
- **Snapshot ref stability**: The thread-worktree-archive plan ([2026-04-22-003-feat-thread-worktree-archive-restore-plan.md](docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md)) keys snapshots on `sha1(absolute-worktree-path)` for Codex compatibility. New paths produce new hashes — that is correct, because each new worktree is a new entity. Existing snapshots keep their existing hashes because the stored path on the thread is unchanged.
- **Integration test scenarios**:
  1. Create worktree with default setting → path is `<repoRoot>/.worktrees/<hash>/<basename>`, git worktree list shows it, archive removes it.
  2. Switch setting to `user-home` → next worktree lands at `~/.pwragnt/worktrees/<hash>/<basename>`.
  3. Pre-existing `launchpad-foo-main-abc` worktree from before the upgrade → archive flow still removes it (path comes from stored thread metadata).
  4. Two worktrees of the same repo created within the same millisecond (force timestamp in test) → second one disambiguates to `<hash>-2`.
  5. Env override `PWRAGNT_WORKTREE_STORAGE=user-home` set at runtime → settings UI shows the value as overridden, new worktrees go to user-home regardless of TOML.

## Acceptance Criteria

- [ ] New worktree paths follow `<root>/<hash>/<basename(repoRoot)>` for both location options, with `<hash> = Date.now().toString(36)`.
- [ ] `prepareLaunchpadWorkspace` reads the storage-location setting and uses `~/.pwragnt/worktrees` when set to `user-home`, otherwise `<repoRoot>/.worktrees`.
- [ ] A new **Worktrees** tab appears in the Settings screen between **Applications** and **Messaging** (or wherever fits the visual order — see open question), with a two-option storage selector and a labeled "Effective path" readout that displays the resolved location with `~` for the home directory.
- [ ] `DesktopSettingsConfig` gains a `worktrees?: { storage?: "in-repo" | "user-home" }` group; TOML round-trip (parse → stringify → parse) preserves the value; `normalizeDesktopConfig`, `stringifyDesktopSettingsToml`, `mergeDesktopSettingsConfig`, and `pruneEmptyConfig` all handle the new group.
- [ ] `PWRAGNT_WORKTREE_STORAGE` environment variable overrides the TOML value at runtime; the settings UI marks the field as overridden and disables the selector while the override is active (consistent with R2/R34-R36 in the [settings brainstorm](docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md)).
- [ ] Existing `<repoRoot>/.worktrees/launchpad-…` worktrees created before this change continue to be cleaned up correctly when the owning thread is archived.
- [ ] `formatRuntimePath` recognizes the new `.worktrees/<hash>/<name>` and `.pwragnt/worktrees/<hash>/<name>` patterns and renders something readable (e.g. `PwrAgnt @ moit6ddw` or `PwrAgnt/moit6ddw`).
- [ ] Path-collision disambiguator: if the computed path already exists on disk, the worktree is created with a `-N` suffix on the hash segment.
- [ ] Unit coverage in `git-directory-service.test.ts` for the new path builder (both location options, basename extraction, collision suffixing) and renderer-side tests for `formatRuntimePath` covering the new patterns.

## Success Metrics

- Zero regressions in `pnpm test` and `pnpm test:desktop-e2e` for launchpad → worktree → archive flows.
- Manual smoke: opening a new worktree from the desktop app shows `PwrAgnt` (the project basename) in the editor titlebar / shell prompt rather than `launchpad-pwragnt-main-…`.
- Settings inspector shows the resolved path including `~` expansion, and toggling the selector immediately updates the readout.

## Dependencies & Risks

- **Depends on** the existing desktop settings infrastructure landed per [2026-04-30-desktop-settings-config-requirements.md](docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md). All required pieces (`DesktopSettingsConfig`, TOML helpers, `SettingsScreen.tsx`, `useDesktopSettings`) are in place — confirmed by direct read.
- **Risk:** users who manually `cd` into worktree paths from terminal history will hit `launchpad-…` paths that still work but new worktrees won't appear there. Acceptable — they were going to retire the old paths anyway via thread archive.
- **Risk:** if the user's home directory contains an existing `~/.pwragnt/worktrees` from a prior tool/script, we coexist (we only ever write our own `<hash>/<basename>` subtree).
- **Out of scope:** physically migrating existing in-repo worktrees to `~/.pwragnt/worktrees`. Discoverability surface for browsing existing worktrees from the new settings tab (potentially valuable but a separable feature).

## Open Questions

1. **Default value for the storage setting.** The user's stated preference is the user-home layout, but defaulting to `in-repo` preserves zero-surprise behavior for anyone upgrading. Recommendation: default to `in-repo` to keep the upgrade non-disruptive; surface the user-home option prominently in the Worktrees tab. Confirm during planning.
2. **Tab ordering.** Should "Worktrees" sit next to "Applications" (both feel like environment plumbing) or after "Models"? Likely between Applications and Messaging.
3. **Cleanup of empty `<hash>` parent directories.** When a worktree is removed, the parent `~/.pwragnt/worktrees/<hash>/` becomes empty. Worth `rmdir`-ing on cleanup to avoid orphaned hash directories piling up. Low priority; can defer.
4. **Display tweak only:** when `<basename(repoRoot)>` collides between unrelated checkouts in the shared user-home root, the runtime chip might be ambiguous. Acceptable because the `<hash>` segment differs.

## Implementation Outline

Single PR, four touch points:

1. **Settings schema** — [apps/desktop/src/main/settings/desktop-config.ts](apps/desktop/src/main/settings/desktop-config.ts)
   - Extend `DesktopSettingsConfig` with `worktrees?: { storage?: WorktreeStorageLocation }`.
   - Add normalize/stringify/merge/prune branches for `[worktrees]` table with key `storage = "in-repo" | "user-home"`.
   - Define and export `WorktreeStorageLocation` type via `@pwragnt/shared`.
2. **Settings env + service** — [apps/desktop/src/main/settings/desktop-settings-env.ts](apps/desktop/src/main/settings/desktop-settings-env.ts) + [apps/desktop/src/main/settings/desktop-settings-service.ts](apps/desktop/src/main/settings/desktop-settings-service.ts)
   - Add `PWRAGNT_WORKTREE_STORAGE` to env override list with the same overridden-value semantics used for messaging fields.
   - Expose the resolved storage value (and override flag) in the snapshot returned to the renderer.
3. **Path computation** — [apps/desktop/src/main/app-server/git-directory-service.ts:32-45](apps/desktop/src/main/app-server/git-directory-service.ts:32) and call site at line 323-329
   - Replace `buildWorktreeDirectoryName` + `buildWorktreePath` with one helper:
     ```ts
     async function computeWorktreePath(params: {
       repoRoot: string;
       storage: WorktreeStorageLocation;
       homeDir?: string;
       timestamp?: number;
     }): Promise<string>
     ```
   - Helper returns `<root>/<hash>/<path.basename(params.repoRoot)>`, where `<root>` is `<repoRoot>/.worktrees` for `in-repo` or `<homeDir>/.pwragnt/worktrees` for `user-home`. Includes the `-N` collision suffix loop.
   - `prepareLaunchpadWorkspace` accepts the storage value via constructor injection (a `getWorktreeStorage(): Promise<WorktreeStorageLocation>` callback supplied by `BackendRegistry`, parallel to how it gets settings today).
4. **Settings UI** — `apps/desktop/src/renderer/src/features/settings/`
   - Add `WorktreesSettings.tsx` component with a 2-radio selector and an "Effective path" readout. Mirror the `ApplicationsSettings.tsx` styling — restrained panel, `settings-row__error` for env-override badge.
   - Update [SettingsScreen.tsx:12-19](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx:12) to add `"worktrees"` to the `SettingsSection` union and the `SECTIONS` array, and add the rendering branch in `SettingsSectionBody`.
   - Add a `useDesktopSettings` writer for the new field.
5. **Display** — [apps/desktop/src/renderer/src/lib/runtime-identity.ts:39-58](apps/desktop/src/renderer/src/lib/runtime-identity.ts:39)
   - Detect `<…>/.worktrees/<hash>/<name>` (basename + parent + grandparent === `.worktrees`) and `<…>/.pwragnt/worktrees/<hash>/<name>`. Render as `${name} @ ${hash}` (or `${name}/${hash}` to match the existing Codex branch).
6. **Tests** — colocated in `git-directory-service.test.ts` and a new `runtime-identity.test.ts` case set; settings persistence tests in `desktop-config.test.ts`.

## Sources & References

- **Brainstorm reference:** [docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md](docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md) — TOML + env override precedence (R2, R6, R34-R36) and settings tab pattern (R7-R12).
- **Brainstorm reference:** [docs/brainstorms/2026-04-18-directories-launchpad-requirements.md](docs/brainstorms/2026-04-18-directories-launchpad-requirements.md) — launchpad workMode model (R9-R16).
- **Related plan:** [docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md](docs/plans/2026-04-22-003-feat-thread-worktree-archive-restore-plan.md) — worktree snapshot ref scheme that depends on stable absolute paths.
- **Code:**
  - [apps/desktop/src/main/app-server/git-directory-service.ts:32-45](apps/desktop/src/main/app-server/git-directory-service.ts:32) — current path builders.
  - [apps/desktop/src/main/app-server/git-directory-service.ts:290-371](apps/desktop/src/main/app-server/git-directory-service.ts:290) — `prepareLaunchpadWorkspace` and `cleanupThreadWorktrees`.
  - [apps/desktop/src/main/settings/desktop-config.ts](apps/desktop/src/main/settings/desktop-config.ts) — settings schema, TOML round-trip.
  - [apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx) — section bar pattern.
  - [apps/desktop/src/renderer/src/lib/runtime-identity.ts:39-58](apps/desktop/src/renderer/src/lib/runtime-identity.ts:39) — runtime path display.
  - [apps/desktop/src/main/app-server/scratch-projects.ts](apps/desktop/src/main/app-server/scratch-projects.ts) — precedent for `~/.pwragnt/<bucket>/...` storage layout.
- **Conventions:** [AGENTS.md](AGENTS.md) — Conventional Commit scopes (`desktop` for this PR), runtime config layout, thread-first hierarchy guidance.
