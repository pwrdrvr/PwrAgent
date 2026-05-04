---
date: 2026-05-02
topic: config-and-state-relocation
---

# Config and State Relocation

## Revision (2026-05-02): Named Profiles

After the original brainstorm landed and Phase 1 of the plan shipped, we redesigned around **named profiles** (Chrome-style) instead of multiple sibling root directories. The original "single env var, multiple roots" decision is **superseded**. The original requirements text below is preserved for context, but the governing requirements are the ones in this revision block.

### What changed and why

The original design solved E2E isolation, dev profiles, and messenger profiles by pointing different `PWRAGNT_HOME` values at different sibling directories (`~/.pwragnt-dev`, `~/.pwragnt-sstk`, etc.). It worked but had three problems:

1. **`$HOME` clutter.** Every long-lived profile becomes a sibling directory in `$HOME`. A user with five messenger personas ends up with `~/.pwragnt`, `~/.pwragnt-sstk`, `~/.pwragnt-giphy`, `~/.pwragnt-personal`, `~/.pwragnt-test`. The "I hate the sprawl" complaint that triggered this work re-emerges in a new form.
2. **No UX surface for non-developer users.** The original design was dev-only — you had to set an env var to use it. Real users wouldn't.
3. **Keychain instance_id namespacing was awkward.** It existed only to handle a problem the new design dissolves: secrets are now per-profile by virtue of living in each profile's `state.db`, no service-name prefix needed.

### Revised requirements (these govern)

#### Profile model

- **PR1.** A **profile** is a fully isolated unit of state: config, sqlite DB, projects, and (eventually) credentials. Identified by a `profile_name`.
- **PR2.** Profile names match `^[a-z0-9][a-z0-9_-]{0,31}$` — lowercase ASCII, hyphens and underscores, must start with alphanumeric, max 32 chars. Reserved names rejected: `con`, `nul`, `aux`, `prn`, `.`, `..`. The validator is the single source of truth; the same regex is enforced in the picker UI, the CLI flag, and the env var.
- **PR3.** Each profile has a free-form UTF-8 `display_name` shown in the picker. Defaults to `profile_name` if unset.
- **PR4.** All profiles are equal. There is no privileged "default" profile — `default` is just the conventional name for the first profile and lives under `profiles/default/` like every other profile. (User pick.)

#### On-disk layout

```
~/.pwragnt/
├── profiles.toml                          # registry: profiles + display names + last_used
└── profiles/
    ├── default/
    │   ├── config.toml
    │   ├── state/state.db
    │   └── projects/
    └── sstk/
        ├── config.toml
        ├── state/state.db
        └── projects/
```

- **PR5.** The new root is `~/.pwragnt/`. No top-level config or state files at the root — only `profiles.toml` and `profiles/`.
- **PR6.** Each profile directory is fully self-contained: deleting `~/.pwragnt/profiles/sstk/` removes everything for that profile, no orphaned data anywhere on the system.
- **PR7.** `profiles.toml` is the registry. Schema:
  ```toml
  last_used = "default"

  [profiles.default]
  display_name = "Default"

  [profiles.sstk]
  display_name = "Shutterstock"
  ```

#### Selection and overrides

- **PR8.** Profile selection precedence (highest first): `--profile <name>` CLI arg → `PWRAGNT_PROFILE=<name>` env var → `last_used` from `profiles.toml` → the literal name `default`.
- **PR9.** **Auto-create.** If the selected profile name does not exist, the app creates it on launch with the same flow as a fresh install (empty state, registers in `profiles.toml`, sets `display_name = profile_name`). Same as if you'd given it a fresh `PWRAGNT_HOME` under the original design.
- **PR10.** `PWRAGNT_HOME` is **kept as a root override** (still useful: E2E points it at a tempdir, dev workstations may relocate the entire registry). Default is `~/.pwragnt/`. So in a test you can set both: `PWRAGNT_HOME=/tmp/e2e-run-42 PWRAGNT_PROFILE=test1` to get isolation at both levels.

#### Multi-instance and process model

