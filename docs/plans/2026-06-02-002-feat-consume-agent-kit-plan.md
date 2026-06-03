---
title: "feat: migrate PwrAgnt onto @pwrdrvr/agent-kit packages"
status: active
date: 2026-06-02
type: feat
target_repo: PwrAgnt (this repo)
parent_plan: agent-kit repo, docs/plans/2026-06-02-001-feat-agent-kit-monorepo-buildout-plan.md
---

# feat: migrate PwrAgnt onto @pwrdrvr/agent-kit packages

**Target repo:** PwrAgnt (this repo). All paths are PwrAgnt repo-relative. The packages being consumed
live in the separate `agent-kit` repo (`@pwrdrvr/*` on npm).

PwrAgnt is the **origin** of most of the extracted code, so this migration is subtler than PwrSnap's:
PwrAgnt is simultaneously where the substrate came from and a consumer that must adopt it back. The master
buildout plan commits to executing **only the first simple steps here** (protocol → transport → discovery),
because those are the cleanly-generic, hand-synced-with-PwrSnap pieces with the lowest risk and the highest
drift-elimination payoff. The deeper layers (chat controller, the ACP normalizer that PwrAgnt *originated*)
are planned but staged behind the kit's API stabilizing, since PwrAgnt's versions are richer than the
first-cut packages and re-adopting them must be lossless.

---

## Summary

Adopt the `@pwrdrvr/*` packages in PwrAgnt in two waves:

- **Wave 1 (first simple steps — in scope to execute now):** consume `@pwrdrvr/codex-app-server-protocol`,
  `@pwrdrvr/agent-transport`, and `@pwrdrvr/codex-discovery` in place of PwrAgnt's in-tree copies. These are the
  pieces PwrSnap and PwrAgnt have been hand-syncing; swapping them deletes the drift at its source. PwrAgnt's
  profile-management, login flow, and discovery engine were the *source* for these packages, so re-consuming them
  must be behavior-preserving.
- **Wave 2 (planned, staged):** adopt `@pwrdrvr/agent-client` (`ChatThreadController`, `defineTool`) and
  `@pwrdrvr/agent-acp` (the normalizer PwrAgnt originated, re-targeted onto the neutral `agent-core` schema),
  collapsing PwrAgnt's 40+ inline `isAcpBackendId` branches in `DesktopBackendRegistry` onto the kit's clean
  `AgentBackend` polymorphism. This is the big one and waits for the kit API + neutral schema to settle.

Consumption follows the master plan's distribution flow: `file:` link → `@pwrdrvr/*@next` → stable. No `git`
dependency refs (PwrDrvr policy).

---

## Problem Frame

PwrAgnt's transport + discovery are the originals that PwrSnap copied. Keeping both means every fix is applied
twice and the copies drift. But PwrAgnt also has the richest version of this code (the generic `command-discovery`
engine that also backs `git`/`gh`, the full profile + login flow, the ACP normalizer), and its
`DesktopBackendRegistry` couples three backends together with ACP special-cased inline. A naive "swap everything"
would risk regressing PwrAgnt's most load-bearing surface. So: take the genuinely-generic, low-risk pieces back as
packages now (Wave 1), and stage the controller/ACP re-adoption until the kit proves it can represent PwrAgnt's
richness losslessly (Wave 2).

---

## Goals

- **Wave 1:** PwrAgnt consumes the protocol + transport + discovery packages; the duplicated in-tree copies of
  those three are deleted; Codex discovery / profiles / login behave identically.
- **Wave 2 (planned):** PwrAgnt's chat + ACP run on `@pwrdrvr/agent-client` + `@pwrdrvr/agent-acp` against the
  neutral schema, with `DesktopBackendRegistry`'s inline ACP branching replaced by `AgentBackend` polymorphism.
- End the PwrSnap↔PwrAgnt drift on the substrate PwrSnap is adopting in parallel.

## Non-Goals (Scope Boundaries)

**Out of scope (stays in PwrAgnt):**
- `packages/agent-core` (PwrAgnt's **Grok agent implementation** — unrelated to the kit's `@pwrdrvr/agent-core`
  neutral-schema package despite the name collision; rename-awareness only, no migration).
