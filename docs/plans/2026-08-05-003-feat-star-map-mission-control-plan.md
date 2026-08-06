---
title: "feat: Star Map mission-control surface"
type: feat
date: 2026-08-05
---

# Star Map mission-control surface

Requirements: [docs/brainstorms/2026-08-05-star-map-mission-control-requirements.md](../brainstorms/2026-08-05-star-map-mission-control-requirements.md)

## Summary

A full-window mission-control surface ("Star Map") showing the federation as a
star field: instance cards hub-and-spoke around the gateway with health-animated
links, compact attention-thread cards floating under each instance, a floating
ThreadView over the map, celestial per-instance identity icons, synced card
arrangements, and an AI intake dialog that creates threads from natural
language. The operator's thesis: get out of the monster thread list — this is
the antithesis of "every AI app has a left bar."

Four reviewable units / PRs, in dependency order:

1. **`feat(desktop): celestial instance icons and assignment protocol`** —
   standalone early unit; the Cmd+K-unification sibling branch consumes it.
2. **`feat(desktop): star map mission-control surface`** — entry button, star
   field, topology, instance cards, thread cards, floating thread window.
3. **`feat(desktop): star map arrangement sync`** — drag + overlay-store
   persistence + LWW federation sync.
4. **`feat(desktop): star map AI intake`** — intake dialog + headless intake
   agent + bubble-in animation.

## Codebase anchors (from exploration)

- Federation runtime singleton: `apps/desktop/src/main/federation/federation-runtime.ts`
  (`getDesktopFederationRuntime()`, `health()`, `connectedPeerTargets()`,
  `onPeerStatusChanged`, `remoteBackend(target)`, `localBackendOperations()`).
- Health shapes: `packages/shared/src/contracts/federation.ts`
  (`FederationHealthStatus`, `FederationPeerSummary`, `FederationConnectionState`);
  `publicPeerSummary()` in `federation-health.ts` sanitizes peers — **new peer
  fields must be added there or they get dropped**.
- Peer directory broadcast (`federation.peerDirectory`,
  `buildPeerDirectory`/`broadcastPeerDirectory`/`applyPeerDirectory`) is the
  snapshot-install sync precedent to mimic. There is **no existing LWW/versioning
  machinery** — arrangement sync introduces it.
- RPC recipe: `FEDERATION_BACKEND_METHODS` + capability map +
  `FederationBackendOperations` + `registerFederationBackendHandlers` +
  `FederationRemoteBackendClient` in `federation-backend-bridge.ts`, local impl
  in `localBackendOperations()`.
- `openFederationWindow`: IPC `federation:open-window`,
  `main/ipc/federation.ts:73`; renderer `desktopApi.openFederationWindow`.
- `startThread` federation routing already exists (`agent-ipc.ts:395`,
  `backend.startThread`, capability `turn_control`);
  `materializeDirectoryLaunchpad` is the path real UI uses (capability
  `environment_actions`).
- Renderer chrome: `.thread-header__chrome` in
  `features/thread-detail/ThreadHeader.tsx` (terminal-toggle button pattern at
  lines 189–218 incl. `-webkit-app-region: no-drag` carve-out),
  `ThreadPlaceholderHeader.tsx:97`, `features/chrome/AppTitleBar.tsx`
  `.app-titlebar__right` for Windows.
- Card primitives: `features/navigation/ThreadRow.tsx`, `ThreadMetaChips.tsx`
  (fragment; `linkedDirectoryMode="label"` already renders worktree/folder icon
  + project name with no "Local"/"Worktree" literal), `ThreadRowStatus.tsx`
  (`getThreadRowStatus`, `.thread-row__status-cookie`),
  `features/pr-status/PrChip.tsx`.
- Attention signals, snapshot-level (available for every thread incl. remote):
  `NavigationThreadSummary.inbox.reason === "updated-since-seen"` (unread),
  `threadStatus === "active"` (turn in progress), `prs` (open PR),
  `gitWorkingState.unpushedCommits > 0` (unpushed). Session-level extras
  (`approvalRequestThreadKeys`, `thinkingThreadKeys`, `inputRequestThreadKeys`)
  come from `lib/useThreadSessionState.ts` and exist only for live local
  sessions.
