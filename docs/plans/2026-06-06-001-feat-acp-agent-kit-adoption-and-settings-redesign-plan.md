---
title: "feat: adopt @pwrdrvr/agent-acp + agent-client; redesign ACP agent settings (Wave 2)"
status: draft
date: 2026-06-06
type: feat
target_repo: PwrAgnt (this repo)
parent_plan: docs/plans/2026-06-02-002-feat-consume-agent-kit-plan.md  (U5 + U6)
reference_impl: PwrSnap worktree intelligent-lalande-3a14bf (read-only reference)
---

# feat: adopt agent-acp + agent-client; redesign ACP agent settings (Wave 2)

This plan executes **U5 (agent-client) + U6 (agent-acp)** from the Wave-1 plan,
plus the ACP Settings redesign tracked in issue #646. It is grounded in two
investigations: PwrSnap's shipped implementation (the visual + architectural
**target**) and PwrAgnt's current in-tree ACP stack (what gets replaced).

> **Version note.** PwrSnap's `package.json` pins `@pwrdrvr/agent-acp@^0.9.2`,
> `@pwrdrvr/agent-client@^0.6.0`, `@pwrdrvr/agent-core@^0.1.3`, but that
> worktree's `node_modules` actually has **0.1.0** of all three installed
> (stale). The architecture below is verified against the source + the 0.1.0
> dist; **exact symbol names and signatures must be re-confirmed against the
> pinned target versions** when the deps are added to PwrAgnt. Known delta:
> multi-install `discoverLocalAcpAgentInstances` is a 0.9.2 addition — 0.1.0
> only exports single-install `discoverLocalAcpAgents`.

---

## The kit architecture we consume

- **`@pwrdrvr/agent-core`** — the neutral schema. `interface AgentBackend`
  (the non-generic backend both Codex and ACP implement); the `Normalized*`
  family (`NormalizedThreadView`, `NormalizedMessage`, `NormalizedThreadEntry`,
  `NormalizedApprovalRequest`, `NormalizedTokenUsage`, `TurnId`, …);
  `ThreadStore` (persistence seam); `Logger` / `OpenExternal`.
- **`@pwrdrvr/agent-acp`** — `AcpAgentClient implements AgentBackend`;
  `AcpSessionNormalizer` (**the extracted version of PwrAgnt's
  `acp-session-normalizer.ts`**); `AcpStdioJsonRpcTransport`; the per-agent
  discovery strategies (`geminiStrategy`/`grokStrategy`/`kimiStrategy`/
  `qwenStrategy`, `strategyByBackendId`, `BUILT_IN_ACP_STRATEGIES`);
  `discoverLocalAcpAgents` (0.1.0) / `discoverLocalAcpAgentInstances` (0.9.2,
  multi-install); `AcpRegistryService`; `normalizeAcpRuntimeCapabilities`.
- **`@pwrdrvr/agent-client`** — `ChatThreadController` (drives any
  `AgentBackend`); `CodexThreadClient implements AgentBackend`;
  `CodexOneShotClient`; `ChatControllerEvent` / `ChatThreadControllerDeps`;
  `buildToolCatalog` / `defineTool` / `dispatchToolCall`.

**Implication:** the end-state holds an `AgentBackend` per thread (Codex or
ACP) driven by one `ChatThreadController`. The 40+ `isAcpBackendId` branches in
`backend-registry.ts` collapse because the polymorphism moves into the kit.
Because the controller drives *both* backends, the ACP swap (U6) is coupled to
adopting agent-client for Codex too (U5).

---

## Current state (what gets replaced) — condensed

