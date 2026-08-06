---
title: "feat: Federation agent-tool layer"
type: feat
date: 2026-08-05
---

# Federation agent-tool layer

Brainstorm: [2026-08-05-federation-agent-tools-requirements.md](../brainstorms/2026-08-05-federation-agent-tools-requirements.md)

## Summary

Give agents (in-thread agents, and the Star Map `[+]` intake sub-agent) eyes
and hands across federated instances: a new `federation` agent-tool catalog
with four tools — `list_federation_instances`, `list_instance_projects`,
`create_instance_thread`, `search_federation_threads` — plus operator-written
per-instance purpose notes (`[federation] instance_notes`) advertised through
the peer directory so every instance can describe every peer. All
cross-instance calls compose the *existing* capability-gated federation RPCs;
no new authorization surface.

## Product Contract

- An agent can enumerate the fleet: every instance's id, label, celestial
  icon (field carried now, assignment synced by the Star Map branch), purpose
  notes, connection status, capabilities, and whether it is the local
  instance. With federation disabled the same tool returns exactly one row
  (local), so agent flows do not fork on federation availability.
- An agent can list a chosen instance's projects/directories (with launchpad
  availability) and create a thread there — honoring launchpad settings
  (environment, model, execution mode) and an initial prompt — via the same
  routed paths the UI uses.
- An agent can search threads across all connected instances (plus local) in
  one call, optionally scoped to one instance.
- Operators describe each machine's purpose in Settings → Federation
  ("Studio Mac — PwrSnap dev + screen recording"); peers see the notes in
  their instance directories after the next handshake/gossip.
- Orchestration/intake agents are pointed (in tool descriptions) at
  `~/.pwragent/AGENTS.md` for the operator's thread-startup preferences.

## Authorization decision — no new capability

**Agent-originated cross-instance control does NOT get its own capability
analog to `messaging_route`.** Rationale, recorded per the capability
redesign in PR #1202's final round:

- Enrollment is the trust boundary (trusted-operator model). Stored
  capability lists are informational; per-peer narrowing is future RBAC and
  building a new allowlist now was explicitly ruled out.
- `messaging_route` exists because messaging is an *external input surface*
  (Telegram/Discord traffic) that can originate control without a local
  operator action, so it is separable at the call site. An in-thread agent,
  by contrast, already runs under the operator's chosen execution mode and
  approval policy on an enrolled instance; its federation reach is the same
  reach the operator's own UI has.
- The four tools only compose RPCs that are already per-method
  capability-gated in the router: `thread_navigation`
  (getNavigationSnapshot), `turn_control` (startThread),
  `environment_actions` (materializeDirectoryLaunchpad), `federated_search`
  (listThreads fan-out). A peer that revokes those capabilities is equally
  protected from agents and operators — which is the correct symmetry.

If future RBAC narrows per-peer grants, agent traffic inherits the narrowing
for free because it flows through the same router checks.

## Architecture

### Unit A — `instance_notes` config key (mirror `instance_label`)

Additive scalar key; `docs/config-file-evolution.md` legacy machinery is not
needed (it governs shape changes, not additions). Seven touch points, in
dependency order:

1. `packages/shared/src/contracts/settings.ts` —
   `DesktopFederationSettingsSnapshot.instanceNotes:
   DesktopSettingsValue<string>` (beside `instanceLabel`, ~line 549) and
   `DesktopSettingsConfigPatch.federation.instanceNotes?: string` (~line 957).
2. `apps/desktop/src/main/settings/desktop-config.ts` —
   `DesktopSettingsConfig.federation.instanceNotes?: string` (~line 145);
   reader `readString(federation?.instance_notes)` in
   `normalizeDesktopConfig` (~line 1678); writer branch in
   `desktopSettingsPatchToEdits` (~line 927): empty string ⇒ delete
   `["federation", "instance_notes"]`, else set — same convention as
   `instance_label`.
3. `apps/desktop/src/main/settings/desktop-settings-service.ts` — snapshot
   builder `instanceNotes: this.resolveConfigString(config.federation?.instanceNotes)`
   (~line 756).
