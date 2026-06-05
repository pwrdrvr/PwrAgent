---
title: "feat: durable ACP capability cache (stop launching agents on every settings open)"
status: in-progress
date: 2026-06-05
type: feat
target_repo: PwrAgnt (this repo)
---

# feat: durable ACP capability cache

## Problem

Opening the ACP Agents settings pane spawned **real ACP agent processes**
(Gemini/Grok/Qwen/Kimi) — once per discovered agent — and React StrictMode
double-fired the mount effect in dev, so each agent launched twice. The
processes were short-lived (killed after the probe), but the burst happened on
every pane mount and every "Discover new" click, and it made model lists feel
slow because they waited on live probes.

Root cause: `AcpAgentsSettings.tsx` mount effect ran `refresh(false).then(refresh(true))`,
and `refresh(true)` → `listInstalledAndLocalAcpAgents(store, { refreshLocal: true })`
→ `refreshAcpRuntimeCapabilities` → `discoverAcpRuntimeCapabilities`, which
launches the agent over ACP to read its runtime capabilities (model lists,
modes). Nothing consulted the persisted result — it re-probed unconditionally.

## Key insight (from investigation)

The durable substrate **already exists**. `AcpAgentStore` persists every
`AcpInstalledAgentRecord` (including `runtimeCapabilities`, model lists, and a
`lastDiscoveredAt` timestamp) into the `acp_installed_agents` SQLite table's
JSON `payload`. The Composer/backend-registry model-list path already reads
those cached capabilities and never re-probes. The only gap was that the
settings refresh path re-probed every time and ignored `lastDiscoveredAt`.

So this is **gating + a freshness policy + a renderer read-path change — no
schema migration.**

## What shipped (this PR)

### Stage 1 — settings pane stops storming on mount
- `AcpAgentsSettings.tsx`: a `useRef` "did-initial-load" guard so the mount
  effect runs once despite StrictMode's dev double-invoke. Mount still renders
  cached agents instantly via `refresh(false)` (a pure cache read — no launches),
  then runs one gated `refresh(true)`.

### Stage 2 — freshness gate around the expensive probe
- New `acp/acp-capability-freshness.ts`: `shouldReprobeAcpCapabilities(cached,
  discoveredVersion, now, { force, maxAgeMs })`. Re-probe only when: forced, OR
  never probed (no cached capabilities/timestamp), OR the CLI version changed,
  OR the cached probe is older than `ACP_CAPABILITY_MAX_AGE_MS` (**48h**).
- `ipc/settings.ts` `listInstalledAndLocalAcpAgents`: cheap local discovery
  (execFile `--version`/`--help`) still runs every refresh to find newly
  installed agents and refresh version metadata, but the **expensive capability
  probe is now gated** by `shouldReprobeAcpCapabilities`. Fresh, version-matched
  agents reuse cached capabilities with no launch.
- New `force?: boolean` on `ListAcpAgentSettingsRequest` (shared contract). The
  "Discover new" button sets it so a user can always force a re-probe.

### In-flight coalescing (the "guard")
- `ipc/settings.ts`: concurrent ACP refreshes coalesce onto a single in-flight
  promise (`inFlightAcpRefresh`). Protects against StrictMode double-fire AND
  rapid double-clicks launching the same agents in parallel — the temporal
  freshness gate can't prevent a concurrent double-launch race, this does. Pure
  cache reads (`refresh: false`) are not coalesced; a forced refresh always runs
  its own pass so "Discover new" is never a no-op.

### Tests
- `acp-capability-freshness.test.ts`: 10 cases (fresh reuse, force, undiscovered,
  no-caps, no-timestamp, version-change, unknown-version, stale, boundary,
  custom maxAge).
- `settings-ipc.test.ts`: new integration test — first refresh probes an
  undiscovered agent once; a second refresh reuses cache (no new probe); a
  `force` refresh re-probes.

## Deferred (follow-up PRs)

### Stage 3 — background freshness sweeper
A main-process `AcpFreshnessScheduler` (modeled on `StateDb.startGc`'s
`setInterval().unref()`) that periodically re-probes stale agents **off the UI
thread** and updates the store, so capabilities stay fresh without the user
opening settings. Requires extracting `refreshAcpRuntimeCapabilities` from
`settings.ts` into a shared helper and wiring `start()/stop()` into app
lifecycle. Today, staleness is still healed whenever the settings pane is
opened (the gate re-probes agents older than 48h then), so this is an
enhancement, not a correctness fix.

### Stage 5 — per-instance model (Wave 2 / existing task)
Multiple instances of the same agent (e.g. two Grok installs at different
paths), each with its own capabilities + `lastDiscoveredAt`. Requires an
`instances` field on the record and a PK-strategy change on
`acp_installed_agents` (currently keyed by `backend_id`). Tracked with the
agent-kit Wave 2 ACP work.

## Defaults / knobs
- Freshness window: **48h** (`ACP_CAPABILITY_MAX_AGE_MS`).
- Settings-pane mount: probe only undiscovered/stale agents; reuse cache otherwise.
- "Discover new": always force a full re-probe.