- **PR11.** Picking another profile from the in-app picker spawns a **new OS process** (`pwragnt --profile <name>`). One process per active profile. Simple, no shared singletons to refactor, no IPC fanout.
- **PR12.** The application window title includes the profile's `display_name` (and `profile_name` if it differs). This is required, not aesthetic — without it, a user with multiple windows can't tell them apart at a glance. (User pick.)
- **PR13.** Two processes for the *same* profile are not allowed: a per-profile lockfile at `profiles/<name>/state/instance.lock` prevents accidental concurrent writers. If a user opens "default" twice, the second launch focuses the existing window instead. (Standard Electron `app.requestSingleInstanceLock` pattern, scoped per profile.)

#### Settings UI

- **PR14.** The Settings widget edits the *current window's* profile only. No cross-profile settings UI in this work.
- **PR15.** A profile picker (Chrome-style) lives in the app menubar (or window-level menu). It lists profiles from `profiles.toml`, shows their `display_name`, and "Open in <profile>" launches the new-process flow. A "Manage profiles…" entry opens a small UI for creating, renaming, and deleting profiles. The menu also exposes the current profile's name as a non-clickable header.

#### Secrets

- **PR16.** Secrets live in a `secrets` table inside each profile's `state.db`, encrypted via Electron's `safeStorage`. (Same as the plan's C1 correction; what changes is that "instance_id namespacing" is gone — namespacing comes from being inside a per-profile DB file.)
- **PR17.** No native macOS Keychain entries are written by the app. The single `safeStorage` wrap key (which Electron itself stores in the OS Keychain at the app-bundle level) is shared across profiles on a machine — acceptable, same threat model as today.

#### Codex limitation (carried forward)

- **PR18.** Codex thread state lives in `~/.codex/`, outside our control. It is shared across PwrAgnt profiles. The picker UI surfaces this once: a small note in "Manage profiles…" explains that Codex history is not isolated. (Carried from origin §R8.)

### Migration impact

- The old XDG migration target moves from `~/.pwragnt/state/state.db` to `~/.pwragnt/profiles/default/state/state.db`. Same migration logic, deeper destination path.
- The original `instance_id` field is replaced by `profile_name`, written into `meta` table.
- `PWRAGNT_HOME` from Phase 1 stays as a root override; `PWRAGNT_PROFILE` is added as the profile selector.

### Phasing under this redesign

- **Phase 1 (shipped, [PR #152](https://github.com/pwrdrvr/PwrAgnt/pull/152)):** `PWRAGNT_HOME` resolver — survives. The resolver's job becomes "compute the root," and a new layer above it computes "compute the profile path within the root."
- **Phase 2 (next, ships before tomorrow's release):** sqlite + migration. Migration target is `~/.pwragnt/profiles/default/`. `profiles.toml` is created with one entry. No picker UI yet. `--profile` and `PWRAGNT_PROFILE` work for E2E isolation but no in-app way to switch. **This is what tomorrow's users get.**
- **Phase 3:** E2E harness flips to `PWRAGNT_PROFILE`. Old `PWRAGNT_STATE_ROOT` / `PWRAGNT_CONFIG_PATH` / `GROK_APP_SERVER_STATE_ROOT` / `HOME`-override fixture removed. Specs that read `overlay-state.json` directly migrated to `state.db` reads.
- **Phase 4:** Profile picker menu, "Open in profile" → new process, "Manage profiles…" UI, window-title injection (PR12). This is the user-facing surface; ships after the core relocation has soaked.

### Out of scope (clarifications under this redesign)

- **Cross-profile shared anything.** Each profile is fully isolated.
- **Profile-level encryption.** Same threat model as today.
- **Renaming a profile while it's running.** Manage Profiles UI requires the profile to be inactive (no live process holding its lockfile).
- **Importing/exporting profiles.** Future work. For now: `cp -R ~/.pwragnt/profiles/sstk ~/.pwragnt/profiles/sstk-copy && edit profiles.toml`.

---

(Original brainstorm content below, preserved for historical context. Where the original conflicts with the revision above, the revision wins.)

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