4. `apps/desktop/src/renderer/src/features/settings/FederationSettings.tsx` —
   state + snapshot-resync + a "Purpose notes" `SettingsField` under
   "Instance name" (multiline-friendly input; sub copy explains it is shown
   to peers and read by agents when routing work), included in the save
   patch (~line 478).
5. Test fixtures that construct federation settings snapshots gain the new
   key: `desktop-config-federation.test.ts`, shared `settings.test.ts`,
   `FederationSettings.test.tsx`, `settings-screen.test.tsx`,
   `app-shell.test.tsx`, `federation-endpoint-credential-scoping.test.ts`.

### Unit B — advertise notes + icon through handshake and directory

Mirror the existing `label` / `profileName` plumbing. All optional fields —
older peers drop unknown keys harmlessly (JSON payload store; gossip rebuild
is wholesale).

1. `packages/shared/src/contracts/federation.ts` —
   `FederationPeerSummary.notes?: string; icon?: string`. `icon` is the
   **shared field the Star Map branch populates** (assignment/sync lives
   there; this layer carries and re-advertises whatever is set). Coordinate:
   field name `icon`, free-form string token.
2. `apps/desktop/src/main/federation/federation-transport.ts` —
   `FederationSocketAuthMessage.notes?: string; icon?: string` (beside
   `label`, ~line 185).
3. `apps/desktop/src/main/federation/federation-enrollment.ts` — carry
   notes/icon through `completeFederationEnrollment` (peer built ~line 216)
   and refresh on reconnect in `authenticateFederationReconnect`
   (~lines 325-326), same trim-or-keep pattern as `label`.
4. `apps/desktop/src/main/federation/federation-store.ts` —
   `FederationPeerPayload.notes?/icon?` (~line 69; JSON payload — no
   migration).
5. `apps/desktop/src/main/federation/federation-runtime.ts` — resolve
   `this.instanceNotes` from settings in `restartNow()` (beside
   `instanceLabel`, ~line 768); send in client auth (~line 1073); include in
   the local row of `buildPeerDirectory` (~line 1657); preserved through
   `applyPeerDirectory` since the directory rows are `FederationPeerSummary`.