- Full-window surface precedent: `mainView` state in `App.tsx:243` +
  `app-shell__settings-layer` (`app.css:4963`, `position:absolute; inset:0;
  z-index:120`). The Star Map is an in-app layer, **not** a separate
  BrowserWindow — it needs the live navigation snapshot, session key maps, and
  ThreadView props that all live in the App tree.
- Icons: `src/renderer/src/icons/` pattern (`IconProps`,
  `resolveIconSvgProps`, `currentColor`); note the helper forces
  `fill="none"` — celestial icons need a filled-shape variant.
- Styling: single `styles/app.css`; tokens only (`scripts/lint-renderer-colors.mjs`
  allows literals solely in `:root` theme blocks; `color-mix` is the sanctioned
  derived-alpha pattern). Theme via `data-theme` attribute. Radius ≤ 8px.
  Theme-contract test: `styles/__tests__/theme-contract.test.tsx`. Axe gate:
  `apps/desktop/e2e/a11y.spec.ts` (empty `KNOWN_VIOLATIONS` baseline — keep it
  empty).
- Overlay store: `apps/desktop/src/main/state/overlay-store-sqlite.ts`
  (`SqliteOverlayStore`, `getDesktopOverlayStore()`), schema ladder in
  `state/state-db.ts` (`CURRENT_STATE_DB_USER_VERSION`, both the versioned
  migration **and** `ensureCurrentSchema`), `pnpm lint:sql` rules.
- Intake precedents: `XaiEphemeralObjectCaller.generateObject`
  (`app-server/ephemeral-object-call.ts`) for one-shot structured calls;
  `BackendRegistry.startAutomationHeadlessTurn` (`backend-registry.ts:~7170`)
  for headless tool-capable turns; `handoff_task`
  (`agent-tools/pwragent-thread-orchestration-agent-tools.ts`) as the
  create-a-thread-from-a-turn precedent; dynamic tool catalogs in
  `agent-tools/agent-tool-catalog-registry.ts` (additive-only contract per
  `agent-tools/CLAUDE.md`). `~/.pwragent/AGENTS.md` is read nowhere today.
- Messaging's `parseResumeCommandArgs` → `launchpadForMessagingProject` →
  `materializeDirectoryLaunchpad` flow (`messaging-resume-browser.ts`,
  `messaging-controller.ts`) is the closest full "NL-ish input → project →
  thread" template.

---

## Unit 1 — Celestial icons + assignment protocol

### Icon id contract (`packages/shared/src/contracts/celestial.ts`, new)

- `CELESTIAL_ICON_IDS = ["moon", "ringed-planet", "tilted-ringed-planet", "sun", "black-hole"] as const`
- `CelestialIconId`, `isCelestialIconId()`, `DEFAULT_CELESTIAL_ICON_ORDER`
  (assignment preference order: sun first for the gateway — the hub reads as
  the star — then moon, ringed-planet, tilted-ringed-planet, black-hole).
- `pickCelestialIcon(assigned: ReadonlyMap<string, CelestialIconId>, instanceId, isGateway)` —
  pure, deterministic: first unassigned id in order; when all five are taken,
  deterministic reuse by hashing instanceId (stable across recomputation).
  Exported so gateway and tests share one implementation.

### Icon components (`apps/desktop/src/renderer/src/icons/celestial/`, new)

- Five components: `CelestialMoonIcon`, `CelestialRingedPlanetIcon`,
  `CelestialTiltedRingedPlanetIcon`, `CelestialSunIcon`,
  `CelestialBlackHoleIcon`, plus a dispatcher
  `CelestialIcon({ icon: CelestialIconId, size?, ...svg })`.
- New helper `resolveFilledIconSvgProps` beside `resolveIconSvgProps`
  (`icons/icon-types.ts`): same `IconProps` surface, `viewBox="0 0 24 24"`,
  but **no** forced `fill="none"` — celestial bodies are filled shapes.
  Coloring rules:
  - Everything derives from `currentColor` with opacity layers
    (`fill="currentColor" opacity="0.x"`) — no literals, both themes free.
  - Crisp at 16px: silhouettes readable at 16 (moon = disc + 3 craters;
    ringed planet = disc + ellipse ring; tilted variant = steeper ring angle +
    smaller disc; sun = disc + 8 rays; black hole = dark disc + thin
    high-opacity ring crossing in front/behind — original drawing, shape only).
  - At 256px watermark scale the same geometry holds; opacity is applied by
    the consuming CSS (`.celestial-watermark { opacity: … }`), not baked in.
