---
date: 2026-05-02
topic: config-and-state-relocation
---

# Config and State Relocation

## Problem Frame

Config and local state are spread across XDG locations (`~/.config/pwragnt/`, `~/.local/state/pwragnt/`) plus `~/.pwragnt/projects/`. This is hard to inspect, hard to back up, hard to clean up, and the only existing isolation mechanism (overriding `$HOME`) drags every other XDG-using tool along with it.

We also need three new isolation use cases that the current layout cannot support cleanly:

1. **E2E tests** running in parallel for different branches under the same user must not share or corrupt each other's state.
2. **Long-term parallel profiles** — e.g. a stable instance and an experimental instance running side-by-side on the same machine for the same user.
3. **Messenger profile testing** — running two instances connected to different Telegram/Discord identities for development.

Additionally, `~/.local/state/pwragnt/messaging-state.json` has grown to 4.3 MB and is full-rewritten on every change. Inspection shows ~73 % of its bytes live in three tables (`deliveries`, `callbackHandles`, `pendingIntents`) and 100 % of `browseSessions` are expired, indicating GC has never been running. `settings-secrets.json` is dead code since the Keychain migration.

Release is targeted for **2026-05-03**. The system works reliably today, so any change must preserve that reliability.

## Requirements

### Path layout and override

- **R1.** All config and local state for a single instance live under one root directory. Default root is `~/.pwragnt/`.
- **R2.** The root is selected by a single environment variable `PWRAGNT_HOME`. When set, it replaces the default. When unset, default applies.
- **R3.** The previous mechanism of overriding `$HOME` to relocate state is removed. `PWRAGNT_HOME` is the only supported override.
- **R4.** Inside the root, the layout is:
  - `config.toml` — main config (TOML)
  - `state/state.db` — sqlite database (all persistent state)
  - `state/*.bak.<timestamp>` — backups produced by migrations (retained, not auto-pruned in this release)
  - `projects/` — directory-less thread workspaces (existing, untouched in this work)
  - `logs/` — if/when we relocate logs (out of scope for this release unless trivial)
- **R5.** No state, config, secrets, or cache may be written outside the root. This includes never reading or writing `~/.config/pwragnt/`, `~/.local/state/pwragnt/`, or `~/.cache/pwragnt/` after migration.

### Instance isolation

- **R6.** Multiple instances on the same machine for the same user are isolated by pointing each at a different `PWRAGNT_HOME`. There is no other isolation mechanism (no inline named profiles, no per-messenger config sets).
- **R7.** E2E tests set `PWRAGNT_HOME` to a unique temp directory per run. Tests must not depend on or pollute the user's real `~/.pwragnt/`.
- **R8.** A user can run `~/.pwragnt-dev` alongside `~/.pwragnt/` indefinitely without interference. Agent-core sessions are isolated between roots; Codex sessions are not (acceptable, called out as a known limitation).

### Keychain

- **R9.** Each root has an `instance_id` field in `config.toml`. On first launch (or migration), this defaults to `"default"` for the canonical root and is generated/initialized for any new root.
- **R10.** All Keychain entries written by the app use a service name of `pwragnt-{instance_id}`. No code path may read or write a Keychain entry without going through this prefix.
- **R11.** When a user forks a root by copying `~/.pwragnt/` to `~/.pwragnt-dev/`, they are expected to edit `instance_id` to a unique value before the new instance writes any secrets. The app surfaces a clear error if it detects two roots with the same `instance_id` running concurrently — implementation detail deferred to planning, but the requirement stands.
- **R12.** E2E tests set `instance_id` to a unique value per run (e.g. `e2e-{run-id}`) so a teardown step can wipe their Keychain entries by prefix.

### State storage (sqlite cutover)