6. `apps/desktop/src/main/federation/federation-health.ts` —
   `publicPeerSummary` copies `notes`/`icon` so `health()` (the renderer's
   and tools' read path) exposes them.

Icon *source* on the local instance: none in this branch. The field is
threaded (auth message, payload, summary, directory row) with the local value
left `undefined` until the Star Map branch lands its assignment store; that
branch then has a single line to set (`this.instanceIcon` in `restartNow()` /
directory row) rather than a parallel wire design.

### Unit C — the `federation` agent-tool catalog

Shared contract (`packages/shared/src/contracts/federation-tools.ts`, new;
exported from `packages/shared/src/index.ts`):

- `PWRAGENT_FEDERATION_OPERATION_NAMES = ["list_federation_instances",
  "list_instance_projects", "create_instance_thread",
  "search_federation_threads"] as const` + error codes
  (`invalid_arguments`, `not_found`, `federation_unavailable`,
  `peer_unavailable`, `capability_denied`, `forbidden`, `turn_start_failed`,
  `internal_error`).
- Args/result types:
  - `ListFederationInstancesToolArgs = {}` →
    `{ instances: FederationInstanceDescriptor[] }` where the descriptor is
    `{ instanceId, label, icon?, notes?, status, capabilities, isLocal,
    profileName?, role? }`.
  - `ListInstanceProjectsToolArgs = { instanceId }` →
    `{ instanceId, isLocal, projects: [{ key, label, kind, path?,
    hasLaunchpad, launchpadEnvironmentReady? }] }` (projection of
    `NavigationDirectorySummary` + `launchpad` presence).
  - `CreateInstanceThreadToolArgs = { instanceId, projectKey, input?,
    title?, model?, reasoningEffort?, executionMode?, fastMode?,
    launchpadOverrides? }` → `{ instanceId, backend, threadId, turnId?,
    threadUrl?, threadLink?, instanceLabel, turnStartFailure?,
    codexEnvironmentStartupFailure? }`.
  - `SearchFederationThreadsToolArgs = { query, instanceId?, limit? }` →
    `{ query, results: [{ instanceId, instanceLabel, isLocal, backend,
    threadId, title?, updatedAt?, status?, score }], failures: [{
    instanceId, message }], searchedInstances }`.
- `PwrAgentFederationRequest/Response` envelope + handler type, mirroring
  `thread-orchestration-tools.ts`.

Catalog id: add `"federation"` to `AGENT_TOOL_CATALOG_IDS`
(`packages/shared/src/contracts/agent-tools.ts:3`) and to the exact-list
assertion in `packages/shared/src/contracts/__tests__/agent-tools.test.ts`.

Desktop side (`apps/desktop/src/main/agent-tools/`):

- `pwragent-federation-agent-tools.ts` — definitions module: handler type,
  `buildPwrAgentFederationToolRouter`, `buildPwrAgentFederationToolDefinitions`,
  `descriptionForOperation`, `inputSchemaForOperation` (plain JSON Schema,
  `additionalProperties: false`), `normalizeArgsForOperation` with per-op
  trim/choice validators, `PWRAGENT_FEDERATION_UNAVAILABLE_MESSAGE`.
  Descriptions follow house style (defaults, when-to-prefer, what NOT to do,
  sibling-tool cross-references by bare name) and tell orchestration agents
  to consult `~/.pwragent/AGENTS.md` for the operator's thread-startup
  preferences before choosing settings.
- `pwragent-federation-codex-tools.ts` — thin Codex adapter mirroring
  `pwragent-thread-orchestration-codex-tools.ts` (no legacy namespace).
- `agent-tool-catalog-registry.ts` — `federationHandler?` param; new catalog
  entry with summary + fingerprint.
- MCP: nothing extra — the MCP server flattens catalogs automatically. The
  four names are globally unique (checked against every existing `pwragent`
  tool; note `search_threads` already exists, hence
  `search_federation_threads`).

### Unit D — handler service + wiring

`BackendRegistry` must not import `federation-runtime` (the runtime already
imports the registry — boundary would go circular). So the handler lives in
federation-land and is injected:

- New `apps/desktop/src/main/federation/federation-agent-tools-service.ts`:
  `createFederationAgentToolsHandler(...)` closing over
  `getDesktopFederationRuntime()` + `getDesktopBackendRegistry()`:
  - `list_federation_instances` — local row from `health()` (instanceId,
    settings label/notes, mode) marked `isLocal: true`, plus
    `health().peers` (already the reconciled `visiblePeers()` view with
    status + capabilities + notes/icon after Unit B).
  - `list_instance_projects` — local: registry `getNavigationSnapshot`;
    remote: `runtime.remoteNavigationSnapshot({ instanceId })`; project rows
    from `snapshot.directories` (`hasLaunchpad` = `launchpad` present).
  - `create_instance_thread` — resolve project by `directoryKey`; prefer
    `materializeDirectoryLaunchpad({ directoryKey, launchpad?, input?, agent? })`
    (local registry or `remoteBackend(target)` client), which honors
    launchpad environment/model/execution settings and starts the initial
    turn; map result to threadUrl/threadLink like `handoff_task` does.
  - `search_federation_threads` — remote fan-out via
    `runtime.searchConnectedPeers` (optionally filtered to `instanceId`);
    local results merged from the registry's thread search (same merge shape
    as `ipc/app-server.ts` `searchThreads`); local rows tagged
    `isLocal: true`.
- `BackendRegistry` gains `setPwrAgentFederationHandler(...)` (mirror
  `setPwrAgentAppManagementHandler`, `backend-registry.ts:7075`), passes the
  handler at both `resolveAgentToolCatalogs` call sites (~6745 MCP, ~9958
  Codex startThread), and adds a dynamic-tool dispatch branch beside the
  thread-orchestration one (~20612-20648) including the
  `isLiveDynamicToolCall` forbidden gate.
