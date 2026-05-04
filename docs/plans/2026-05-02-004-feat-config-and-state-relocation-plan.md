---
title: Config and State Relocation
type: feat
status: completed
date: 2026-05-02
origin: docs/brainstorms/2026-05-02-config-and-state-relocation-requirements.md
---

# Config and State Relocation

## Revision (2026-05-02): Named Profiles

**This plan was revised after Phase 1 shipped.** The original "single env var, multiple roots" model is **superseded** by named profiles inside one root. See [origin brainstorm §Revision](../brainstorms/2026-05-02-config-and-state-relocation-requirements.md#revision-2026-05-02-named-profiles) for the full rationale; the short version is below. The original plan content is preserved beneath this block for historical context — where the original conflicts with this revision, the revision governs.

### What this plan now ships

A single root at `~/.pwragnt/` containing a profile registry and per-profile subdirectories:

```
~/.pwragnt/
├── profiles.toml                          # registry: profiles + display_name + last_used
└── profiles/
    ├── default/
    │   ├── config.toml
    │   ├── state/state.db
    │   └── projects/
    └── <named>/                           # additional profiles (sstk, dev, etc.)
        └── …
```

There is no privileged "default" profile — `default` is just the conventional first profile, structurally identical to any other. Profile selection precedence: `--profile <name>` → `PWRAGNT_PROFILE=<name>` → `last_used` from `profiles.toml` → `default`. `PWRAGNT_HOME` survives as a *root* override (E2E tempdir, full relocation); `PWRAGNT_PROFILE` is the new *profile* selector.

Profile names match `^[a-z0-9][a-z0-9_-]{0,31}$`; reserved names (`con`, `nul`, `aux`, `prn`, `.`, `..`) are rejected. Display name is free-form UTF-8, separate field, used only in the picker UI.

Multi-profile UX is process-per-profile: clicking "Open in profile X" from the picker spawns `pwragnt --profile X` as a new OS process. Window title includes the profile's display name. A per-profile lockfile (`profiles/<name>/state/instance.lock`) prevents two processes from writing to the same profile.

### What changed vs. the original plan

| Topic | Original | Revised |
| --- | --- | --- |
| Isolation primitive | Multiple sibling root dirs (`~/.pwragnt-sstk`) | Named profiles in one root (`~/.pwragnt/profiles/sstk/`) |
| Profile selection | `PWRAGNT_HOME=~/.pwragnt-sstk` | `--profile sstk` or `PWRAGNT_PROFILE=sstk` |
| Migration target | `~/.pwragnt/state/state.db` | `~/.pwragnt/profiles/default/state/state.db` |
| Secrets namespacing | `instance_id` in `meta` → `pwragnt-{instance_id}` Keychain prefix (per C1, fell through to in-DB) | Per-profile DB file is the namespace; no `instance_id` field, no Keychain naming concern |
| User-facing surface | None (env var only) | Profile picker menu + "Open in profile" (Phase 4) |
| `PWRAGNT_HOME` semantics | THE selector | Root override (still useful for E2E tempdir); `PWRAGNT_PROFILE` is the selector |
| `app.getPath("userData")` redirect (C4) | `$PWRAGNT_HOME/state/protocol-captures/` | `$PWRAGNT_HOME/profiles/<active>/state/protocol-captures/` |
| Schema `meta` table | rows include `instance_id` | rows include `profile_name` |
| C2 deprecation list | `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`, `GROK_APP_SERVER_STATE_ROOT` | Same — still removed in Phase 3 |
| C5 (Playwright `workers: 1`) | Unchanged | Unchanged — still preserved this release |

### Revised phasing

- **Phase 1 (shipped, [PR #152](https://github.com/pwrdrvr/PwrAgnt/pull/152)):** `PWRAGNT_HOME` env-var resolver added across the four path-resolution sites. Survives the redesign — the resolver's job becomes "compute the root," with a new layer above it computing "compute the path within the active profile."
- **Phase 2 (next; ships before tomorrow's release):** the core relocation. Adds:
  - `apps/desktop/src/main/profile.ts` — name validation, registry I/O, selection precedence, auto-create. `resolveActiveProfilePath(segment)` is the new top-level helper that callers use.
  - sqlite + migration into `profiles/default/state/state.db`. Same migration code as the original plan, deeper destination path. `meta.profile_name = 'default'`.
  - `profiles.toml` registry created on first launch (with one `default` entry).
  - All four Phase 1 resolvers re-pointed at `resolveActiveProfilePath(...)` instead of `pwragntPath(...)`.
  - `PWRAGNT_PROFILE` env var honored for E2E auto-create (PR9).
  - ~~Per-profile lockfile~~ — **Dropped.** sqlite WAL mode handles multi-process concurrent access safely. Multiple instances sharing the same profile DB is supported; writes are naturally convergent (same backend data) or single-writer (messaging).
  - **No picker UI in this phase.** Profiles work via env/CLI only. Tomorrow's users get a single `default` profile and the cleaner directory layout.
- **Phase 3:** E2E harness flips to `PWRAGNT_PROFILE=e2e-<runid>` (auto-create). Old escape hatches removed. Specs reading `overlay-state.json` directly migrated to `state.db`.
- **Phase 4:** the user-facing surface — profile picker menu, "Open in profile" via new-process spawn, "Manage profiles…" widget, window-title injection (PR12). Ships after the core relocation has soaked. This is also where `--profile` becomes a documented user feature rather than a dev knob.

### How the original plan body still applies

Everything below (sqlite schema, PRAGMAs, migration choreography, GC TTLs, the C1–C5 corrections, the risk register) **still applies** with these small substitutions:

- Wherever the old plan says `$PWRAGNT_HOME/state/state.db`, read it as `$PWRAGNT_HOME/profiles/<active>/state/state.db`.
- Wherever it says `instance_id`, read it as `profile_name`.
- The `meta` table schema in §Schema gets `profile_name` instead of `instance_id`. No other column changes.
- The lockfile content is `{ "profile_name": "...", "pid": ..., "started_at": ..., "hostname": "..." }`. Same logic.
- The `pwragnt migrate-state --rerun` CLI gains an implicit profile selector — it migrates into the active profile's DB.
- The "two roots with same instance_id" collision case is dropped — replaced by the simpler "two processes on same profile" lockfile case (PR13), which Electron's `requestSingleInstanceLock` handles natively.

### Known limitations carried forward

- **Codex thread state remains shared across profiles** (`~/.codex/`). PR18: surface this in the "Manage profiles…" UI when it lands.
- **One `safeStorage` wrap key per machine** at the Electron level. Profile-level secret isolation comes from each profile's DB file, not from per-profile keychain entries. Same threat model as today.

---

(Original plan content below, preserved for context. Substitute as noted above.)

## Overview

Collapse the desktop app's three independent config/state locations (`~/.config/pwragnt/`, `~/.local/state/pwragnt/`, `~/.pwragnt/projects/`) plus a fourth Electron-managed location (`app.getPath("userData")` for protocol captures) into a single root at `~/.pwragnt/`, controlled by one new env var `PWRAGNT_HOME`. Migrate `messaging-state.json` (4.3 MB, full-rewrite) and `overlay-state.json` (200 KB, full-rewrite) into a single sqlite database `state/state.db`. Namespace per-instance secrets so multiple roots can coexist for E2E and dev-profile use cases. Ship with a one-shot migration that retains old files as `.bak.<timestamp>` for recovery.

**Origin:** [docs/brainstorms/2026-05-02-config-and-state-relocation-requirements.md](../brainstorms/2026-05-02-config-and-state-relocation-requirements.md). Decisions carried forward in full: single root + `PWRAGNT_HOME` (origin §Path layout), `instance_id`-namespaced secrets (origin §Keychain), sqlite-only state (origin §State storage), migrate-and-back-up not dual-write (origin §Migration). All scope-OUT items from the origin remain out of scope here (`projects/` restructuring, JSONL, inline named profiles, named messenger configs, encryption, log relocation, auto-deletion of `.bak`).

**Plan-time corrections to the origin doc.** Local research (see Sources) surfaced five factual issues with the origin's framing. Each is resolved below as a `[Plan-time decision]` rather than re-routed back to brainstorming, given the release-tomorrow constraint:

- **C1 — Secrets are not in the Keychain today.** Origin R10/R16 say the app already migrated to Keychain and `settings-secrets.json` is dead. In reality, `settings-secrets.json` is the *active* secret store, holding `safeStorage`-encrypted ciphertext blobs (`apps/desktop/src/main/settings/desktop-secret-store.ts:30-119`). The R10 framing of "all Keychain entries use service name `pwragnt-{instance_id}`" cannot be applied because there are no per-key Keychain entries to namespace. **Resolution:** keep `safeStorage` for encryption (Electron's built-in, already vetted; `keytar` is archived per `docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md:58-65`), but move the ciphertext rows from `settings-secrets.json` into a `secrets` table inside `state.db`. Per-instance namespacing comes for free from `PWRAGNT_HOME`. The "wrap key" that `safeStorage` itself stores in the OS Keychain remains shared across instances on a machine — this is acceptable because the unit of namespacing the origin actually cares about is "which set of bot tokens does this instance see," and that's now bound to the DB file, not to a Keychain service name.
- **C2 — `PWRAGNT_STATE_ROOT` and `PWRAGNT_CONFIG_PATH` already exist** (`apps/desktop/src/main/app-server/desktop-state-root.ts:4`, `apps/desktop/src/main/settings/desktop-settings-env.ts:6`) and are used by E2E specs. **Resolution:** `PWRAGNT_HOME` is the only new variable; the two existing variables are removed in the same release and the small set of E2E specs that use them is updated. No deprecation aliases — internal-only env vars, churn cost is low, ambiguity cost of three overlapping vars is high.
- **C3 — `agent-core`'s Grok app-server config (`~/.config/grok-app-server/config.toml`) is a fourth location** that origin R5 forbids leaving outside the root. **Resolution:** relocate it to `$PWRAGNT_HOME/grok-app-server/config.toml` in the same migration step. Existing override `GROK_APP_SERVER_STATE_ROOT` is removed; agent-core's `resolveGrokAppServerRuntimeConfig` learns to honor `PWRAGNT_HOME`.
- **C4 — `app.getPath("userData")` is a fifth location** used for protocol captures (`apps/desktop/src/main/app-server/backend-registry.ts:938,955,972`, `apps/desktop/src/main/testing/protocol-capture.ts:40`). **Resolution:** for protocol captures specifically (the only consumer), redirect to `$PWRAGNT_HOME/state/protocol-captures/`. Do *not* override Electron's `app.setPath("userData", …)` globally — that has unbounded blast radius (cookies, cache, GPU shader cache, etc.) and is unnecessary if the only PwrAgnt-owned consumer is protocol captures.
- **C5 — Playwright `workers: 1`.** Origin SC3 promises parallel-suite isolation; current config (`apps/desktop/playwright.config.ts`) is single-worker. **Resolution:** keep `workers: 1` in this release. Adjust SC3 phrasing in the plan: "Two parallel E2E *invocations* (different shell sessions, different `PWRAGNT_HOME`) can run simultaneously without flakiness from shared state." Going `workers > 1` is a separate stability problem (Electron+Playwright coordination) and is explicitly out of scope here. The `PWRAGNT_HOME`-based isolation we ship is *necessary* for `workers > 1` later but not *sufficient*.

## Problem Statement

Three direct problems and one strategic one.

**Direct problems:**

1. **State sprawl makes the app hard to back up, inspect, and uninstall.** Files live across `~/.config/pwragnt/`, `~/.local/state/pwragnt/`, `~/.pwragnt/projects/`, plus `app.getPath("userData")/test-artifacts/protocol-captures` and `~/.config/grok-app-server/`. There is no single place for a user (or for support) to look.

2. **No real isolation primitive for multiple instances.** The only existing trick is overriding `$HOME`, which drags every XDG-using tool with it. This is fine for the single Playwright fixture that uses it (`apps/desktop/e2e/fixtures/electron-app.ts:57`) but breaks down for: parallel E2E invocations across branches, long-running stable+experimental dev profiles, and side-by-side Telegram/Discord identity testing during messenger development.

3. **`messaging-state.json` is 4.3 MB, full-rewritten on every mutation, and full of expired data.** All 53 `browseSessions` are expired (GC method exists, never called). `callbackHandles` (1117 KB), `pendingIntents` (871 KB), `deliveries` (1135 KB) account for 73% of the file. Each mutation rewrites everything atomically — fine for safety but pathological for hot tables. `overlay-state.json` follows the same pattern at smaller scale (199 thread metadata entries). Format pinning (per-mutation full JSON rewrite) caps how large state can grow before write latency hurts; we are not far from that ceiling on a slow disk.

**Strategic problem:**

The current layout makes the *next* feature harder, not just maintenance. Anything that wants to query state (e.g. "show me all threads on this directory," "expire pending intents on a timer") has to load and walk the whole JSON. Sqlite gives us indexed reads on `threads.directory_path` and a real DELETE WHERE expiry primitive without a custom GC pass per-table.

## Proposed Solution

A single self-contained PwrAgnt root, owned end-to-end by the app, with all persistent state in one sqlite file.

```
~/.pwragnt/                                # default root, override via PWRAGNT_HOME
├── config.toml                            # main desktop config (existing, relocated)
├── grok-app-server/
│   └── config.toml                        # agent-core Grok app-server config (relocated, C3)
├── state/
│   ├── state.db                           # ALL persistent state (sqlite, WAL)
│   ├── state.db-wal                       # sqlite write-ahead log sidecar
│   ├── state.db-shm                       # sqlite shared-memory sidecar
│   ├── instance.lock                      # advisory lock + instance_id sentinel
│   └── protocol-captures/                 # E2E protocol-capture artifacts (C4)
└── projects/                              # directory-less thread workspaces (untouched)
```

`~/.config/pwragnt/`, `~/.local/state/pwragnt/`, `~/.cache/pwragnt/`, and `~/.config/grok-app-server/` are never read or written after migration. Old XDG dirs are left containing only `.bak.<timestamp>` files (manual cleanup; origin R20).

`PWRAGNT_HOME` is the only new env var. `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`, and `GROK_APP_SERVER_STATE_ROOT` are removed. The Playwright fixture's `HOME` override is removed; tests use `PWRAGNT_HOME` to point at a fresh tempdir.

## Technical Approach

### Architecture

#### New module: `apps/desktop/src/main/pwragnt-home.ts`

Single source of truth for path resolution. ~30 lines.

```ts
// apps/desktop/src/main/pwragnt-home.ts
import { homedir } from "node:os";
import { resolve } from "node:path";

const ENV_KEY = "PWRAGNT_HOME";

let cached: string | undefined;

export function resolvePwragntHome(): string {
  if (cached) return cached;
  const fromEnv = process.env[ENV_KEY];
  cached = fromEnv ? resolve(fromEnv) : resolve(homedir(), ".pwragnt");
  return cached;
}

export function pwragntPath(...segments: string[]): string {
  return resolve(resolvePwragntHome(), ...segments);
}

// Test-only escape hatch; resets cache so test suites can swap homes.
export function __resetPwragntHomeCacheForTests(): void {
  cached = undefined;
}
```

Every existing path resolver collapses onto these two functions. Concrete replacements (file_path:line_number):
- `apps/desktop/src/main/settings/desktop-config.ts:57-66` (`defaultDesktopConfigDir`) → returns `pwragntPath("config.toml")`.
- `apps/desktop/src/main/app-server/desktop-state-root.ts:12-31` (`defaultDesktopStateRoot`, `resolveDesktopStateRoot`) → returns `pwragntPath("state")`.
- `apps/desktop/src/main/app-server/scratch-projects.ts:16` → `pwragntPath("projects")`.
- `packages/agent-core/src/config/grok-app-server-config.ts:29-79` → `pwragntPath("grok-app-server")` (via a callback injected from desktop, to preserve the agent-core/desktop boundary — see "Package boundaries" below).

#### New module: `apps/desktop/src/main/state/state-db.ts`

Single sqlite-wrapping module. Owns connection lifecycle, schema bootstrap, PRAGMAs, GC scheduling. ~150 lines including schema literals.

**Library:** `better-sqlite3` (synchronous API, single-threaded fits Electron main; idiomatic in the JS Electron ecosystem; native module, builds against Electron headers via `electron-rebuild`). No prior sqlite in this codebase, so this is a new dependency.

**Connection setup (on `open()`):**
```ts
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
db.pragma("auto_vacuum = INCREMENTAL");
```
Mirrors Codex's choices (`/Users/huntharo/github/codex/codex-rs/state/src/runtime.rs:168-194`). `INCREMENTAL` auto-vacuum needs to be set on a fresh DB; the migration step does this on first creation.

**Schema bootstrap.** `user_version` PRAGMA tracks schema version. On open: read `user_version`, run any pending migrations in a transaction, write the new `user_version`. Migrations are an in-tree array of SQL strings; no migrator framework. Simpler than sqlx, fits ~10 tables.

**Schema (v1):**

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');
INSERT INTO meta(key, value) VALUES ('migrated_from', '');  -- timestamp string when populated by migration
INSERT INTO meta(key, value) VALUES ('instance_id',   'default');

-- ============ messaging tables ============
CREATE TABLE bindings (
  binding_id     TEXT PRIMARY KEY,
  channel_kind   TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  payload        TEXT NOT NULL  -- JSON blob: opaque adapter state
);
CREATE INDEX idx_bindings_thread ON bindings(thread_id);
CREATE INDEX idx_bindings_channel ON bindings(channel_kind, channel_id);

CREATE TABLE pending_intents (
  intent_id   TEXT PRIMARY KEY,
  binding_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_pending_intents_expires ON pending_intents(expires_at);
CREATE INDEX idx_pending_intents_binding ON pending_intents(binding_id);

CREATE TABLE browse_sessions (
  session_id  TEXT PRIMARY KEY,
  binding_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_browse_sessions_expires ON browse_sessions(expires_at);

CREATE TABLE callback_handles (
  handle_id   TEXT PRIMARY KEY,
  session_id  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX idx_callback_handles_expires ON callback_handles(expires_at);
CREATE INDEX idx_callback_handles_session ON callback_handles(session_id);

CREATE TABLE deliveries (
  delivery_id   TEXT PRIMARY KEY,
  binding_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX idx_deliveries_binding_created ON deliveries(binding_id, created_at);

-- ============ overlay tables ============
CREATE TABLE backends (
  scope       TEXT PRIMARY KEY,            -- 'all' today; future-proofed
  payload     TEXT NOT NULL
);

CREATE TABLE launchpad_defaults (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE directory_launchpads (
  directory_path  TEXT PRIMARY KEY,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  settings_touched_at INTEGER
);

CREATE TABLE threads (
  thread_id        TEXT PRIMARY KEY,
  directory_path   TEXT,
  last_seen_at     INTEGER,
  dismissed_at     INTEGER,
  snoozed_until    INTEGER,
  payload          TEXT NOT NULL  -- everything else: opaque blob today, indexable tomorrow
);
CREATE INDEX idx_threads_directory ON threads(directory_path);
CREATE INDEX idx_threads_dismissed ON threads(dismissed_at);

-- ============ secrets (replaces settings-secrets.json) ============
CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,           -- e.g. 'telegramBotToken', 'discordBotToken', 'grokApiKey'
  ciphertext  BLOB NOT NULL,              -- safeStorage.encryptString(...) output
  updated_at  INTEGER NOT NULL
);
```

Rationale for the column shape:
- **Hot fields are columns**, the rest is a `payload` JSON blob. We index `expires_at` (GC), `directory_path` (thread queries), `binding_id` (cascades). Everything else stays opaque, satisfying the `packages/messaging/AGENTS.md` boundary that adapter state is opaque.
- **No foreign keys between messaging tables.** Existing JSON has no FKs, and `revokeBinding` (`apps/desktop/src/main/messaging/core/messaging-store.ts:72-107`) cascades manually. A FK with `ON DELETE CASCADE` would change observable behavior. Stay manual. We *do* enable `foreign_keys = ON` for any future tables that opt in.
- **`secrets`** stores `safeStorage`-encrypted blobs (per C1). The wrap key is still in the OS Keychain at the Electron app level; per-instance secret isolation comes from each PWRAGNT_HOME having its own `state.db`.

**Read/write API.** Single `StateDb` class exposes typed methods that mirror the existing `OverlayStore` and `MessagingStore` surfaces. The two store classes are reimplemented to call `StateDb` instead of file IO. **The per-file write queue in `overlay-store.ts:29,475-495` is deleted** — sqlite's busy_timeout + transactions are the new serialization mechanism.

**Single writer, multiple readers.** Desktop main process is the sole writer. Renderer reads via existing IPC; no direct DB access from renderer. WAL mode allows concurrent readers without blocking the writer.

**GC scheduler.**
- On `StateDb.open()`: run `cleanupExpired()` once.
- A `setInterval(..., 60 * 60 * 1000)` runs `cleanupExpired()` every hour while the app is open.
- `cleanupExpired()` runs four DELETEs in a single transaction:
  - `DELETE FROM browse_sessions WHERE expires_at < ?` (now)
  - `DELETE FROM pending_intents WHERE expires_at < ?` (now)
  - `DELETE FROM callback_handles WHERE expires_at < ?` (now)
  - `DELETE FROM deliveries WHERE created_at < ?` (now − 30 days, see Deferred-question resolution below)
- After GC, run `PRAGMA incremental_vacuum` (matches codex pattern).

**Deferred-question resolution: TTLs (origin §Deferred to Planning).**

| Table | Policy | Rationale |
| --- | --- | --- |
| `browse_sessions` | `expires_at < now` | Type already declares `expiresAt`; lazy filtering exists in reads. Trivial. |
| `pending_intents` | `expires_at < now` | Same. |
| `callback_handles` | `expires_at < now` | Same. |
| `deliveries` | `created_at < now − 30 days` | No native TTL today. 30 days matches the "auditable recent history" framing in `messaging-store.ts:340-352` writers; nothing reads deliveries older than that in the existing UI. Configurable via `config.toml` `[state.gc] deliveries_retention_days = 30`. |
| `bindings` | `revoked_at IS NOT NULL AND revoked_at < now − 90 days` | Revoked bindings are kept for forensic inspection but eventually pruned. |
| `threads`, `directory_launchpads`, `launchpad_defaults`, `backends`, `secrets`, `meta` | No TTL | Long-lived; user-driven removal only. |

#### `instance_id` and lockfile (origin R9, R11)

`instance_id` lives in two places: the `meta` table (`SELECT value FROM meta WHERE key='instance_id'`) and as a sentinel inside `state/instance.lock`. The lockfile is the runtime collision-detection primitive (origin R11 deferred-question).

**Lockfile schema (`state/instance.lock`, JSON):**
```json
{ "instance_id": "default", "pid": 12345, "started_at": 1714612345678, "hostname": "huntharo-mbp" }
```

**Acquire on app start:**
1. If `state/instance.lock` does not exist → write it, proceed.
2. If it exists, read it. If the PID is alive on the same hostname → fail loud with: `"Another PwrAgnt instance is already using $PWRAGNT_HOME (instance_id=default, pid=12345). Set PWRAGNT_HOME to a different directory or stop the other instance."`
3. If the PID is dead or hostname mismatch → log, overwrite, proceed (stale lock).
4. Release on graceful shutdown (`app.on('before-quit')`).

This is the simplest version that catches the user's most likely mistake (running two instances against the same root). Fancier process locking via `flock(2)` is a follow-up if it proves needed.

**On a forked root:** if `meta.instance_id` matches another running instance's lockfile (different PWRAGNT_HOMEs but same instance_id), we still detect — the lockfiles are per-root, but each writes its instance_id. We don't currently *cross-check* across roots, because that would require enumerating all roots, which we don't know how to do. Acceptable for tomorrow; called out as a known limitation. The Keychain-collision risk doesn't apply because secrets are now per-DB (C1), not per-Keychain-service.

#### Migration

One module: `apps/desktop/src/main/state/migration.ts`. ~250 lines including helpers and per-table converters.

**Trigger.** Runs at app startup before any other code reads from the new root. Idempotent (origin R19).

```ts
export async function migrateIfNeeded(): Promise<MigrationOutcome>;
```

**Pre-checks:**
1. Compute paths: `home = resolvePwragntHome()`, `dbPath = pwragntPath("state/state.db")`.
2. If `dbPath` exists and has `meta.schema_version >= 1` → no-op, return `{ status: "already-migrated" }`.
3. If `dbPath` does not exist:
   - If old paths exist (`~/.config/pwragnt/config.toml` OR `~/.local/state/pwragnt/messaging-state.json` OR `~/.local/state/pwragnt/overlay-state.json` OR `~/.config/grok-app-server/config.toml`), proceed to **migrate**.
   - Otherwise → `freshInstall()` (just creates empty DB at `dbPath`).

**Migration steps (in order):**
1. **Acquire** lockfile at `state/instance.lock` (with the rules above; if locked, abort). This keeps two simultaneously-launching processes from racing on migration.
2. **Pre-flight read** of all source files. Parse JSON. If any parse fails → abort migration (origin R21: fail loud), surface the parse error, leave old files intact.
3. **Build** `state.db.tmp` at `pwragntPath("state/state.db.tmp")`:
   - `mkdir -p` the parent.
   - Open new sqlite DB.
   - Apply schema v1.
   - In a single transaction:
     - INSERT `meta` rows (`schema_version=1`, `instance_id='default'`, `migrated_from='<timestamp>'`).
     - For each top-level key in the JSON sources, run the per-table converter (decode each row, validate required fields, INSERT). Per-row decode error → abort transaction, abort migration. **Do not skip rows silently.**
     - Log per-table row counts (origin R21).
   - `COMMIT`.
   - `PRAGMA wal_checkpoint(TRUNCATE)` to flush.
   - Close.
4. **Verify counts** — re-open `state.db.tmp` read-only, count rows in each table, compare to JSON inputs. Mismatch → abort, delete `.tmp`, leave old files alone.
5. **Atomic rename** `state.db.tmp` → `state.db` (and any `.tmp-wal` / `.tmp-shm` sidecars are not present yet because the connection was closed; verify with assertion).
6. **Copy** `~/.config/pwragnt/config.toml` → `$PWRAGNT_HOME/config.toml` (if exists; preserve permissions).
7. **Copy** `~/.config/grok-app-server/config.toml` → `$PWRAGNT_HOME/grok-app-server/config.toml` (if exists). Note: this is the only step that touches the agent-core config; agent-core itself just reads from the new path on next startup.
8. **Rename** old files to `.bak.<timestamp>` *in place*:
   - `~/.local/state/pwragnt/messaging-state.json` → `~/.local/state/pwragnt/messaging-state.json.bak.<ts>`
   - `~/.local/state/pwragnt/overlay-state.json` → `~/.local/state/pwragnt/overlay-state.json.bak.<ts>`
   - `~/.local/state/pwragnt/settings-secrets.json` → `~/.local/state/pwragnt/settings-secrets.json.bak.<ts>` (after its rows have been migrated into `secrets` table)
   - `~/.config/pwragnt/config.toml` → `~/.config/pwragnt/config.toml.bak.<ts>`
   - `~/.config/grok-app-server/config.toml` → `~/.config/grok-app-server/config.toml.bak.<ts>`
9. **Write migration marker** by updating `meta.migrated_from` to the timestamp string. (Already inserted in step 3; this is a no-op safety check.)
10. **Release** lockfile (or hand off to the running app's lifecycle).

**Abort path.** Any error in steps 1–6: delete `state.db.tmp`, do not touch any old file, surface error to the user via a startup error dialog with the original error message and a hint to file a bug. The app refuses to start. (Origin §Migration: "fail loud, fail early.")

**CLI re-run command.** `pwragnt migrate-state --rerun --from <bak-path>` (origin R19). Implemented as a hidden command in the desktop app's main process: launches Electron with `--rerun-migration=<path>`, the migrator reads the `.bak` file as if it were the live source, and writes a fresh `state.db` (overwriting). For tomorrow this can be a minimal version — just enough to recover from a bad migration if one happens.

#### Keychain — concretely, for C1

- `safeStorage.encryptString(plaintext)` → `Buffer` of ciphertext.
- Stored in `secrets.ciphertext` (BLOB column).
- `getSecret(key)`: `SELECT ciphertext FROM secrets WHERE key = ?`, then `safeStorage.decryptString(buf)`.
- `setSecret(key, plaintext)`: `INSERT OR REPLACE INTO secrets(key, ciphertext, updated_at) VALUES (?, ?, ?)`.
- `deleteSecret(key)`: `DELETE FROM secrets WHERE key = ?`.

The existing `DesktopSecretStore` interface (`apps/desktop/src/main/settings/desktop-secret-store.ts:22-28`) is preserved; the implementation switches from file-backed to DB-backed. All call sites in `desktop-settings-service.ts` (`:19,49,218,225,230,242-243,427,449`) are unchanged.

**`safeStorage.isEncryptionAvailable()` and the `basic_text` Linux fallback** stay enforced as today (`desktop-secret-store.ts:40-58`): if encryption is unavailable, secret writes are refused. No regression.

**Tests.** The existing `MemoryDesktopSecretStore` (used in `desktop-settings-service.test.ts`, `settings-ipc.test.ts`, `messaging-config.test.ts`) continues to work — it's already an in-memory implementation of the interface and doesn't depend on the file backend.

#### Package boundaries

`packages/messaging/AGENTS.md` forbids messaging packages from importing desktop or agent-core code. The new `state-db.ts` lives in `apps/desktop/src/main/`, so:
- `MessagingStore` (which lives in `apps/desktop/src/main/messaging/core/`) calls `state-db.ts` directly. No boundary issue.
- `OverlayStore` lives in `packages/agent-core/src/persistence/`. **Decision:** the storage *adapter* moves to `apps/desktop/src/main/state/overlay-store-sqlite.ts`. `packages/agent-core` keeps the data contract (types in `migrations.ts`) only, and exposes an `OverlayStorePort` interface that the desktop wires up to sqlite. This mirrors the messaging package boundary pattern. Existing `apps/desktop/src/main/app-server/desktop-overlay-store.ts:6-9` already wires the singleton, so the change is local.

#### Removed code

- `apps/desktop/src/main/settings/desktop-settings-env.ts:6` — `PWRAGNT_CONFIG_PATH` parser.
- `apps/desktop/src/main/app-server/desktop-state-root.ts:4` — `PWRAGNT_STATE_ROOT` parser.
- `packages/agent-core/src/config/grok-app-server-config.ts:56` — `GROK_APP_SERVER_STATE_ROOT` parser.
- `apps/desktop/e2e/fixtures/electron-app.ts:57` — `HOME` override (replaced with `PWRAGNT_HOME`).
- `apps/desktop/src/main/settings/desktop-secret-store.ts:30-119` (`FileBackedSafeStorageSecretStore`) — replaced with `DbBackedSafeStorageSecretStore`. File reduced to interface + new impl.
- `packages/agent-core/src/persistence/overlay-store.ts:29,475-495,526-531` — per-file write queue and atomic-write code, replaced by sqlite transactions.
- `apps/desktop/src/main/messaging/core/messaging-store.ts:23,358-385,407-412` — same.
- `apps/desktop/src/main/app-server/scratch-projects.ts:16` — `os.homedir()` literal, replaced by `pwragntPath("projects")`.

### Implementation Phases

Single release; phases are implementation order, not separate ships.

#### Phase 1: Foundation (~2 hrs)

**Goal:** `PWRAGNT_HOME` resolver lands; old env vars still work via temporary aliases. App still uses JSON state. Nothing user-visible changes yet.

**Tasks:**
- Add `apps/desktop/src/main/pwragnt-home.ts` (the ~30-line module above).
- Replace `defaultDesktopConfigDir`, `defaultDesktopStateRoot`, and the `scratch-projects.ts` literal with calls to `pwragntPath(...)`. **Default behavior unchanged** because when `PWRAGNT_HOME` is unset, the resolver returns `~/.pwragnt/` — but config still lives at `~/.config/pwragnt/` until Phase 2 flips the path. Mitigation: in this phase, the resolver returns `pwragntPath("config.toml")` for the new path *only if* `PWRAGNT_HOME` is set; otherwise it returns the old XDG path. Phase 2 removes that branch.
- For agent-core's grok-app-server config: pass `pwragntPath("grok-app-server")` from desktop into agent-core via `resolveGrokAppServerRuntimeConfig`'s existing `state_root` config knob (no boundary violation; just plumbing).
- No DB code yet. No migration yet.
- Unit tests: `__resetPwragntHomeCacheForTests()` round-trip; `PWRAGNT_HOME` set vs unset returns expected paths.

**Success criteria:**
- All path-resolving tests pass with no behavior changes.
- `PWRAGNT_HOME=/tmp/foo pnpm test:desktop-e2e` runs the suite against `/tmp/foo` and the suite still passes (XDG layout under that dir).

#### Phase 2: sqlite + migration (~6 hrs, the hard part)

**Goal:** state moves to sqlite. Migration runs on first launch. Old files become `.bak`.

**Tasks:**
- Add `better-sqlite3` to `apps/desktop/package.json` dependencies. Add `electron-rebuild` invocation to the existing post-install hook (verify with a trial build).
- Create `apps/desktop/src/main/state/state-db.ts` (schema literals, PRAGMAs, GC, lockfile).
- Create `apps/desktop/src/main/state/migration.ts` (the migration module above).
- Reimplement `OverlayStore` and `MessagingStore` against `StateDb`. Delete the per-file write queue and atomic-rename code in both. Keep the existing public methods identical — call sites don't change.
- Replace `FileBackedSafeStorageSecretStore` with `DbBackedSafeStorageSecretStore`. Same interface.
- Wire `migrateIfNeeded()` into `apps/desktop/src/main/index.ts` (or wherever the app's startup sequence is) before any store is opened.
- Wire `cleanupExpired()` into `DesktopMessagingRuntime` (see `messaging-runtime.ts:1-130`) — startup call + 1h interval.

**Tests (this is where the work is):**
- `state-db.test.ts`: schema bootstrap, PRAGMAs applied, `cleanupExpired` deletes only expired rows, `incremental_vacuum` runs without error, schema migrations are idempotent.
- `migration.test.ts`: feed a fixture copy of the test author's actual `messaging-state.json` (4.3 MB) and `overlay-state.json` through `migrateIfNeeded()` in a tempdir; verify per-table row counts match; spot-check a sampled record per table; verify `.bak` files exist and originals are gone; re-run migration → no-op. **This is the test that prevents data loss in production.** Origin SC6 explicitly demands this.
- `migration-abort.test.ts`: corrupt one of the source JSON files → migration aborts, no `state.db` left behind, no `.bak` files created.
- `secret-store-db.test.ts`: round-trip a secret through the new DB-backed implementation; legacy `MemoryDesktopSecretStore` continues to satisfy the same interface.
- Reuse existing `OverlayStore` / `MessagingStore` test suites against the new sqlite-backed impl. They should pass unchanged (interface preserved).

**Success criteria:**
- Test suite passes locally.
- Manual smoke test on the test author's actual machine: build, launch, verify `~/.pwragnt/state/state.db` exists, all threads visible, all messaging bindings active, `.bak` files at the old XDG paths.
- `state.db` size < 1 MB on the test author's data (origin SC5).

#### Phase 3: E2E harness + cleanup (~2 hrs)

**Goal:** E2E tests use `PWRAGNT_HOME`; old escape-hatch env vars are removed; renderer specs that read `overlay-state.json` directly are migrated.

**Tasks:**
- Update `apps/desktop/e2e/fixtures/electron-app.ts:49-74`:
  - Replace `mkdtemp("pwragnt-desktop-e2e-home-")` with `mkdtemp("pwragnt-e2e-home-")` — same idea, semantics preserved.
  - Remove `HOME: homeRoot` injection.
  - Add `PWRAGNT_HOME: homeRoot` injection.
  - Add cleanup of secrets via `safeStorage` is **not needed** since secrets are now in the per-test `state.db` and cleaned up with the tempdir.
  - `delete env.ELECTRON_RENDERER_URL` (line 61) preserved — unrelated.
- Update the four specs that read `overlay-state.json` directly:
  - `apps/desktop/e2e/provider-model-selectors.spec.ts:33,38,93`
  - `apps/desktop/e2e/thread-branch-drift.spec.ts:11,15,17,44,158,167,184`
  - `apps/desktop/e2e/directory-launchpad-skills.spec.ts:194-199, 868-901, 1219-1256`
  - `apps/desktop/e2e/directory-launchpad-workspace.spec.ts:278-283,344,385,439`
  - Replace direct file-read/seed with a small `seedStateDb(homeRoot, fixture)` helper that opens `state.db` in the test tempdir and INSERTs rows. New helper at `apps/desktop/e2e/fixtures/state-db-seed.ts`.
- Update unit tests that stub `PWRAGNT_STATE_ROOT` / `XDG_CONFIG_HOME` (e.g. `apps/desktop/src/main/__tests__/desktop-messaging-store.test.ts:10-33`, `packages/agent-core/src/__tests__/test-harness.test.ts:17-43`) to stub `PWRAGNT_HOME` instead.
- Remove `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`, `GROK_APP_SERVER_STATE_ROOT` parsers and their consumers.
- Add `apps/desktop/src/main/app-server/backend-registry.ts:938,955,972` and `apps/desktop/src/main/testing/protocol-capture.ts:40` redirect from `app.getPath("userData")` to `pwragntPath("state/protocol-captures")` (C4).

**Success criteria:**
- `pnpm test:desktop-e2e` passes.
- `pnpm test` (full workspace) passes.
- Manually: `PWRAGNT_HOME=~/.pwragnt-dev pwragnt` launches a clean second instance with no Telegram/Discord secrets carried over (origin SC4).

#### Phase 4: Documentation + release prep (~1 hr)

**Tasks:**
- Update root `AGENTS.md` "Runtime Config" section: `~/.pwragnt/` is now the root; `PWRAGNT_HOME` overrides; document the dev-profile recipe (origin R23).
- Update `docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md` with a closing note pointing here.
- Add a one-paragraph "Migration" note to the release notes / README.

**Success criteria:**
- AGENTS.md mentions `PWRAGNT_HOME` and the dev-profile recipe.

## Alternative Approaches Considered

- **JSONL append-mostly + periodic compaction (rejected during brainstorm).** Already covered in origin §Key Decisions. Repeating only for completeness: more code paths than sqlite, no win on indexed reads (which we want for `threads.directory_path`), and the existing per-table GC methods don't compose with append-only formats without re-reading the tail.
- **Inline named profiles (`profiles/{name}/`) inside one root (rejected during brainstorm).** Origin §Scope Boundaries.
- **Native macOS Keychain entries via `security` CLI (considered then rejected at C1).** Adds a per-platform code path (Windows/Linux still need `safeStorage` or a fallback), more complexity, and the win — visibility in Keychain Access — is marginal because most users won't open Keychain Access to inspect bot tokens. Sticking with `safeStorage` is consistent with `docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md`'s explicit `keytar` rejection (lines 58-65) and Linux `basic_text` handling (lines 65-66, 459).
- **Override `app.setPath("userData", ...)` globally (considered then rejected at C4).** Pulls in cookies, GPU shader cache, IndexedDB, etc., which we have no business owning. Targeted redirect of just our own protocol-capture path is enough.
- **Dual-write transition release (rejected during brainstorm).** Origin §Key Decisions: faster to ship the cutover with a `.bak` recovery path than to burn a release on dual-write.

## System-Wide Impact

### Interaction Graph

App startup (current) → `getDesktopSettingsService()` → reads `~/.config/pwragnt/config.toml` → `getDesktopOverlayStore()` opens `~/.local/state/pwragnt/overlay-state.json` → `getDesktopMessagingStore()` opens `~/.local/state/pwragnt/messaging-state.json` → `FileBackedSafeStorageSecretStore` opens `~/.local/state/pwragnt/settings-secrets.json` → renderer requests stream in.

App startup (after) → `resolvePwragntHome()` → `migrateIfNeeded()` (idempotent) → `StateDb.open(state.db)` → `getDesktopSettingsService()` reads `$PWRAGNT_HOME/config.toml` → `getDesktopOverlayStore()` proxies to `StateDb` → `getDesktopMessagingStore()` proxies to `StateDb` → `DbBackedSafeStorageSecretStore` proxies to `StateDb` → renderer requests stream in. **Renderer-facing API surface is unchanged.**

`DesktopMessagingRuntime` gains one new responsibility: scheduling `cleanupExpired()` on a 1h interval (origin R15).

### Error & Failure Propagation

- **Migration failure** is loudest. Surfaced as a startup-error dialog. App refuses to start. User can recover by inspecting `.bak` files and filing a bug. We do *not* fall back to "run anyway with empty state" — that would mask data loss as a UX glitch.
- **sqlite write failure** (disk full, permissions) propagates as an exception out of `StateDb` methods. Existing call sites already wrap their writes in `try/catch` for the JSON case (per `OverlayStore` and `MessagingStore` patterns); the catch handlers continue to work because the exception type is preserved at the boundary.
- **Lockfile collision** is also loud (startup error dialog with the explanatory message above).
- **Stale `WAL`/`SHM` sidecars after a hard crash** are sqlite-managed; first writer on next launch reconciles. We do not delete sidecars manually (codex notes this gotcha at `runtime.rs:266`).

### State Lifecycle Risks

- **Partial migration is the highest risk.** Mitigated by: tempfile-then-rename for `state.db`, verify-by-row-count, abort-deletes-tmp, no source files touched until all converters succeed.
- **Lockfile staleness** can leave a directory unusable after a hard kill. Mitigation: PID liveness check on lock acquire (`process.kill(pid, 0)` returns false if dead).
- **`.bak` file accumulation** is by design (origin R20). Mention in release notes.
- **WAL checkpoint frequency** — by default, sqlite checkpoints when WAL grows past 1000 pages (~4 MB). For our write rate, that's fine. We force a checkpoint at end-of-migration to ensure the file is consistent for the rename.

### API Surface Parity

- `OverlayStore` public API: unchanged.
- `MessagingStore` public API: unchanged.
- `DesktopSecretStore` interface: unchanged.
- IPC contracts to renderer: unchanged.
- `pwragnt config init` CLI (if it exists today): augmented to set `instance_id` on first run; otherwise unchanged.

### Integration Test Scenarios

These scenarios are not covered by unit tests with mocks and need real exercising:

1. **Real-data migration round-trip.** Run migration on a verbatim copy of the test author's `messaging-state.json` (4.3 MB) → verify each thread, binding, and config field is reachable in the UI after launch. Single most important integration test.
2. **Crash mid-migration.** Send SIGKILL during step 3 (DB build). Restart. Migration should re-run cleanly because no `.bak` exists yet.
3. **Crash post-rename, pre-bak.** Send SIGKILL between step 5 and step 8. Restart. Migration should detect that `state.db` exists with a populated `meta.schema_version` and treat as already-migrated; old files remain at the XDG paths until manual cleanup. (This is acceptable.)
4. **Two instances starting simultaneously.** Race two `pnpm start` invocations against the same `PWRAGNT_HOME`. The loser hits the lockfile and exits with the explanatory error.
5. **`PWRAGNT_HOME=~/.pwragnt-dev` cold start.** Empty directory, fresh install path. Sets up `meta.instance_id='default'`, runs cleanly.
6. **Telegram/Discord live messaging across the migration.** Receive a Telegram message immediately after a migration (~30s window between launch and incoming traffic). The new `MessagingStore` must handle it correctly with no stale references to the old file.

## Acceptance Criteria

### Functional Requirements

Direct mapping to origin Requirements (`R1`–`R23`):

- [ ] `~/.pwragnt/` is the default root; nothing else is created on a fresh install. (R1, R4, SC1)
- [ ] `PWRAGNT_HOME` env var override works; default applies when unset. (R2)
- [ ] `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`, `GROK_APP_SERVER_STATE_ROOT` are removed; the Playwright `HOME` override is removed. (R3)
- [ ] Layout matches §Architecture diagram. (R4)
- [ ] No code reads or writes `~/.config/pwragnt/`, `~/.local/state/pwragnt/`, `~/.cache/pwragnt/`, or `~/.config/grok-app-server/` after migration completes. (R5)
- [ ] Two `PWRAGNT_HOME`s coexist with isolated state and isolated secrets. (R6, R8, SC4)
- [ ] E2E suite uses `PWRAGNT_HOME` for isolation (no `HOME` override in `electron-app.ts`). (R7, R22)
- [ ] `instance_id` lives in `meta` table, defaults to `"default"`, set during migration. (R9)
- [ ] All secrets persisted via `DbBackedSafeStorageSecretStore` against the per-instance `state.db` (per C1; satisfies the spirit of R10–R12 — namespacing comes from the DB file path, not a Keychain service prefix).
- [ ] `state.db` schema v1 contains the ten tables in §Schema. (R13, R14)
- [ ] GC pass deletes expired rows in `browse_sessions`, `pending_intents`, `callback_handles`, `deliveries` (>30d), `bindings` (revoked >90d) on startup and hourly. (R15)
- [ ] `settings-secrets.json` is not read or written; old file renamed to `.bak.<ts>` after migration. (R16)
- [ ] `state.db` opened with WAL + `synchronous=NORMAL` + `busy_timeout=5000ms` + `auto_vacuum=INCREMENTAL`. (R17)
- [ ] Migration is idempotent and aborts cleanly on any decode error. (R18, R21)
- [ ] `pwragnt migrate-state --rerun --from <bak-path>` exists and works. (R19)
- [ ] `.bak` files are not auto-deleted. (R20)
- [ ] Documented dev-profile recipe in AGENTS.md. (R23)

### Non-Functional Requirements

- [ ] **Startup latency.** Migration on the test author's data set finishes in <2s; fresh-install path adds <50ms vs current launch.
- [ ] **Disk size.** `state.db` for the test author's data is <1MB after migration + GC. (SC5)
- [ ] **Crash safety.** SIGKILL at any point during migration leaves the system in a recoverable state (verified by integration test scenarios 2 and 3).

### Quality Gates

- [ ] `pnpm test` passes.
- [ ] `pnpm test:desktop-e2e` passes (single-worker; `workers: 1` retained per C5).
- [ ] `pnpm lint:boundaries` passes (package-boundary checker; per-package AGENTS.md).
- [ ] Manual smoke: launch with the test author's real data; verify threads, messaging, and settings UI are unchanged.
- [ ] Manual smoke: launch with `PWRAGNT_HOME=/tmp/pwragnt-fresh` (empty); verify clean install.
- [ ] Manual smoke: launch two instances at `~/.pwragnt/` and `~/.pwragnt-dev/` simultaneously, both connected to different Telegram bots; both work without crosstalk.

## Success Metrics

The seven origin success criteria, restated against deliverables in this plan:

1. **SC1.** Fresh install — covered by Phase 1+2 fresh-install path; integration scenario 5.
2. **SC2.** Existing user migration — covered by integration scenario 1 (real-data round-trip).
3. **SC3.** Two parallel E2E *invocations* (revised per C5) — covered by Phase 3 fixture changes.
4. **SC4.** Two parallel instances — manual smoke (Acceptance §Quality Gates).
5. **SC5.** `state.db` materially smaller — measurement in Phase 2 acceptance criterion.
6. **SC6.** Migration preserves all rows — verified-counts step 4 in migration; integration scenario 1.
7. **SC7.** No messaging regression — integration scenario 6.

## Dependencies & Prerequisites

- **`better-sqlite3`** native module added to `apps/desktop/package.json`. Verify it builds against the Electron version pinned in this repo before relying on it. Native-module rebuild already exists in the post-install path; the rebuild step picks up the new module automatically.
- **No backend changes.** Renderer is untouched. Codex/Grok external integrations untouched.
- **Macos / Linux / Windows.** All three need to work; Linux `basic_text` `safeStorage` fallback is preserved (refuses secret writes when unsafe, per `desktop-secret-store.ts:49-58`).

## Risk Analysis & Mitigation

Ranked by blast radius.

### R-1: Migration loses real user data (HIGH)

**Scenario:** Migration converter has a bug; rows are silently dropped or corrupted before old files are renamed.

**Mitigation:**
- Pre-flight parse step verifies all source JSON parses before writing anything to the new DB.
- Per-row decode errors abort the entire migration transaction.
- Verify-by-row-count step compares JSON entry counts to DB row counts post-INSERT.
- Old files are renamed to `.bak.<ts>` not deleted.
- Real-data integration test (scenario 1) runs against the test author's actual file before tomorrow's release.
- `pwragnt migrate-state --rerun --from <bak>` exists for recovery.

**Residual risk:** A converter bug that produces *valid-looking* but wrong rows (e.g. timestamp scaling, JSON-blob field mis-mapping) won't be caught by row-count verification. Mitigation: spot-check sampled records (origin SC6); pick at least one record from each of the ten tables and round-trip-validate it post-migration.

### R-2: sqlite native module fails to build for some user's platform (MEDIUM)

**Scenario:** `better-sqlite3` doesn't rebuild cleanly for the target Electron version on Windows or older macOS.

**Mitigation:**
- Verify build on all three target platforms before tomorrow.
- Have a fallback plan: if rebuild fails, the entire feature does not ship and we revert to the JSON path. Faster to revert than to ship a broken build.

### R-3: Lockfile false-positive blocks a legit launch (MEDIUM)

**Scenario:** Stale lock from a hard kill is mistakenly treated as live (PID re-used by a different process).

**Mitigation:**
- Lockfile records `hostname` in addition to PID. Hostname mismatch always treated as stale.
- On Unix: `process.kill(pid, 0)` returns false unless the PID is alive *and* we have permission to signal it. False positives are rare.
- Manual override: deleting `state/instance.lock` always works.

### R-4: WAL/SHM sidecar accumulation (LOW)

**Scenario:** Improperly-closed connections leave WAL files growing without checkpoint.

**Mitigation:**
- Force `wal_checkpoint(TRUNCATE)` on graceful shutdown.
- Periodic `incremental_vacuum` after GC.
- On open, sqlite reconciles automatically — no manual sidecar handling.

### R-5: GC removes "active" rows because of clock skew (LOW)

**Scenario:** System clock jumps backward; rows whose `expires_at` is just-past-now are deleted, then come back as "active" with expired timestamps.

**Mitigation:**
- Existing code already filters by `expires_at <= now` in reads (`messaging-store.ts:119-131,208-220,283-295`); GC just makes these reads cheaper. Behavior parity.

### R-6: agent-core/desktop boundary leak (LOW)

**Scenario:** Wiring sqlite into agent-core's `OverlayStore` creates an import cycle or a boundary violation.

**Mitigation:**
- `OverlayStorePort` interface stays in `packages/agent-core`; concrete sqlite implementation lives in `apps/desktop/src/main/state/`. Validated by `pnpm lint:boundaries`.

### R-7: Renderer assumes overlay-state.json semantics (LOW)

**Scenario:** Some renderer code reads via IPC but assumes file-level atomicity or staleness windows that change with sqlite.

**Mitigation:**
- IPC contract is identical (return the same shape per call). Per-write atomicity moves from "rename the whole file" to "single-row UPDATE in a transaction" — strictly better.

## Resource Requirements

- **Time:** ~10 hrs of focused work for the test author. Phase 2 dominates.
- **Team:** single engineer. No coordination required.
- **Infrastructure:** none new. CI runs the existing test scripts; `electron-rebuild` already runs in `pnpm install`.

## Future Considerations

- **Inline named profiles** (origin OUT) become possible later by adding a `profiles/{name}/` directory inside `$PWRAGNT_HOME`, where each profile has its own `state.db`. The current design does not preclude this.
- **Auto-cleanup of `.bak` files** (origin OUT) is a small follow-up: after N successful launches without a re-run, delete `.bak` older than 30 days.
- **Re-homing logs** (origin OUT) is trivial once we want it: redirect electron-log to `$PWRAGNT_HOME/logs/`.
- **Encryption of `state.db`** (origin OUT) via SQLCipher: real work, requires a different `better-sqlite3` distribution. Defer until there's a concrete threat-model demand.
- **Cross-instance `instance_id` collision detection across roots** (origin OUT) requires enumerating known roots. Could be implemented via a system-wide registry file at `~/Library/Application Support/PwrAgnt/roots.json` (macOS) or equivalent. Defer.
- **Workers > 1 for Playwright.** A separate stability project. The `PWRAGNT_HOME` isolation we ship here is the *prerequisite*, not the solution.

## Documentation Plan

- Root `AGENTS.md` "Runtime Config" section update.
- One-paragraph blurb in release notes.
- A new short doc at `docs/state-layout.md` enumerating the new layout, env var, and migration recipe. Keep under 100 lines.

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-02-config-and-state-relocation-requirements.md](../brainstorms/2026-05-02-config-and-state-relocation-requirements.md). Decisions carried forward: single `PWRAGNT_HOME` (origin §Path layout), instance-id namespacing (origin §Keychain — adapted per C1 to mean DB-file namespacing rather than Keychain service-name namespacing), sqlite-only state with one DB (origin §State storage), migrate-and-back-up via `.bak.<ts>` (origin §Migration). All scope-OUT items in the origin remain out of scope. The five plan-time corrections (C1–C5) are the only deviations from the origin and are explicitly justified above.

### Internal References

- [apps/desktop/src/main/settings/desktop-config.ts:57](../../apps/desktop/src/main/settings/desktop-config.ts) — current XDG config dir resolver (relocates).
- [apps/desktop/src/main/app-server/desktop-state-root.ts:12](../../apps/desktop/src/main/app-server/desktop-state-root.ts) — current XDG state dir resolver (relocates).
- [apps/desktop/src/main/app-server/scratch-projects.ts:16](../../apps/desktop/src/main/app-server/scratch-projects.ts) — `~/.pwragnt/projects/` literal (rewrites to `pwragntPath("projects")`).
- [packages/agent-core/src/config/grok-app-server-config.ts:29](../../packages/agent-core/src/config/grok-app-server-config.ts) — agent-core grok-app-server config dir (relocates per C3).
- [packages/agent-core/src/persistence/overlay-store.ts:526](../../packages/agent-core/src/persistence/overlay-store.ts) — atomic-rename idiom to mirror in migration's `state.db.tmp` step.
- [apps/desktop/src/main/messaging/core/messaging-store.ts:407](../../apps/desktop/src/main/messaging/core/messaging-store.ts) — same.
- [apps/desktop/src/main/messaging/core/messaging-store.ts:184-338](../../apps/desktop/src/main/messaging/core/messaging-store.ts) — existing GC methods (`cleanupExpiredPendingIntents`, `cleanupExpiredBrowseSessions`, `cleanupExpiredCallbackHandles`) that are never called today; the new GC scheduler invokes their sqlite equivalents.
- [apps/desktop/src/main/settings/desktop-secret-store.ts:30](../../apps/desktop/src/main/settings/desktop-secret-store.ts) — current `safeStorage`-encrypted secret file (replaced by DB-backed impl per C1).
- [apps/desktop/e2e/fixtures/electron-app.ts:49](../../apps/desktop/e2e/fixtures/electron-app.ts) — current `HOME`-override fixture (rewrites to `PWRAGNT_HOME`).
- [apps/desktop/playwright.config.ts](../../apps/desktop/playwright.config.ts) — `workers: 1` (preserved per C5).
- [apps/desktop/src/main/app-server/backend-registry.ts:938](../../apps/desktop/src/main/app-server/backend-registry.ts) — `app.getPath("userData")` for protocol captures (redirects per C4).
- Prior plans referenced for established conventions: [docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md](2026-04-30-003-feat-desktop-settings-config-plan.md), [docs/plans/2026-04-16-004-feat-grok-thread-storage-plan.md](2026-04-16-004-feat-grok-thread-storage-plan.md), [docs/plans/2026-05-02-001-refactor-messaging-live-thread-state-plan.md](2026-05-02-001-refactor-messaging-live-thread-state-plan.md).

### External References

- Codex sqlite reference: `~/github/codex/codex-rs/state/src/runtime.rs:168-194` — WAL + `synchronous=NORMAL` + `busy_timeout=5s` + `auto_vacuum=INCREMENTAL`. Copy these values verbatim.
- Codex migration framework: `~/github/codex/codex-rs/state/src/migrations.rs` — uses `sqlx`'s embedded migrator with `ignore_missing` for forward-compat. We use a simpler hand-rolled `user_version` migrator (~10 lines) since we only have one schema version on day one.
- `better-sqlite3` docs (verify Electron rebuild path before committing): https://github.com/WiseLibs/better-sqlite3 — referenced by name; framework-docs research deferred to implementation-time given the time pressure.

### Related Work

- Origin brainstorm: [docs/brainstorms/2026-05-02-config-and-state-relocation-requirements.md](../brainstorms/2026-05-02-config-and-state-relocation-requirements.md).
- Adjacent prior art: the desktop-settings-config plan ([docs/plans/2026-04-30-003-feat-desktop-settings-config-plan.md](2026-04-30-003-feat-desktop-settings-config-plan.md)) introduced the current `safeStorage` + file-backed pattern; this plan supersedes the file-backed half.