- **R13.** Persistent state moves from `messaging-state.json` and `overlay-state.json` into a single sqlite database at `state/state.db`.
- **R14.** Tables map directly to the existing top-level keys of the JSON files: `browse_sessions`, `bindings`, `callback_handles`, `pending_intents`, `deliveries` (from messaging) and `threads`, `directory_launchpads`, `launchpad_defaults`, `backends` (from overlay). `version` becomes a `schema_version` row in a `meta` table.
- **R15.** A garbage-collection pass runs at startup and on a low-frequency timer. At minimum it deletes `browse_sessions` rows where `expires_at < now`. Other table TTLs are deferred to planning, which must propose a TTL or trim policy for each remaining table before implementation.
- **R16.** `settings-secrets.json` is deleted on migration. No code path reads it. (Already obsolete since the Keychain move.)
- **R17.** sqlite is opened in WAL mode with `synchronous = NORMAL` and a sane busy timeout. There is one writer (the desktop main process). Implementation detail confirmed in planning.

### Migration

- **R18.** On first launch under the new layout, the app:
  1. Detects whether old paths (`~/.config/pwragnt/`, `~/.local/state/pwragnt/`, or any of their files) exist and a corresponding new-root file does not.
  2. If yes: copies `config.toml` to the new root, creates the sqlite DB, populates each table from the corresponding JSON file, writes a migration marker, then renames the old JSON files to `*.bak.<timestamp>` in their original directory.
  3. If the migration aborts at any point, the new files/DB are removed and the old files are untouched.
- **R19.** Migration is idempotent: re-running it after success is a no-op. There is a CLI command (e.g. `pwragnt migrate-state --rerun`) for manual retry from a `.bak` file.
- **R20.** `.bak` files are not auto-deleted in this release. They are recovered on user demand only.
- **R21.** Migration logs row counts per table before and after, and aborts loudly on any per-row decode error rather than silently dropping data.

### E2E and developer ergonomics

- **R22.** Test harness helpers create a fresh `PWRAGNT_HOME` under a temp directory, set `instance_id`, run the test, and tear down both the directory and the matching Keychain entries.
- **R23.** A developer running two instances (stable + experimental) follows a documented recipe: `cp -R ~/.pwragnt ~/.pwragnt-dev && edit instance_id && PWRAGNT_HOME=~/.pwragnt-dev pwragnt …`. No additional plumbing required.

## Success Criteria