- `apps/desktop/src/main/index.ts` wires the handler at startup (beside the
  app-management handler wiring, ~line 895).

### Unit E — `~/.pwragent/AGENTS.md` convention doc

New `docs/agent-operator-preferences.md` (contributor-facing): what the file
is (operator-authored, per-machine, plain Markdown under the PwrAgent root —
honors `PWRAGENT_HOME`), what belongs in it (default projects, thread naming,
preferred models/execution modes, per-instance routing hints), which agents
read it (orchestration/intake — the federation catalog's tool descriptions
reference it), and what does NOT belong (secrets, per-repo instructions that
live in the repo's own AGENTS.md). Cross-link from `docs/federation.md`'s
doc list and mention in the tool descriptions ("consult ~/.pwragent/AGENTS.md
… if present").

## Testing

- `packages/shared/src/contracts/__tests__/agent-tools.test.ts` — catalog id
  list gains `federation`.
- New `packages/shared/src/contracts/__tests__/federation-tools.test.ts` —
  operation-name/error-code exact lists (mirror thread-orchestration test).
- New `apps/desktop/src/main/agent-tools/__tests__/pwragent-federation-agent-tools.test.ts`
  mirroring the four thread-orchestration test shapes: (1) schema/description
  snapshot under the `pwragent` namespace, (2) missing-handler envelope,
  (3) validation-before-dispatch (`expect(handler).not.toHaveBeenCalled()`),
  (4) happy-path normalization (trimmed args, full request envelope).
- `apps/desktop/src/main/__tests__/desktop-config-federation.test.ts` —
  `instance_notes` read/round-trip/delete-on-empty.
- Federation handshake tests (wherever label refresh is covered —
  enrollment/reconnect specs) extended for notes/icon passthrough.
- Handler service unit test with stubbed runtime/registry: instance list
  merge (local + peers, non-federated single row), remote-vs-local project
  routing, search merge + instanceId filter.

## Sequencing / coordination

Land order: A → B → C → D → E (each a reviewable commit; C and D may merge
as one PR with separate commits). The Star Map `[+]` intake unit consumes
these tools — coordinate so it does not invent its own; the shared icon
field name is `icon` on `FederationPeerSummary`. Cmd+K unification is
independent but can adopt `search_federation_threads`.

## Follow-up round (same branch, post-review)

Decided with the operator after the first review pass:

- `search_federation_threads` gains `scope?: all | local | remote` — the
  "remote only" intent ("I know it's not on this machine") was not
  expressible in one call. scope and `instanceId` intersect.
- `FederationPeerSummary.host` block: platform, osVersion, hostname, arch,
  cpuCount, memoryBytes, diskFreeBytes (snapshot, not live), and
  `machineId` — minted once at `<pwragent root>/machine-id` and shared by
  every profile on the machine, so agents can tell that "work" and
  "default" on one box compete for the same CPUs/RAM instead of summing
  their capacity. Advertised like notes/icon (auth handshake, reconnect
  replace-wholesale/absent-keeps, store payload, gossip, health).
- `list_federation_instances` pages at 25 rows (limit 1-100) with
  single-use ~60s continuation tokens, plus a `query` substring filter
  over label/notes/profile/id/host facts — so a 75-instance fleet nudges
  the agent toward filtering instead of eating tokens.
- Live load signals (CPU load average, available RAM, free disk deltas)
  are deliberately NOT in this round: they are a query-on-demand concern
  (Star Map indicators + an opt-in flag on the instance list), not a
  handshake field. Tracked as a spun-off task card; the `host` block is
  shaped so a `load` sibling can join later.

## Progress

- [x] Brainstorm doc
- [x] Plan doc
- [x] Unit A — `instance_notes` config + settings UI
- [x] Unit B — handshake/directory advertisement (notes + icon)
- [x] Unit C — shared contract + federation catalog + dual-variant tools
- [x] Unit D — handler service + BackendRegistry/index wiring
- [x] Unit E — operator preferences convention doc
- [ ] Tests green (lint:eslint, typecheck, lint:boundaries, focused vitest)
