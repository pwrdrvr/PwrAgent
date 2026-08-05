# Federation Agent-Tool Layer — Requirements

Date: 2026-08-05
Status: brainstorm feeding `docs/plans/2026-08-05-003-feat-federation-agent-tools-plan.md`

## Problem

Two mission-control surfaces are being built in sibling sessions — the Star
Map (whose `[+]` intake dispatches a sub-agent that must "find the project the
user was talking about and create a new thread with the specified settings" on
a chosen instance) and Cmd+K unification. Both assume an agent can *see* and
*reach* other federated PwrAgent instances.

Today the agent-tools layer (`apps/desktop/src/main/agent-tools/`) has zero
federation references. The operator-facing UI already routes `startThread`,
`materializeDirectoryLaunchpad`, navigation snapshots, and search across
federation (`isRemoteFederationTarget` branches in `ipc/agent-ipc.ts` /
`ipc/app-server.ts`), but none of that reach is exposed to agents. An
in-thread agent or intake sub-agent cannot enumerate instances, browse a
remote instance's projects, create a thread on another machine, or find "the
PwrSnap thread about X" wherever it lives.

## Desired outcome

"I want to do this thing" mode can route work to the right machine: an agent
consults the instance directory (labels + operator-written purpose notes +
celestial icon), picks a target, browses its projects, and creates a properly
configured thread there — all through the existing capability-gated federation
RPCs, with no new authorization surface.

## Requirements

### 1. Instance purpose metadata

- New `[federation] instance_notes` TOML key beside `instance_label`: a short
  operator-written description of what the machine is for ("Studio Mac —
  PwrSnap dev + screen recording", "rack mini — long-running agents").
- Wired end-to-end exactly like `instance_label`: shared settings contract
  (snapshot + patch), desktop-config TOML read/write, settings snapshot
  resolution, Settings → Federation field.
- Additive scalar key — older clients ignore it; no legacy-shape machinery
  from `docs/config-file-evolution.md` is required (that doc governs shape
  *changes*, not additions).
- Advertised to peers: auth/reconnect handshake, peer store payload, peer
  directory gossip, health snapshot. Every instance can describe every peer.
- A shared optional `icon` field rides the same wire surfaces. Icon
  *assignment/sync* is being built on the Star Map branch — this layer only
  carries the field so both branches converge on one name instead of two.

### 2. Agent tools (core deliverable)

A new `federation` agent-tool catalog in the unified `pwragent` namespace,
following the `pwragent-thread-orchestration-*` dual-variant pattern
(definitions module + thin Codex dynamic-tool adapter), advertised through
both Codex dynamic tools and the loopback MCP server:

- `list_federation_instances` — id, display label, celestial icon, purpose
  notes, connection status, capabilities, local-vs-remote. Must work
  non-federated: returns just the local instance so tool-calling code paths
  don't fork on federation availability.
- `list_instance_projects` (instanceId) — directories/projects available on
  that instance, served from the already-federation-routed navigation
  snapshot (`remoteNavigationSnapshot` → `directories`), including launchpad
  availability so agents know which projects support configured environments.
- `create_instance_thread` (instanceId, project, settings, initial input) —
  creates a thread on the target instance through the federation-routed
  `materializeDirectoryLaunchpad` / `startThread` paths, honoring launchpad
  settings (environment, model, execution mode) when specified.
- `search_federation_threads` (query, instanceId?) — thread search across the
  fleet using the existing `searchConnectedPeers` fan-out, merged with local
  results, so an agent can find a thread wherever it lives.
- Read-status tool: **deferred.** `search_federation_threads` results carry
  enough thread state for intake routing; remote `readThread` is already
  federation-routed if a later need appears. Keeping v1 to four tools keeps
  the catalog reviewable.

### 3. Authorization

- Everything routes through the existing capability-gated federation RPCs.
  Per PR #1202's redesign, enrollment is the trust boundary
  (trusted-operator model); stored capability lists are informational, and
  per-peer narrowing is future RBAC.
- **Decision needed in plan:** does agent-originated cross-instance control
  need its own capability analog to `messaging_route`? (Leaning no — see
  plan for rationale; `messaging_route` exists because messaging is an
  external input surface, whereas in-thread agents already run under the
  operator's execution-mode approvals on an enrolled instance.)
- No new allowlists, no per-tool peer filtering.

### 4. Operator preferences convention

- Document `~/.pwragent/AGENTS.md`: orchestration/intake agents read it for
  the operator's thread-startup preferences (default projects, naming,
  settings). Contributor-facing doc under `docs/`; the tool descriptions
  tell agents to consult the file so the convention is discoverable at the
  point of use.

## Constraints

- Dependency boundaries: `BackendRegistry` must not import
  `federation-runtime` (the runtime already imports the registry). The
  federation tool handler therefore gets injected from `main/index.ts`
  wiring, mirroring the `setPwrAgentAppManagementHandler` pattern.
- MCP tool names are globally unique across catalogs
  (`agent-tool-mcp-server.ts` throws on duplicates) — the four names above
  do not collide with existing tools (`search_threads` ≠
  `search_federation_threads`).
- Agent-tool contract rules (`agent-tools/AGENTS.md`): additive-only schema
  evolution; new threads get the unified `pwragent` namespace.
- Repo style: ESLint only, hand-formatted, leading binary operators.

## Non-goals

- Star Map UI, icon assignment/sync UX (sibling branch).
- Cmd+K unification (independent; benefits from `search_federation_threads`).
- Per-peer capability narrowing / RBAC.
- Remote thread transcript reading, remote PTY, or any new federation RPC —
  the tool layer only composes RPCs that already exist.
- Cross-instance `~/.pwragent/AGENTS.md` sync; the convention is per-machine.