| In-tree file | LOC | Fate |
|---|---|---|
| `acp/acp-session-normalizer.ts` | 769 | **Replace** with kit `AcpSessionNormalizer` (KTD-P3) |
| `acp/acp-client.ts` (turn state machine, `pending:` turnIds) | 1,333 | **Replace** with `AcpAgentClient` + `ChatThreadController` |
| `acp/acp-local-discovery.ts` (single-install, hand-rolled probes) | 395 | **Replace** with kit discovery strategies (multi-install) |
| `acp/acp-stdio-transport.ts` | ~100 | Mostly gone (kit `AcpStdioJsonRpcTransport`); already on agent-transport (#639) |
| `app-server/backend-registry.ts` (40+ `isAcpBackendId`) | 10,462 | **Rewire** onto `AgentBackend`; collapse branches |
| `app-server/acp-backend-adapter.ts` (callbacks) | 1,365 | **Rewire** onto `ChatControllerEvent` |
| `acp/acp-agent-store.ts` + `acp_installed_agents` table | 111 | **Redesign** single→multi-install + preferences |
| `acp/acp-runtime-discovery.ts` + `acp-capability-freshness.ts` (#643) | ~120 | Re-evaluate vs kit model listing + `acp-model-cache` |
| `renderer/.../settings/AcpAgentsSettings.tsx` | 360 | **Rebuild** to PwrSnap multi-install card |

PwrAgnt does **not** yet depend on `@pwrdrvr/agent-client` or
`@pwrdrvr/agent-core` (npm) — only the workspace `@pwragent/agent-core`. Codex
chat currently runs on PwrAgnt's own `codex-app-server/client.ts`, not the
kit's `CodexThreadClient`.

---

## Phase A — settings redesign + adopt the kit's discovery (≈1 week, moderate risk)

**Isolatable from the turn lifecycle.** Adopt only the kit's *discovery*; the
existing in-tree `acp-client`/normalizer keep driving chat. The resolved
install just feeds the existing launch descriptor.

### A1. Dependencies
- Add `@pwrdrvr/agent-acp`, `@pwrdrvr/agent-core` (npm) at the pinned target
  versions. (agent-client deferred to Phase B.)

### A2. Discovery swap
- Replace `discoverLocalAcpAgents` (in-tree) with the kit's discovery
  (`discoverLocalAcpAgentInstances` if on a version that has it; else the
  single-install `discoverLocalAcpAgents` + a thin multi-probe wrapper).
- Delete the per-agent `discoverLocalGemini/Kimi/Grok/Qwen` + candidate-path
  code — the kit's strategies own this. **This subsumes #641/#645** (kimi path
  + exit-code) since the kit strategy handles kimi.
- Bridge the kit's instance shape → the existing `acp-client` launch
  descriptor (command/args/env) so chat still launches.

### A3. Instance resolver (borrow PwrSnap wholesale)
- New `acp/acp-instance-resolver.ts` — pure function, precedence
  **override → selectedPath → first found**. Mirror PwrSnap's
  `ai/acp-instance-resolver.ts`. Used by BOTH the settings handler and the
  chat-launch path (single source of truth).

### A4. Settings model + persistence
- New shared contracts (mirror PwrSnap, in `packages/shared`): per-agent
  `AcpAgentDiscoveryEntry { id, displayName, installed, version, instances:
  AcpAgentInstance[], activeCommand }`; `AcpAgentInstance { command, version?,
  source }`; `AcpAgentPreference { overridePath?, selectedPath? }`;
  `AcpSettings { enabledAgentIds, agents }`.
- Persist **user preferences** (enabled set, selectedPath, overridePath) in the
  **settings substrate** (`ai.acp.*` analog) — matches the PwrAgnt settings
  rules; these are user choices, not discovered facts.
- **Keep the durable `acp_installed_agents` store + #643 freshness gate**
  (Decision 1): discovered facts (installs, versions, model lists) stay cached,
  polled rarely (48h gate), refreshed only intentionally via the "Refresh"
  button. Phase A **extends** the store to the multi-install shape (multiple
  instances per agent) rather than retiring it. The expensive model/capability
  probe stays gated exactly as #643 designed.

### A5. Settings UI rebuild
- Rebuild `AcpAgentsSettings.tsx` to the PwrSnap card shape:
  `AcpAgentsCard` → per-agent `AcpAgentRow` ("N installs found · active vX · auto|pinned",
  Enabled badge + Enable toggle, per-install rows with "Using" badge,
  `AcpOverrideInput` manual path + Save/Clear), Refresh.
- IPC: extend `ACP_AGENTS_LIST_CHANNEL` to the new entry shape; add verbs for
  enable/disable + pick-install + set-override (or fold into settings patches,
  PwrSnap-style).

### A6. Tests
- Instance-resolver unit tests (precedence + fallbacks).
- Discovery adapter tests (kit instances → entries; multi-install; degraded).
- Settings-IPC integration (enable/disable, pick "Using", override persists).
- Renderer tests for the multi-install card.

**Phase A ships:** the PwrSnap-style screen, multi-install + manual path +
"Using" selection, and a robust kimi fix via the kit — with **zero** change to
the turn lifecycle.

---

## Phase B — controller + normalizer migration (U5+U6, ≈2–3 weeks, CRITICAL risk)

Gated on **KTD-P3** (prove the kit normalizer reproduces PwrAgnt's replay
losslessly). This is the crown jewel.

### B1. The neutral-schema bridge (the KTD-P3 proof — do this FIRST, before deleting anything)
- Build a **lossless-replay harness**: take PwrAgnt's recorded ACP
  `session/update` transcripts, run them through the kit's `AcpSessionNormalizer`
  → `NormalizedThreadView`, and assert the rendered transcript matches what
  PwrAgnt's in-tree `acp-session-normalizer.ts` → `AppServerThreadReplay`
  produces today (via a `NormalizedThreadView → AppServerThreadReplay` adapter,
  or by re-rendering both to the same renderer view-model).
- This both **proves** the swap is lossless and produces the adapter we need.
  Since the kit normalizer was *extracted from* PwrAgnt's, divergence = drift
  introduced since extraction; catalog and reconcile each diff.

### B2. Adopt `AgentBackend` for ACP
- Replace in-tree `acp-client.ts` turn machinery with `AcpAgentClient`
  (agent-acp) + the kit normalizer. Feed it from Phase A's resolved instance.

### B3. Adopt `ChatThreadController` (couples U5)
- Stand up `ChatThreadController` (agent-client) to drive `AgentBackend`s.
  Codex moves to `CodexThreadClient` (or an adapter wrapping PwrAgnt's existing
  Codex client behind `AgentBackend`) so one controller path serves both.
- Map `ChatControllerEvent` → PwrAgnt's renderer event channels (thin adapter,
  like PwrSnap's `chat-event-adapter`).
- Implement PwrAgnt persistence behind the kit `ThreadStore` seam.

### B4. Collapse the `backend-registry` branches
- Replace the 40+ `isAcpBackendId` sites with `AgentBackend` polymorphism.
  Extract Codex-specific orchestration (environment setup, workspace handoff)
  into a Codex `AgentBackend` impl rather than inline branches.

### B5. Approval + runtime options
- Map ACP `session/request_permission` onto the kit's
  `NormalizedApprovalRequest`/`AgentBackendApprovalHandler`. Reconcile runtime
  config options (model/mode) onto the kit's capability model.

### B6. Verification
- The B1 harness as a CI gate. Replay all four agents (Gemini/Grok/Kimi/Qwen)
  + Codex; assert no transcript/usage/approval regressions, parity of the
  `isAcpBackendId`-removed paths.

---

## Risks & mitigations

- **KTD-P3 lossless replay (CRITICAL).** PwrAgnt is the hardest consumer of its
  own extracted normalizer; in-tree drift since extraction is the core risk.
  *Mitigation:* B1 harness first, before any deletion; reconcile every diff.
- **`backend-registry` branch removal (CRITICAL).** 40+ sites across a 10k-line
  file. *Mitigation:* extract `AgentBackend` for Codex in parallel; land the
  abstraction before deleting branches; keep PRs reviewable by area.
- **U5/U6 coupling.** ChatThreadController drives both backends, so the Codex
  client migration rides along. *Mitigation:* optionally wrap PwrAgnt's
  existing Codex client behind `AgentBackend` to defer a full `CodexThreadClient`
  swap.
- **Store schema change.** single→multi install + preferences. *Mitigation:*
  move preferences to settings (no SQLite migration); retire
  `acp_installed_agents` deliberately with a documented migration.
- **#643 cache fate.** Don't run two caches. *Mitigation:* converge on a
  persisted *model* cache (kit-style) + on-demand discovery.
- **Version confirmation.** Target-version API differs from the 0.1.0 dist read
  here. *Mitigation:* add deps + typecheck against pinned versions before
  committing to exact symbols.

## Sequencing & sizing

- **Phase A:** ~1 week, moderate risk, standalone PR. Ships the visible value.
- **Phase B:** ~2–3 weeks, critical risk; B1 (the proof harness) is the
  go/no-go gate and should be its own PR before B2–B6.
- Total aligns with the ~3–4 week estimate from the current-state investigation.

## Borrow-from-PwrSnap map (reference only — do not import)

- **Wholesale shape:** `AIProvidersPage.tsx` ACP components
  (`AcpAgentsCard`/`AcpAgentRow`/`AcpOverrideInput`); `acp-instance-resolver.ts`
  (pure); `acp-handlers.ts` discovery+model-listing logic; `acp-model-cache.ts`.
- **Reference, don't copy (app-specific):** `chat-event-adapter.ts`,
  `acp-approval-policy.ts`, `chat-controller-factory.ts` — adapt to PwrAgnt's
  chat layer + tool catalog.

## Decisions (resolved 2026-06-06)

1. **KEEP the durable cache, don't retire it.** Goal is to *poll the ACP
   versions/models less*, retain discovered info, and refresh **intentionally**
   (e.g. re-pull the model list after changing your plan with a provider).
   That is exactly #643's design — durable `acp_installed_agents` + the 48h
   freshness gate + the force "Refresh" button. Phase A **retains** the store
   and the gate; it only **extends** them to the multi-install shape and keeps
   the intentional Refresh. (Earlier "retire / converge to PwrSnap's
   poll-every-open" suggestion is rejected — wrong direction.)
2. **Phase B Codex path — DEFERRED.** Decide before Phase B starts. *Action:*
   write up the two options in detail then so the choice is informed:
   - **Option B-full (true U5):** swap PwrAgnt's `codex-app-server/client.ts`
     for the kit's `CodexThreadClient` (also an `AgentBackend`). One controller,
     one client family, deletes the most code — but migrates the *Codex* chat
     path too (bigger blast radius, more to verify).
   - **Option B-wrap (defer U5):** keep PwrAgnt's existing Codex client, wrap it
     behind an `AgentBackend` adapter so `ChatThreadController` can drive it.
     Smaller blast radius (Codex path largely unchanged), at the cost of an
     extra adapter and not yet realizing the full U5 simplification.
   Present a head-to-head (blast radius, LOC delta, risk, what each leaves for
   later) at Phase B kickoff.
3. **Pin latest published: agent-acp `^0.9.2`, agent-client `^0.6.0`,
   agent-core `^0.1.3`** (these *are* the latest; PwrSnap is current, only its
   worktree install was stale). agent-kit can be re-published quickly if a gap
   shows up during integration.