- The Grok App Server backend, `DesktopBackendRegistry`'s app-orchestration responsibilities (thread-turn queueing,
  worktree archive/handoff, git enrichment, notifications), all PwrAgnt UI, persistence, and the PwrAgent (app)
  profile system at `~/.pwragent/profiles/`.

**Deferred to Follow-Up Work (Wave 2 — planned here, executed later):**
- Adopt `@pwrdrvr/agent-client` (`ChatThreadController`, `defineTool`) behind PwrAgnt's stores.
- Adopt `@pwrdrvr/agent-acp` and re-target PwrAgnt's normalizer onto `agent-core`; collapse the inline
  `isAcpBackendId` branches onto `AgentBackend`.
- Flip `@next` → stable (master plan U12).

---

## Key Technical Decisions

### KTD-P1 — Wave 1 only swaps the three hand-synced-generic packages

Protocol, transport, and discovery are the pieces that are (a) genuinely generic, (b) literally duplicated with
PwrSnap, and (c) low-risk to re-adopt. They are the whole drift-elimination win and carry almost no behavioral
surface area beyond "spawn the right binary, speak JSON-RPC, find Codex." *Rationale: maximum drift payoff, minimum
regression risk — the right "first simple steps."*

### KTD-P2 — Discovery/profiles/login re-adoption must be byte-for-byte behavioral

PwrAgnt *originated* `@pwrdrvr/codex-discovery`. The package must reproduce PwrAgnt's discovery snapshot, profile
enumeration, JWT identity extraction, and `codex login` URL-scrape flow exactly. *Rationale: this is PwrAgnt's
most user-visible Codex surface (Settings → profiles, relogin); any drift is a user-facing regression. The package's
discovery tests should be seeded from PwrAgnt's existing fixtures.*

### KTD-P3 — Wave 2 waits for the neutral schema to prove lossless against PwrAgnt

PwrAgnt's `AppServerThreadReplay` is richer than the first-cut neutral schema. Wave 2 starts only after the kit's
`agent-core` schema (master U3) + ACP normalizer (ACP plan U21) demonstrably represent PwrAgnt's existing replay
without information loss — verified by replaying PwrAgnt's own recorded transcripts through the kit. *Rationale: PwrAgnt
is the hardest consumer; re-adopting its own crown-jewel normalizer must not lose fidelity.*

---

## Implementation Units — Wave 1 (execute now)

### U1. Consume `@pwrdrvr/codex-app-server-protocol`

- **Goal:** PwrAgnt imports the protocol types from the package instead of its in-tree generated copy.
- **Dependencies:** package available via `file:` link (or `@next`).
- **Files:** `apps/desktop/package.json` (+ wherever PwrAgnt currently vendors protocol types),
  imports across `apps/desktop/src/main/codex-app-server/` and `apps/desktop/src/main/app-server/`.
- **Approach:** Point protocol-type imports at `@pwrdrvr/codex-app-server-protocol` (matching the generated surface
  PwrAgnt already uses). Confirm the pinned Codex version matches PwrAgnt's expectations; if PwrAgnt pins a different
  Codex version than the package, reconcile before swapping.
- **Test scenarios:**
  - Happy path: PwrAgnt typechecks against the package's protocol types with no surface gaps.
  - Edge: a v2 type PwrAgnt relies on (DynamicToolCall / image ContentItem / realtime) resolves from the package.
  - `Test expectation:` typecheck-driven; no runtime behavior change.
- **Verification:** `pnpm -w typecheck` green; the in-tree protocol copy is unreferenced.

### U2. Consume `@pwrdrvr/agent-transport`

