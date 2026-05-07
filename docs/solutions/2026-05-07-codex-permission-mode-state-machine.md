---
title: Codex permission-mode state machine — five fixes that finally cohered
type: solution
status: shipped
date: 2026-05-07
tags: [codex, app-server, permissions, sandbox, drift, queue]
related_prs: [#203, #209, #213, #217]
related_plans:
  - docs/plans/2026-04-16-004-feat-codex-access-mode-toggle-plan.md
  - docs/plans/2026-05-04-002-fix-thread-branch-drift-detection-plan.md
  - docs/plans/2026-05-07-001-feat-codex-single-instance-queued-permissions-plan.md
---

# Codex permission-mode state machine — five fixes that finally cohered

> **TL;DR.** Across April–May 2026, the access-mode feature surfaced five layered bugs because codex's permission model migrated from process-level sandboxing to per-thread `PermissionProfile` mid-flight and PwrAgent's architecture was structured for the old model. The fixes are individually small but the failure modes overlap in ways that made each bug look like the next one's root cause. Future PwrAgent contributors who touch permissions, sandboxing, or thread-state-update flows: read this before assuming you've found "the" cause.

## Symptom timeline

The user reported variations of the same shape across three weeks:

- "I toggled to Default Access but the agent ran `npm view express` without prompting." (May 6)
- "Thread shows Full Access in PwrAgent UI but I'm getting permission prompts as if it were Default." (May 7)
- "I had a thread on Default, switched to Full, ran a command, switched back to Default, and the next turn got prompted for permissions on a command it had already approved." (May 7)

Same surface, different layers. Below is the root-cause map.

## The five layers

### Layer 1 — Composer dropped `executionMode` on `startTurn`

[PR #203](https://github.com/pwrdrvr/PwrAgent/pull/203). The composer's submit handler did not pass the thread's `executionMode` to the registry's `startTurn`, and the registry's `withCodexThreadClient` had a silent cross-mode fallback that masked the missing parameter — when "default" routing failed (e.g., codex hadn't loaded the thread on that process), it fell through to "full-access" with no log line. PR #203 made the renderer pass `executionMode` explicitly and removed the silent fallback.

**Lesson:** Silent fallbacks across security-relevant boundaries are bug nests. Log every routing decision with structured fields so the logs are greppable. (The `codex thread client routing` debug line we added in PR #203 has paid for itself many times since.)

### Layer 2 — Default codex client spawned with no sandbox args

[PR #209](https://github.com/pwrdrvr/PwrAgent/pull/209). After PR #203, network commands still ran without prompting on Default Access threads. The reason: the *full-access* codex child was spawned with explicit `-c approval_policy="never" -c sandbox_mode="danger-full-access"` flags, but the *default* child was spawned with **no flags at all**. It inherited whatever upstream codex's compiled-in defaults were — and those drifted to permissive auto-approval somewhere between codex 0.127 and 0.128. The default child was effectively running with full access despite the UI labeling threads on it as workspace-write/on-request.

**Lesson:** Don't trust upstream's compiled-in defaults for security-relevant behavior. Pin them explicitly at spawn time. Phase 1 of the May 7 single-instance refactor preserved this lesson — the surviving single child still spawns with `-c approval_policy="on-request" -c sandbox_mode="workspace-write"`.

### Layer 3 — `turn/start` didn't carry `approvalPolicy` / `sandboxPolicy`

[PR #213](https://github.com/pwrdrvr/PwrAgent/pull/213). After PRs #203 and #209, fresh-restart toggles worked, but mid-session toggles (Default → Full → Default on the same thread) still leaked permission state. Investigation: codex moved permission state from process-level to per-thread `PermissionProfile` in upstream commits #18278, #19773–19776, #20106. The persisted profile sticks to the thread session across `thread/resume`. To refresh the profile each turn, codex's V2 `TurnStartParams` exposes `approvalPolicy` and `sandboxPolicy` overrides documented as "for this turn and subsequent turns" — and PwrAgent's desktop client was dropping both fields on the floor. The codex TUI sends them on every `turn/start`; we weren't.

PR #213 plumbed the override through `buildTurnStartPayload` and added defensive logging on the `thread/resume` failure path (which had been silently `.catch(() => undefined)`'d).

**Lesson:** When upstream protocols add new fields with names like "override for this turn and subsequent turns", they are usually load-bearing for protocol invariants you don't realize you depend on. Always check the reference client implementation (here: codex TUI) when wiring a new app-server backend.

### Layer 4 — Cross-process state divergence (and the drift detector that briefly stood in for a real fix)

By the time PRs #203, #209, #213 had landed, the per-turn happy path was correct. But two-process architecture introduced a subtler bug: when the same thread was loaded into both codex children (one default, one full-access), they each kept independent in-memory caches of the thread's `CodexThread` object. Codex has no `thread/unload` RPC. Round-trip toggles (Default → Full → Default) left the now-active child reading from disk while the previously-active child held a stale cache. Subsequent turns on the round-tripped child silently used outdated context.

[PR #217](https://github.com/pwrdrvr/PwrAgent/pull/217) added drift detection — comparing PwrAgent's overlay-stored `executionMode` against codex's reported permission state on each `thread/resume` response. When they disagreed, a banner prompted the user to either keep PwrAgent's value or adopt codex's. This caught the *symptom* (user-visible mode disagreement) but did not address the underlying split-brain.

**Once Layer 5 (single-instance + queue) shipped, drift detection became dead code.** The new architecture makes permission state deterministic — one process holds the canonical profile, every `turn/start` re-asserts it, and the queue serializes mid-turn changes at the resume boundary. The user tested across multiple threads and transitions and confirmed the new architecture maintains state correctly. The drift dialog was just UI noise; the probe was wasted runtime cost. **PR #217 was reverted in commit `2f0e8282` after the new architecture proved itself in real-world use.**

**Lesson:** Drift detection is a useful safety net during a transition, but it's a debugging tool, not a fix. If your architecture allows two pieces of state to disagree, eliminate the second piece if you can. The cleanest fix for a class of bugs is often "make the bug structurally impossible". Once you've made it structurally impossible, the safety net becomes dead weight — remove it.

### Layer 5 — Single-instance + queue at the resume boundary

The plan at `docs/plans/2026-05-07-001-feat-codex-single-instance-queued-permissions-plan.md` collapses the dual-process architecture into a single codex child. Per-thread `PermissionProfile` plus PR #213's per-turn `approvalPolicy`/`sandboxPolicy` override means one codex process can host threads with mixed permission profiles correctly — the dual-process workaround is now technical debt.

The complementary half: `thread/resume` mid-turn warns-and-ignores permission overrides ("thread/resume overrides ignored for running thread", `thread_processor.rs:2646` upstream). The honest reading is that **a thread's permission profile is immutable while a turn is running**. Pretending otherwise (the previous "toggle takes effect immediately" UX) was the source of the silent-divergence reports. The fix: queue mid-turn toggles, surface the queue visibly in the same composer-queue affordance the user already understands, apply at turn-end with a persistent audit trail.

**Lesson:** When upstream protocol semantics say "this is immutable in state X", your UX should not lie about that. The honest "wait until X ends" UX is more recoverable than the "we tried but actually it didn't take effect" UX, and produces a cleaner audit trail.

## Why this took five fixes instead of one

Each fix made the next bug visible. PR #203's removal of the silent fallback let PR #209's symptom appear. PR #209's spawn-args fix let PR #213's missing per-turn override become reproducible. PR #213's per-turn override let PR #217's drift detection become useful. PR #217's drift detection made the structural split-brain in the dual-process architecture obvious enough to motivate the May 7 collapse.

This is the same pattern Joel Spolsky calls "the iceberg secret" — bugs hide each other. If you fix the most visible one and stop, the next-most-visible takes the throne. Plan to keep going until the pattern stabilizes.

## Things to NEVER do here

- **Never silently fall back across security-relevant routing decisions.** If a route fails, log it with structured fields and let it bubble. Drift detection works because the routing is observable.
- **Never trust upstream's compiled-in defaults for sandbox behavior.** Pin explicitly. PwrAgent's `buildCodexClientArgs` is a single source of truth for spawn flags — don't let it drift back to "no flags".
- **Never skip the per-turn `approvalPolicy`/`sandboxPolicy` override on `turn/start`** even though the persisted profile *should* survive. The override is defense-in-depth and protocol-blessed.
- **Never apply mid-turn permission changes to codex's per-thread profile.** Either codex rejects them, ignores them, or silently warns — none of those produce predictable behavior. Queue at the resume boundary.
- **Never split a single backend kind across two child processes** unless the protocol forces you. Codex's per-thread `PermissionProfile` removed that need; we kept the split for two months too long.

## Things future contributors should know

- The `codex thread client routing` debug log line (added in PR #203, surviving into the single-instance era for documentation) is your first stop when investigating any "ran with wrong mode" report. Grep for the threadId.
- The `permissionTransitionLog` on `ThreadOverlayState` (capped at 100 entries, sqlite-backed) is the persistent audit trail. Each transition is queued/applied/cancelled with a `queueId` linking related entries.
- **Drift detection was removed** with PR #217's revert in `2f0e8282`. If you find yourself reaching for it again, that's a strong signal the architecture has regressed — investigate whether the per-turn override on `turn/start` and the queue at the resume boundary are still both intact. The combination is what makes drift impossible.
- Upstream codex is moving toward named-profile selection (`permissions: PermissionProfileSelectionParams`) as the canonical mechanism, with the raw `approvalPolicy`/`sandboxPolicy`/`sandbox` fields slated for server-rejection. The single-instance architecture is forward-compatible — when that lands on `origin/main`, swap raw values for named-profile selection in `client.setThreadPermissions` and the per-turn override. Localized change.

## Tests that lock the invariants

If you ever revert one of these layers without realizing it, these tests should fire first:

- `apps/desktop/src/main/__tests__/backend-registry-replay-isolation.test.ts` "spawns exactly one codex child process with workspace-write defaults" — guards against accidentally re-introducing the dual-process model OR dropping the spawn-args fix.
- `apps/desktop/src/main/__tests__/codex-client.test.ts` "encodes danger-full-access as the dangerFullAccess SandboxPolicy variant on turn/start" + "still emits the per-turn permission overrides on turn/start when thread/resume fails" — guards PR #213's per-turn override and resume-failure resilience.
- `apps/desktop/src/main/__tests__/backend-registry.test.ts` `describe("queued permission-mode changes")` — guards the queue state machine.
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts` `describe("permission-mode queue audit lifecycle")` — guards the messaging surface parity.

## Sources

- [PR #203](https://github.com/pwrdrvr/PwrAgent/pull/203) — Composer `executionMode` + registry no-fallback
- [PR #209](https://github.com/pwrdrvr/PwrAgent/pull/209) — codex client spawn-args
- [PR #213](https://github.com/pwrdrvr/PwrAgent/pull/213) — per-turn `approvalPolicy`/`sandboxPolicy` + resume-failure logging
- [PR #217](https://github.com/pwrdrvr/PwrAgent/pull/217) — permission-mode drift detection (later removed in `2f0e8282` once the structural fix made it dead code)
- `docs/plans/2026-05-07-001-feat-codex-single-instance-queued-permissions-plan.md` — single-instance + queue plan
- Upstream codex: per-thread profile migration in #18278, #19773–19776, #20106; `TurnStartParams.{approvalPolicy,sandboxPolicy}` since 2026-02-01.