- Barrel exports from `icons/index.ts`; unit tests in `icons/__tests__/`
  asserting: render, `aria-hidden` default / `role="img"` with label, no
  `#hex`/`rgb(` literals in markup, unique silhouettes (path data non-equal).

### Assignment state + protocol

- **Storage (owning instance = gateway):** new state.db table
  `celestial_icon_assignments (instance_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  payload `{ icon: CelestialIconId, source: "auto" | "override", updatedAt }`.
  Schema-ladder bump + `ensureCurrentSchema` + `SqliteOverlayStore` accessors
  (`readCelestialIconAssignments`, `setCelestialIconAssignment`), prepared
  statements only (`pnpm lint:sql`).
- **Gateway coordinates:** on peer connect/disconnect/enrollment (same hooks
  that call `broadcastPeerDirectory`), the gateway ensures every known peer +
  itself has an assignment (`pickCelestialIcon`), persists, and broadcasts.
- **Broadcast:** new notification `federation.celestialIcons`
  (`{ method, params: { assignments: Array<{ instanceId, icon, source, updatedAt }> } }`),
  modeled on `applyPeerDirectory` snapshot-install: clients replace their
  cached map wholesale and re-publish. Clients persist the last snapshot in
  their own table so icons survive offline restarts.
- **Override RPC:** `backend.setCelestialIcon`
  (`{ instanceId, icon }` → updated assignment list), capability
  `thread_navigation` is wrong-shaped; use `federation_admin`-adjacent — no
  such capability exists, so gate on the existing `"peer_directory"`-visible
  path: overrides are sent **to the gateway** (`FEDERATION_BACKEND_METHODS`
  entry + `FEDERATION_BACKEND_METHOD_CAPABILITIES` mapping to
  `"thread_navigation"` as the least-wrong existing grant; note in code why).
  Dual-role instances apply locally when they are the gateway.
- **Non-federated / disconnected:** local instance always self-assigns
  (gateway-less fallback: local overlay row, `pickCelestialIcon` over the
  local-only map). Federation joining later reconciles: gateway wins, but an
  explicit local `source: "override"` row with newer `updatedAt` is re-sent to
  the gateway as an override request (LWW by `updatedAt`).
- **Renderer exposure:**
  - `FederationPeerSummary.celestialIcon?: CelestialIconId` — added in the
    contract **and** in `publicPeerSummary()`.
  - `FederationHealthStatus.localCelestialIcon?: CelestialIconId`.
  - New shared hook `lib/useCelestialIcons.ts`:
    `useCelestialIcons({ desktopApi })` → `{ iconFor(instanceId | undefined): CelestialIconId }`
    seeded from `readFederationHealth`, refreshed on
    `federation/peerStatus/changed` and a new `federation/celestialIcons/changed`
    agent event published when a snapshot installs.
- **Settings → Federation override UI:** in the existing per-peer rows
  (`FederationSettings.tsx:844` region) and the Configuration section for the
  local instance: a compact icon `<select>`/segmented control of the five
  icons; writes via new `desktopApi.setCelestialIcon`. Disabled with an
  explanatory tooltip when the gateway is unreachable.
- **Watermark primitive (shipped here, consumed by Unit 2 and the thread
  viewer):** `.celestial-watermark` CSS + a small
  `CelestialWatermark({ icon })` component rendering the 256px+ icon
  absolutely positioned behind content, `color: var(--text-muted)` at low
  opacity via `color-mix`/opacity, `pointer-events: none`, `aria-hidden`.
  ThreadView primary pane gets the thread's owning-instance watermark (local
  viewer → local icon) behind the transcript. Axe run must stay clean — the
  watermark sits behind text, so contrast is checked on the composited result;
  keep opacity ≤ 0.05 and verify against both themes in the a11y spec.

### Tests (Unit 1)

- `pickCelestialIcon` determinism/uniqueness/reuse; assignment reconciliation
  (gateway restart, late-joining peer, override-vs-auto LWW) in
  `federation-runtime.test.ts` style; sqlite accessor round-trip; icon
  component render tests; theme-contract additions for `.celestial-watermark`;
  a11y spec run.

---

## Unit 2 — Star Map surface

### Entry point

- `mainView` union gains `"star-map"`; render an
  `app-shell__star-map-layer` (absolute, inset 0, `z-index` above settings
  layer is unnecessary — same 120 tier, mutually exclusive views).
- Buttons:
  - `ThreadHeader.tsx` + `ThreadPlaceholderHeader.tsx`: new
    `starMap?: { open: boolean; onToggleStarMap(): void }` prop rendered in
    `.thread-header__chrome` **before** `<MessagingStatusBar>`, cloned from the
    terminal-toggle pattern (24×24, radius 6px, `aria-pressed`,
    viewport tooltip "Star Map", `-webkit-app-region: no-drag` carve-out).
    Icon: a small globe/orbit glyph added to `icons/` (`StarMapIcon`, stroke
    style, default helper).
  - `AppTitleBar.tsx` `.app-titlebar__right`: same button before
    `MessagingStatusBar` (Windows).
  - Hidden in federation remote windows (`readRendererFederationTarget()`
    non-null), matching MastheadActions' local-only gating — the map is a
    whole-federation surface owned by the primary window.
- Escape closes; view is **untracked** in navigation history (modal-ish
  chrome, same decision as Settings/Automations).

### Star field

- Pure CSS on the layer: two/three layered `radial-gradient` star dots +
  token-driven background (`--bg-app` base, stars from
  `color-mix(in srgb, var(--text-muted) X%, transparent)`), slight
  parallax-free twinkle animation gated behind
  `@media (prefers-reduced-motion: no-preference)`. No canvas, no literals.

### Topology & health

- New hook `lib/useFederationHealth.ts` (shared with Settings eventually, but
  Settings refactor is out of scope): seeds from
  `desktopApi.readFederationHealth({})`, resubscribes on
  `federation/peerStatus/changed` + `federation/celestialIcons/changed`,
  exposes `{ health, refresh }`.
- Layout: pure function `computeStarMapLayout({ localInstance, peers, viewport })`
  → positions. Gateway (or the local instance when non-federated) at center;
  peers on a ring, deterministic angle order (sort by instanceId so every
  instance renders the same shape before arrangement sync exists). Dual-role:
  when the local instance is `client`+gateway (`role === "dual"`), render its
  upstream gateway as a second hub with its sibling ring (data available from
  peer directory: peers whose role is `gateway`).
- Links: one SVG element spanning the layer; per-link `<line>`/`<path>`:
  - healthy (`status === "connected"`): solid `stroke: var(--accent-border)`
    plus a dash-offset "flow" animation using a second overlaid dashed path in
    `var(--accent)` (reduced-motion: static solid).
  - degraded/connecting: solid `var(--text-subtle)`, no flow.
  - disconnected/rejected/revoked: `stroke-dasharray` dashed
    `var(--border-strong)`.
- Instance card (`features/star-map/InstanceCard.tsx`): 48px `CelestialIcon`,
  label (peer `label` via `formatFederationPeerDisplayLabel`, local via
  health/instanceLabel), status dot reusing `.status-dot--{tone}`, two
  buttons: "Open" → `desktopApi.openFederationWindow({ target })` (local:
  `setMainView("thread")`), and `[+]` → intake dialog (Unit 4; Unit 2 ships it
  behind the same disabled-tooltip treatment until Unit 4 lands).

### Thread cards

- Data: local threads from the existing `useThreadNavigation` snapshot already
  in App. Remote threads via a new
  `desktopApi.getNavigationSnapshot({ federationTarget })`-shaped fetch per
  connected peer — this exists on the wire (`backend.getNavigationSnapshot`,
  capability `thread_navigation`); expose a renderer-facing hook
  `features/star-map/useStarMapThreads.ts` that fans out over
  `health.peers` (connected only), refreshes on backend events and a 60s tick,
  and tolerates per-peer failure (card cloud shows a muted "unreachable" note
  under dead instances).
- Attention selection (pure function `selectAttentionThreads(threads, filters)`
  in `features/star-map/attention.ts`):
  - `unread`: `inbox.reason === "updated-since-seen"`
  - `active`: `threadStatus === "active"` (+ local `thinkingThreadKeys`)
  - `approval`: local `approvalRequestThreadKeys` / `inputRequestThreadKeys`
    (session-level; remote threads surface it only if the snapshot carries it)
  - `pr`: `prs?.length > 0` with an open lifecycle state
  - `unpushed`: `gitWorkingState.unpushedCommits > 0` or `unpublished`
- Filter control: a compact chip row on the map (`.star-map__filters`,
  toggle chips per category, all-on by default), persisted in `localStorage`
  (arrangement sync does NOT carry filters; they're per-operator viewing
  preference).
- Card component (`features/star-map/StarMapThreadCard.tsx`): reuses
  `ThreadRowStatus` + `ThreadMetaChips` (with
  `includeLinkedDirectories linkedDirectoryMode="label"`) + `PrChip`s inside a
  compact card shell (`.star-map-card`, radius 8px, `--bg-panel-elevated`,
  title + one chip row; no actions cluster, no reactions). Cards float in the
  instance's "cloud" — default ring/grid positions under the instance from
  `computeStarMapLayout`, clamped to the cloud radius.
- Click → floating thread window.

### Floating thread window

- Selecting a card calls the existing thread-selection path
  (`navigation.selectThread`-equivalent used by search results — remote
  threads already select via federated refs in the local shell) and sets
  `starMapFloatingThread` state. While the star-map layer is up and a floating
  thread is set, render the App's existing `<ThreadViewComponent {...threadViewProps} />`
  into a `.star-map__thread-float` container: absolute, inset ~24px with the
  map's instance column pushed left (map content shifts via a CSS transform;
  the layer stays interactive on the exposed left strip), radius 8px,
  `--shadow-popover`, header drag-to-move within the viewport (pointer + rAF
  pattern from `startSidebarResize`), close button returns to full map.
- ThreadView renders unmodified — App's `threadDesktopApi` scoping already
  targets the selected thread's federation ref. (Memory note: ThreadView
  unmounts on search/threadDetailPending — don't cache state in it.)

### Tests (Unit 2)

- `computeStarMapLayout` + `selectAttentionThreads` unit tests (pure).
- Component tests: entry-button render/aria in ThreadHeader +
  ThreadPlaceholderHeader + AppTitleBar; instance card buttons call
  `openFederationWindow`; filter toggles; card renders chips w/o
  "Local"/"Worktree" literals.
- Theme-contract additions: star-map layer tokens, link colors, no-drag
  carve-out for the header button.
- Axe: new `test()` block in `a11y.spec.ts` opening the star map on the smoke
  fixture (single-instance path).
- E2E happy path: open map → single instance card → click a thread card →
  floating ThreadView appears → Escape → back to map.

---

## Unit 3 — Arrangement drag + federation sync

### Model

- Arrangement = per **map**, keyed by owning instance of each card:
  `{ entries: Record<instanceId, Record<threadIdentityKey, { dx, dy, updatedAt, by: instanceId }>>, updatedAt }`
  — offsets are relative to the card's default slot (survives layout changes
  and viewport differences across machines), clamped to the cloud radius at
  render.
- LWW at the **entry** level: merge keeps the `(threadKey)` record with the
  larger `updatedAt` (tie → lexicographic `by`). Deletion = entry with
  `dx/dy: null` tombstone so removals propagate; tombstones GC'd when the
  thread leaves all attention sets for 30 days.

### Persistence

- New state.db table `star_map_arrangement (entry_key TEXT PRIMARY KEY, payload TEXT NOT NULL)`
  (`entry_key = instanceId + " " + threadKey`), schema-ladder + ensure +
  `SqliteOverlayStore` accessors `readStarMapArrangement()`,
  `mergeStarMapArrangement(entries)` (transactional, returns changed rows).

### Sync protocol

- New notification `federation.starMapArrangement`
  `{ params: { entries: [...], full: boolean } }`:
  - On local drag-commit: instance merges locally, sends delta
    (`full: false`) to the gateway; gateway merges and re-broadcasts the delta
    to all other connections (relay semantics like backend events).
  - On connect/reconnect (both directions, same hook as
    `broadcastPeerDirectory`): each side sends its full snapshot
    (`full: true`); receiver merges (LWW) and, if its merge produced entries
    the sender lacked/lost, replies with its own full snapshot once. Merge is
    idempotent → converges; offline peers converge on reconnect.
- Notifications bypass capability checks — validate params shape and drop
  malformed input silently (log at debug), mirroring `applyPeerDirectory`
  guards.
- Renderer IPC: `starMap:read-arrangement`, `starMap:set-card-position`
  channels (+ preload + `DesktopApi`); main publishes agent event
  `starMap/arrangement/changed` on any merge so all windows re-render.

### Drag UX

- Pointer-capture drag on `.star-map-card` (rAF-coalesced transform writes,
  commit once on pointerup — the `startSidebarResize` pattern), clamped to
  the instance cloud radius; Escape cancels drag; cards are still
  click-to-open (drag threshold ~4px before it becomes a drag).

### Tests (Unit 3)

- Pure merge-function property tests (commutative, idempotent, convergent
  under reordering); sqlite merge transactional test; runtime test:
  two-instance harness (existing federation-runtime test style) converges
  after offline edit on both sides; drag component test (position commit +
  clamp); E2E: drag a card, reload fixture, position persists.

---

## Unit 4 — AI intake

### Flow

1. `[+]` on an instance card opens `features/star-map/IntakeDialog.tsx` — a
   portal `role="dialog"` (ImageLightbox pattern): prompt textarea
   ("Give me a task, the project, and any specifics…"), target-instance
   header (its celestial icon + label), status area streaming progress lines,
   Cancel/Submit.
2. Submit → `desktopApi.dispatchStarMapIntake({ federationTarget, request })`
   → IPC `intake:dispatch` → main. Remote targets route over a new RPC
   `backend.starMapIntake` (capability `environment_actions`, the
   materialize-launchpad grant), local runs directly — the intake **executes
   on the owning instance** so its directory registry, defaults, and
   `AGENTS.md` are the ones consulted.
3. Owning-instance implementation (`main/app-server/star-map-intake.ts`, new):
   - Read `~/.pwragent/AGENTS.md` (profile-scoped
     `resolveActiveProfileDir()/AGENTS.md` first, then root
     `~/.pwragent/AGENTS.md`; new small reader, no caching) — operator
     thread-startup preferences, injected as a preamble
     (`prependAutomationRuntimeContext` precedent).
   - Stage 1 (resolve): `XaiEphemeralObjectCaller.generateObject` with schema
     `{ title, directoryKey?, workMode?, branchName?, model?, notes?, confidence }`
     over a prompt containing the user request, the AGENTS.md preamble, and
     the directory registry (`NavigationSnapshot.directories` — label, path,
     kind, recent-activity) — the "dynamic tools" surface for resolution. If
     Grok is unavailable or confidence is low, fall back to a deterministic
     fuzzy match against directory labels; if still ambiguous, return a
     `needsDisambiguation` result listing candidates (dialog shows a
     `ProjectPicker`-style chooser).
   - Stage 2 (create): `materializeDirectoryLaunchpad` for registered
     directories (launchpad defaults + resolved overrides + first-turn input =
     the operator's request text verbatim), falling back to `startThread` for
     directory-less threads. Returns `{ backend, threadId, title }`.
   - Progress: `starMap/intake/status` agent events
     (`{ requestId, phase: "resolving" | "creating" | "done" | "failed" | "needs_disambiguation", … }`)
     — dialog subscribes; remote path forwards them over the existing backend
     event fan-out (`forwardLocalBackendEvent`).
4. On `done`, the dialog closes and the new thread's card **bubbles into the
   map**: `useStarMapThreads` refreshes (the new thread is `active` →
   attention set), and `.star-map-card--entering` plays a scale/opacity
   spring-ish keyframe (token colors only, reduced-motion: fade only). The
   card glows (`--accent` ring) until first selected.

### Why ephemeral-object + materialize (not a headless tool-agent)

`AgentToolMcpServer` tools are callable only from a live turn bound to a
thread; a free-floating intake agent would need either a headless thread whose
only job is to call a new `create_thread` tool, or a relaxation of the
binding. The two-stage resolve→create keeps the surface small, uses the same
structured-call machinery as title generation (proven offline-tolerant), and
still consults the same registry the dynamic-tools surface would. If a future
intake needs multi-turn tool use (screenshots, issue lookup), the
`startAutomationHeadlessTurn` + `handoff_task` path is the documented upgrade
route; a `list_projects` orchestration tool is deliberately **not** added now
(additive-only contract makes premature tools permanent).

### Tests (Unit 4)

- Intake resolver unit tests (schema fallback, fuzzy match, disambiguation);
  AGENTS.md reader (missing file, profile-scoped precedence); IPC/RPC routing
  test (remote executes on owner); dialog component tests (submit disabled
  empty, status phases, disambiguation chooser); E2E on the replay fixture
  with a stubbed object-caller: dialog → thread appears with entering
  animation class.

---

## Cross-cutting

- **Boundaries:** everything renderer-side imports only `@pwragent/shared`
  (icon ids + pure layout/merge/attention functions live in shared or
  renderer-local files; no agent-core imports). Federation/overlay access via
  IPC. `pnpm lint:boundaries` clean.
- **Conventions:** no Prettier; hand-format to house style (leading operators,
  double quotes, 2-space); `pnpm lint:eslint`, `lint:colors`, `lint:sql`,
  `typecheck` green per unit.
- **Config evolution:** icon overrides live in state.db (not config.toml), so
  no TOML shape change; if Settings later wants a config mirror, follow
  `docs/config-file-evolution.md`.
- **PR titles:** as listed in Summary (`feat(desktop): …`).

## Progress

- [x] Unit 1: celestial icons + assignment protocol
  - Implementation deviation: assignments persist as one JSON blob under
    state.db meta key `federation_celestial_icon_assignments` instead of a
    dedicated table — the map is tiny (one row per instance), always
    read/written as a unit, and the meta path avoids a schema-ladder bump
    that would conflict with concurrent branches. The arrangement sync
    (Unit 3) still gets its own table as planned.
  - The gateway also resolves icon collisions produced by LWW merges
    (offline self-assigns): overrides and older assignments keep their
    icon; newer auto entries are reassigned with a fresh updatedAt so the
    fix wins everywhere.
- [x] Unit 2: star map surface
  - Implementation deviations: (a) the floating thread window reuses the
    already-mounted `<main>` ThreadView by elevating it over the layer
    (`.app-main--star-map-float`) instead of mounting a second ThreadView —
    no duplicate IPC subscriptions, instant open, and re-clicking another
    local card retargets the same float; (b) clicking a REMOTE thread card
    opens the existing remote-viewer window with the thread preselected —
    inline remote selection lands with the Cmd+K-unification sibling
    (remote threads in the local snapshot), which this surface will adopt
    for free; (c) the [+] intake button ships with Unit 4 rather than as a
    disabled placeholder (no scaffold controls in shipped UI).
- [x] Unit 3: arrangement sync
  - Tombstone GC (30-day sweep) deferred: tombstones are one small row per
    reset card and the table is bounded by cards ever dragged; a sweep can
    ride a later cleanup pass if it ever matters.
- [x] Unit 4: AI intake
  - Implemented as designed (two-stage resolve → materialize, not a
    headless tool-agent). Additional decisions: disambiguation reuses the
    same requestId so the status stream stays continuous; a no-match
    result offers ALL registered directories as candidates rather than a
    directory-less thread (that flow arrives with launchpad-defaults
    support later); the intake RPC gets a 120s timeout because worktree
    preparation can exceed the 30s default.

## Open questions resolved during planning

- Separate BrowserWindow vs in-app layer → **in-app layer** (needs live
  navigation + session state + ThreadView props).
- Where assignments persist → **state.db** on every instance (gateway
  authoritative), not config.toml.
- Intake agent architecture → **two-stage structured call + materialize**, not
  a headless tool-agent (see Unit 4 rationale).
- Filters sync? → **No** — per-operator viewing preference, localStorage.