- **SC1.** Fresh install creates everything under `~/.pwragnt/` only. `~/.config/pwragnt/`, `~/.local/state/pwragnt/`, and `~/.cache/pwragnt/` are never created or touched.
- **SC2.** Existing user (today's layout) launches the new build and lands on a working `~/.pwragnt/` populated from their old data. All threads, bindings, and configuration appear unchanged in the UI. Old XDG dirs contain only `.bak.*` files after migration.
- **SC3.** Two parallel E2E suites (different branches) can run simultaneously without flakiness from shared state, including no Keychain entry collisions.
- **SC4.** Two parallel instances (`~/.pwragnt/` + `~/.pwragnt-dev/`) connect to two different Telegram identities at the same time without crosstalk.
- **SC5.** `state.db` for the test author's current data is materially smaller than the 4.3 MB JSON it replaces (exact target deferred to planning, but the GC pass alone should remove all 53 expired browse sessions and any expired entries in the larger tables).
- **SC6.** Migration of the test author's real data preserves every thread, binding, and configuration field. Verified by per-table row counts + spot-check of a sampled record per table.
- **SC7.** No regression in the messaging path: existing Telegram/Discord conversations continue to work after the migration completes.

## Scope Boundaries

- **OUT:** Migrating or restructuring `~/.pwragnt/projects/`. Codex's directory-less thread support may eventually replace this entirely; tracked separately.
- **OUT:** JSONL event log format. We are sqlite-only for state in this release.
- **OUT:** Inline named profiles within a single root (e.g. `--profile dev` selecting `profiles/dev/`). The decision is one-mechanism-only: `PWRAGNT_HOME`.
- **OUT:** Named messenger config sets (`messaging.dev` / `messaging.default` selectable at runtime). Forking the whole root is the supported answer for this release.
- **OUT:** Cross-instance `instance_id` collision detection beyond a clear startup error. Process-level locking is a follow-up if it proves necessary.
- **OUT:** Auto-deletion of `.bak.*` files. Manual cleanup only in this release.
- **OUT:** Re-homing logs or anything stored in `~/.cache/pwragnt/` if/when we add caches. Out unless a concrete consumer exists.
- **OUT:** Encryption or password protection of `state.db`. Same threat model as the JSON files it replaces (file-system permissions only).

## Key Decisions

- **Single root, one env var (`PWRAGNT_HOME`).** All four use cases (E2E, dev profile, messenger profile, default) collapse onto one mechanism. Simplest possible mental model; one code path to test.
- **Keychain namespacing via explicit `instance_id` in config.toml.** Predictable, greppable, easy to clean up. Costs the user one edit when forking a root, but `pwragnt config init` (or the migration step) sets it automatically for the default root.
- **sqlite-only for state.** Single file, atomic writes, indexed reads on `threads`, easy to inspect with `sqlite3`. No JSONL split — added cost without a concrete win at current scale.
- **Migrate-and-back-up, not dual-write.** Faster to ship, recoverable via `.bak` files, single read path post-migration. Dual-write would burn an extra release cycle for diminishing returns.
- **Fail loud, fail early.** Migration aborts on the first decode error rather than silently dropping rows. Better to refuse to launch and ask the user to file a bug than to lose data quietly.
- **`projects/` and JSONL deferred.** The release-blocking question is the file layout and the storage model. The rest can land non-breakingly later.

## Dependencies / Assumptions

- The desktop main process is the sole writer to `state.db`. Renderer reads (if any) go through the existing IPC, not direct DB access.
- macOS Keychain Access service-name prefixing is safe to use for both writes and bulk-cleanup queries (it is — `security delete-generic-password -s pwragnt-e2e-…` works).
- All current users' `messaging-state.json` and `overlay-state.json` parse as valid JSON. (If not, migration aborts and we have a failing customer; per R21 this is preferable to silent corruption.)

## Outstanding Questions

### Resolve Before Planning

_(none — product scope and behavior are decided)_

### Deferred to Planning

- **[Affects R15][Technical]** What TTL or row-count cap belongs on each of `callback_handles`, `pending_intents`, `deliveries`? Each has its own semantics; planning needs to read the writers and propose values.
- **[Affects R10][Technical]** Where is the Keychain wrapper and how many call sites need to be updated to use the `pwragnt-{instance_id}` service name? Mechanical search and replace, but planning should enumerate.
- **[Affects R11][Technical]** Implementation of "two roots with the same `instance_id`" detection. Lockfile in the root? PID file? Defer to planning.
- **[Affects R17][Needs research]** Confirm WAL mode + `synchronous = NORMAL` is right for our access pattern. Also confirm migration runs inside a single transaction so a partial migration is impossible.
- **[Affects R18][Technical]** Exact ordering of operations during migration to keep the abort-and-revert guarantee. Specifically: do we write `state.db` to a temp path and rename, or build it in place and undo? Planning to choose.
- **[Affects R7, R12][Technical]** E2E harness: location of the helper that sets `PWRAGNT_HOME`, how Keychain teardown is invoked, and whether existing tests need to opt in or are migrated wholesale.
- **[Affects R5][Technical]** Audit the codebase for any remaining hardcoded references to XDG paths or `$HOME`-based path resolution; planning enumerates the call sites.
- **[Needs research]** Sanity-check `~/github/codex` for sqlite usage patterns we should mirror (busy timeouts, migration idiom, schema versioning conventions). Optional but worth a brief look during planning.

## Next Steps

→ `/ce:plan` for structured implementation planning