- **Goal:** PwrAgnt's Codex (and the ACP transport's JSON-RPC core) use the package transport.
- **Dependencies:** U1.
- **Files:** `apps/desktop/package.json`, `apps/desktop/src/main/codex-app-server/` consumers,
  `apps/desktop/src/main/acp/acp-stdio-transport.ts` (rebase onto the package's JSON-RPC connection),
  inject PwrAgnt's logger into the package.
- **Approach:** Replace PwrAgnt's `codex-app-server/json-rpc.ts` + stdio transport with the package; adapt
  `getMainLogger` to the package `Logger` interface. Because PwrAgnt's ACP transport wraps the same JSON-RPC core,
  rebase `acp-stdio-transport.ts` onto the package connection too — proving the shared core works for both backends
  inside the origin repo.
- **Test scenarios:**
  - Happy path: a Codex App Server connection initializes via the package transport.
  - Happy path: the ACP transport round-trips against a fake agent on the package's JSON-RPC core.
  - Edge: concurrent requests resolve correctly (PwrAgnt's existing transport tests, re-pointed).
  - Error path: timeout + server-request paths behave as before.
- **Verification:** PwrAgnt's transport + ACP transport suites pass on the package; no in-tree json-rpc copy referenced.

### U3. Consume `@pwrdrvr/codex-discovery` (discovery + profiles + login)

- **Goal:** PwrAgnt's Codex discovery, auth-profile management, and login/relogin run on the package.
- **Requirements:** KTD-P2.
- **Dependencies:** U2.
- **Files:** `apps/desktop/package.json`, `apps/desktop/src/main/settings/{command-discovery,codex-discovery,codex-profiles}.ts`
  (retire in favor of package), `apps/desktop/src/main/ipc/settings.ts` (call the package's status/login;
  inject `shell.openExternal`), `apps/desktop/src/renderer/src/features/settings/CodexAuthProfileSelect.tsx`
  (unchanged UI; now backed by the package).
- **Approach:** Replace the in-tree discovery engine + profiles + login with the package, injecting PwrAgnt's
  `OpenExternal` and config (env-var name, install paths). Persistence of the selected profile stays in PwrAgnt
  (`models.codex.profile` in `config.toml`) — the package only resolves a profile to `CODEX_HOME` and reports status.
  Seed the package's discovery tests from PwrAgnt's existing fixtures (KTD-P2).
- **Test scenarios:**
  - Covers parity: discovery returns the same candidate set + ordering as PwrAgnt's current implementation (snapshot).
  - Profiles: enumerate default + named `CODEX_HOME` profiles; `hasAuthFile` + JWT email/plan parse match prior output.
  - Login: `startCodexProfileLoginProcess` scrapes the OAuth URL and opens it via injected `shell.openExternal`;
    re-invocation kills the prior login child.
  - Edge: corrupt `auth.json` → empty identity, no throw (matches prior defensive behavior).
  - Error path: no Codex / too-old Codex surface the same Settings states (`CodexCliNotInstalledError`, `codex_too_old`).
- **Verification:** Settings → Codex profiles + relogin behave identically; the three in-tree discovery files are
  deleted; PwrAgnt CI green.

### U4. Delete the duplicated Wave-1 copies; switch to `@next`

- **Goal:** Remove the now-dead protocol/transport/discovery copies and consume the prereleases.
- **Dependencies:** U1–U3 green; master plan U10 (prereleases published).
- **Files (delete):** the in-tree protocol copy, `apps/desktop/src/main/codex-app-server/{json-rpc,stdio-transport}.ts`,
  `apps/desktop/src/main/settings/{command-discovery,codex-discovery,codex-profiles}.ts`; `apps/desktop/package.json`
  (`file:` → `@next` ranges).
- **Approach:** Delete only after U1–U3 confirm the package fully covers each. Swap `file:` ranges for `@pwrdrvr/*@next`.
  Update any AGENTS.md / CLAUDE.md notes that point at the in-tree substrate.
- **Test scenarios:** `Test expectation: none — deletion + dependency swap`. Verification is suite + typecheck green.
- **Verification:** `pnpm -w typecheck` + PwrAgnt suite green on `@pwrdrvr/*@next`; grep finds no imports of deleted modules.

---

## Implementation Units — Wave 2 (planned, staged)

### U5. (Planned) Adopt `@pwrdrvr/agent-client` behind PwrAgnt's stores

- **Goal:** PwrAgnt's chat threads run on the package `ChatThreadController` + `defineTool`, with PwrAgnt persistence
  behind the `ThreadStore` seam.
- **Dependencies:** Wave 1; KTD-P3 satisfied (neutral schema proven lossless against PwrAgnt replay).
- **Approach (directional):** Inject PwrAgnt's thread/overlay stores via `ThreadStore`; build catalogs from PwrAgnt's
  tools via the package `defineTool`. Keep PwrAgnt's app-orchestration (queueing, worktree handoff, git enrichment) in
  `DesktopBackendRegistry`; only the per-turn chat-controller mechanics move to the package.
- **Test scenarios:** parity of chat turn behavior + tool dispatch + usage accounting against current PwrAgnt; full
  scenarios authored when Wave 2 is scheduled.
- **Verification:** PwrAgnt chat behaves identically on the package controller.

### U6. (Planned) Adopt `@pwrdrvr/agent-acp`; collapse inline ACP branching onto `AgentBackend`

- **Goal:** PwrAgnt's ACP agents (Gemini/Grok/Kimi/Qwen) run through the kit's normalizer-to-`agent-core` and the
  clean `AgentBackend` interface, deleting the 40+ inline `isAcpBackendId` branches.
- **Dependencies:** U5; ACP plan U21–U23 shipped.
- **Approach (directional):** Replace PwrAgnt's `acp-session-normalizer.ts` consumption with the package normalizer
  (which originated from it, re-targeted onto neutral types); make PwrAgnt's backend path hold an `AgentBackend` for
  both Codex and ACP, removing the special-casing. This is the largest single refactor and the real test of KTD-P3 —
  PwrAgnt is the hardest consumer of its own extracted crown jewel.
- **Test scenarios:** replay PwrAgnt's recorded `session/update` transcripts through the package and assert no
  information loss vs. PwrAgnt's current `AppServerThreadReplay` rendering; full scenarios authored at scheduling time.
- **Verification:** PwrAgnt ACP chat for all four agents is unchanged user-side; `isAcpBackendId` branching is gone.

---

## Risks & Mitigations

- **Re-adopting PwrAgnt's own richer code loses fidelity.** *Mitigation:* KTD-P2/KTD-P3 — seed package tests from
  PwrAgnt fixtures; gate Wave 2 on lossless replay of PwrAgnt's own transcripts; stage it behind a stable kit API.
- **`agent-core`/`@pwrdrvr/codex-discovery` name collision with PwrAgnt's internal `packages/agent-core`.**
  *Mitigation:* scoped names (`@pwrdrvr/*`) disambiguate; call it out in the migration PR to avoid confusion.
- **Wave 1 discovery regression on a less-common platform** (PwrAgnt's discovery handles Linux/Windows paths the
  package must preserve). *Mitigation:* parity snapshot tests across the platform candidate paths; PwrAgnt's existing
  fixtures are the seed.
- **Native binding churn on dependency changes.** *Mitigation:* PwrAgnt's electron-native rebuild guidance.

---

## Dependencies / Sequencing

Wave 1: `U1` → `U2` → `U3` → `U4` (executed now, on `file:` then `@next`). Wave 2: `U5` → `U6`, gated on the kit's
neutral schema proving lossless against PwrAgnt (KTD-P3) and the ACP plan shipping. Wave 1 is the master plan's
"first simple steps of PwrAgnt"; Wave 2 is post-stabilization follow-up.

---

## Sources & Research

- agent-kit master plan + ACP plan (agent-kit repo, `docs/plans/2026-06-02-00{1,2}-*`).
- PwrAgnt extraction origins (this repo): `apps/desktop/src/main/settings/{command-discovery,codex-discovery,codex-profiles}.ts`,
  `apps/desktop/src/main/ipc/settings.ts` (login flow), `apps/desktop/src/main/codex-app-server/json-rpc.ts`,
  `apps/desktop/src/main/acp/*`, `apps/desktop/src/main/app-server/{backend-registry,acp-backend-adapter}.ts`,
  `packages/shared/src/contracts/{normalized-app-server,backend}.ts`.
- Name-collision note: PwrAgnt's internal `packages/agent-core` is the Grok agent implementation, NOT the kit's
  neutral-schema `@pwrdrvr/agent-core`.
