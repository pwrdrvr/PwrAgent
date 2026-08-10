# Live Run Strip Above the Composer — UI Design Review and Proposal

Date: 2026-08-10
Status: proposal; open questions resolved 2026-08-10, direction not yet accepted
Scope: the band between the transcript and the reply input; the Sub-agents rail panel

## The ask

Two observations from the operator:

1. Env action runs are pinned above the composer, but they read as "chunky and
   ugly and huge" blocks. They want a compact expandable line instead, plus an
   animated embellishment so a running action visibly reads as *still running*.
2. Running sub-agents — PwrAgent task monitors, Codex native sub-agents, and
   anything an ACP backend spawns — deserve the same above-composer treatment:
   capped at ~4 visible then scrollable, collapsible under an "Active
   sub-agents" header with a count, and gone entirely once everything finishes
   (completed sub-agents already live in the sidebar and the rail panel).

## Review: what is actually there today

### The band above the composer has no owner

The strongest finding is that "the env action row is chunky" is a symptom, not
the disease. There are already **three independent stacks** competing for the
space directly above the reply input, and the proposal would add a fourth:

| Order (top → bottom) | Element | Rendered by | Height behavior |
|---|---|---|---|
| 1 | `LiveWorkRail` — plan + edited files | [ThreadView.tsx:3241](apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx:3241) | capped `min(38vh, 360px)`, scrolls internally |
| 2 | Env action runs, one row per run | [Composer.tsx:10163](apps/desktop/src/renderer/src/features/composer/Composer.tsx:10163) → `EnvActionAnchorList` | **unbounded** — N runs, N rows |
| 3 | Pending steer / queued permissions / scheduled / failed | [Composer.tsx:10172+](apps/desktop/src/renderer/src/features/composer/Composer.tsx:10172) | 1–2 rows |
| *(proposed)* | Active sub-agents | — | — |

Every one of them is the same card: `1px solid var(--border-subtle)`,
`border-radius: 8px`, `background: var(--bg-panel-elevated)`, `padding: 8px 10px`.
`.live-work-rail` is at [app.css:13616](apps/desktop/src/renderer/src/styles/app.css:13616);
`.composer__queued` is at [app.css:18711](apps/desktop/src/renderer/src/styles/app.css:18711).
Identical weight, identical treatment, no hierarchy between them.

Stacking four visually-identical cards is what produces "huge." Shrinking one
card does not fix a band with no budget. **The proposal below treats the band as
a single designed region rather than four features that each grabbed space.**

This also sits against [UI-THEME.md:443](docs/UI-THEME.md:443) — "Do not put
cards inside cards" — and
[desktop-style-guide.md:213-226](docs/design/desktop-style-guide.md:213). A card
is for something that "genuinely frames a unit of interaction." A one-line status
readout is not that.

### The env action row is already expandable — that is not the problem

[EnvActionRunsView.tsx:217](apps/desktop/src/renderer/src/features/thread-detail/EnvActionRunsView.tsx:217)
already renders a native `<details>` / `<summary>`, collapsed by default, with a
chevron that rotates on `[open]`. The expanded body holds Command and Output.

So the requested "expandable text instead of a huge blocky border" is *almost*
already built. What makes it read heavy at rest is four things, all fixable
without restructuring:

1. **Full card chrome at rest.** Border + elevated background on a row that is
   idle information. The house already has a quieter idiom:
   `.transcript-work-phase-group__toggle`
   ([app.css:12413](apps/desktop/src/renderer/src/styles/app.css:12413)) is
   transparent-bordered at rest and only gains `--border-subtle` + `--bg-panel`
   on hover.
2. **Three 26×26 icon buttons always visible** — Stop, Terminate, and
   move-to-sidebar
   ([app.css:18919](apps/desktop/src/renderer/src/styles/app.css:18919)).
   Terminate is a destructive escalation that does not need permanent residency.
3. **8px vertical padding plus a 6px inter-row gap**, multiplied by N runs.
4. **No visual difference between running and finished.** See below.

### Defect: the "running" modifier has no styling at all

[EnvActionRunsView.tsx:213](apps/desktop/src/renderer/src/features/thread-detail/EnvActionRunsView.tsx:213)
applies `composer__queued--env-action-running`. Grepping `app.css` for that class
returns **nothing**. `--env-action-failed` (18833) and `--env-action-exited`
(18842) both have rules; running does not.

A running action is therefore pixel-identical to a neutral finished one. The only
thing distinguishing them is the text `running for 1s`, and the whole block
contains no animation of any kind — the sole motion is the chevron's
`transition: transform 120ms ease`. So the operator's instinct is correct and the
gap is concrete, not aesthetic.

### The sub-agent data model is already unified — no new plumbing needed

Good news for the second half of the ask. Every producer writes the same type
through the same store:

- Type `ThreadSubAgentSummary` — [navigation.ts:236-256](packages/shared/src/contracts/navigation.ts:236)
- Status union `ThreadSubAgentStatus` — [navigation.ts:226](packages/shared/src/contracts/navigation.ts:226):
  `pending | running | cancelling | blocked | failed | success | failure | cancelled`
- Single write path: `overlayStore.upsertThreadSubAgent`
  ([overlay-store-sqlite.ts:1854](apps/desktop/src/main/state/overlay-store-sqlite.ts:1854))

Four producers, all in `backend-registry.ts`: PwrAgent task monitors
(`persistTaskMonitorSubAgent`, 20449), code review (`persistReviewSubAgent`,
20524 — this is the ACP path too), Codex native `spawnAgent`
(`persistCodexNativeSubAgent`, 20119), and the thread-title helper (22328).
Origin is classified client-side by `monitorId` prefix in
[subagent-kind.ts](apps/desktop/src/renderer/src/features/thread-detail/context-panels/subagent-kind.ts).

**One strip covers PwrAgent, Codex, and ACP sub-agents with no backend work.**

Two caveats:

- There is no `startedAt` and no `spawnedBy` field. The card derives "Started"
  from `createdAt` and "Spawned by …" from the `monitorId` prefix. Fine to keep
  doing, but do not assume those fields exist.
- `thread/subAgents/updated` triggers a **full `scheduleRefresh()`**
  ([useThreadNavigation.ts:4147](apps/desktop/src/renderer/src/lib/useThreadNavigation.ts:4147)),
  not an in-place patch. The strip must read from the existing navigation
  snapshot via `useSubAgents` and must not introduce any polling of its own.

Also relevant: `hasRunningSubAgent` already exists at
[SubAgentsPanel.tsx:38](apps/desktop/src/renderer/src/features/thread-detail/context-panels/SubAgentsPanel.tsx:38)
but is used only to gate the 1s duration ticker. Nothing surfaces an active
count anywhere in the context rail — the rail tab is icon-only
([ThreadContextPanel.tsx:639](apps/desktop/src/renderer/src/features/thread-detail/ThreadContextPanel.tsx:639)).

---

## On the animation: recommend against the 5-second ripple

The instinct is right; the specific proposal fights three existing rules and one
piece of house physics. Concretely:

**A 5s period reads as stalled, not alive.** Liveness animation answers exactly
one question — "is this frozen?" At a 5-second cadence the operator has to watch
for five seconds to answer it. The house cadences are 1.6s (`status-blink`,
[app.css:22136](apps/desktop/src/renderer/src/styles/app.css:22136)) and 1.8s
(`pwragent-thinking-scanner-sweep`,
[app.css:15358](apps/desktop/src/renderer/src/styles/app.css:15358)).

**Animating the text color specifically is out of bounds.**
[UI-THEME.md:284](docs/UI-THEME.md:284) says status colors must "never be used in
body copy," and the accent ramp table
([UI-THEME.md:334-345](docs/UI-THEME.md:334)) reserves `--accent-bright` for text
on an accent tint. A color ripple traveling across the run description is exactly
the "decorative glow" listed as an anti-pattern at
[UI-THEME.md:512](docs/UI-THEME.md:512).

**A new keyframe is unnecessary and carries a maintenance tax.** The
reduced-motion suppression list at
[app.css:22287](apps/desktop/src/renderer/src/styles/app.css:22287) is a
hand-maintained selector list, not a blanket rule — every new animated element
must be added by hand or it ships an a11y regression.

### What to do instead — two signals, one of which survives reduced motion

**Env action rows: `.status-dot` + `.status-dot--blink`.** 8px, 1.6s
`ease-in-out` opacity pulse, already the documented canonical "in flight" signal
([UI-THEME.md:266-284](docs/UI-THEME.md:266)), already reduced-motion-guarded
(add the new selector to the 22287 list). Semantically correct: an env action is
a *process*, and the dot is the app's process-liveness mark.

**Sub-agent rows: `<ThinkingScanner compact />`.** The 16×6px beam is the app's
established "an agent is working" mark, already used in `TranscriptList`,
`ThreadRowStatus`, and `Sidebar`. Because `syncThinkingScannerAnimation` pins
`animation.startTime = 0` (PR #1187), a new instance phase-locks with the
scanners already visible in the sidebar and transcript — the whole window
breathes together instead of shimmering out of sync.

> Trap to respect: per the comments at
> [app.css:3131-3140](apps/desktop/src/renderer/src/styles/app.css:3131) you may
> **not** build an idle state by switching the beam's animation off — a
> CSS-stopped-and-restarted animation never re-pins. The idle case needs a
> separate static element, as `.lens-switch__dormant-scanner`
> ([app.css:3141](apps/desktop/src/renderer/src/styles/app.css:3141)) does.
> In this design there is no idle case (the strip is absent when nothing runs),
> so this should not bite — but do not "optimize" it later by leaving the strip
> mounted with the animation paused.

**And keep the ticking elapsed counter.** `running for 1m 04s` re-rendering every
second is the honest liveness signal and the only one that still works under
`prefers-reduced-motion: reduce`. Motion answers "alive?" at a glance; the
counter answers it definitively. Two independent signals, no color in body copy.

---

## Proposal

### 1. A shared `.live-strip` primitive

One compact disclosure row, used by both features. Not a card at rest.

```
  ●  ENV ACTION   Dev - No Messaging · pid 16744 · 1m 04s          [▪]  ⌄
  ^  ^            ^                                                ^    ^
  |  |            |                                                |    chevron
  |  |            |                                                Stop (running only)
  |  |            secondary metadata, 12px/500 --text-secondary, ellipsized
  |  uppercase label, 11px/700 --text-muted
  blinking status dot, 8px
```

Composed entirely from existing vocabulary — no new tokens, no new keyframes:

| Part | Reuse |
|---|---|
| Row shell | `.transcript-work-phase-group__toggle` ([app.css:12413](apps/desktop/src/renderer/src/styles/app.css:12413)) — transparent border at rest, `--border-subtle` + `--bg-panel` on hover, `--focus-ring` outline on focus-visible |
| Chevron | canonical `.live-work-rail__chevron` geometry ([app.css:13728](apps/desktop/src/renderer/src/styles/app.css:13728)) — 8px CSS-border V, `flex: 0 0 auto`, 120ms transform |
| Label | 11px/700 uppercase `--text-muted` (as `.live-work-rail__title`, `.composer__queued-label`) |
| Liveness | `.status-dot--blink` or `<ThinkingScanner compact />` |
| Terminal states | `.rail-chip` + `.rail-chip__dot--{ok,error}` ([app.css:17642](apps/desktop/src/renderer/src/styles/app.css:17642)) |

Row height fixed at `28px` via a `--live-strip-row-h` custom property, so
expand/collapse and hover never reflow neighbors
([UI-THEME.md:460](docs/UI-THEME.md:460)).

Chevron must be `children[0]` and the label `children[1]` — pinned by
[chevron-placement.test.tsx:19-52](apps/desktop/src/renderer/src/features/thread-detail/__tests__/chevron-placement.test.tsx:19).

### 2. Env actions: demote Terminate, keep the `<details>`

Keep the existing `<details>` / `<summary>` structure and the existing body
(Command, Output). Change only the summary:

- Restyle `.composer__queued--env-action` to the `.live-strip` shell — drop the
  card border and elevated background at rest.
- **Add the missing `--env-action-running` rule** and give it the blinking dot.
  This is a bug fix regardless of whether the rest of the proposal lands.
- **Stop stays in the collapsed row. Terminate moves into the expanded body.**
  Force-kill is the destructive escalation; requiring one deliberate expand
  before offering it is better than parking it permanently one pixel from Stop.
  This also reclaims a 26px button slot.
- Shrink remaining controls 26×26 → 22×22.

### 3. Sub-agents: a grouped strip, absent when idle

A single group row with a count, expanding to a bounded child list:

```
collapsed:
  ▰  ACTIVE SUB-AGENTS  3                                              ⌄

expanded:
  ▰  ACTIVE SUB-AGENTS  3                                              ⌃
  ├ ▰  Run and monitor the approved M2 pwrsnap-dev headed…    7m 18s  [▪]
  ├ ▰  Verify the Sequoia 15.7.9 installer cache cleanup       2m 04s  [▪]
  ├ ▰  Draft the release notes for the runner maintenance PR   0m 46s  [▪]
  └ ▰  Reconcile the Tart VM inventory against the lab manif…  0m 12s  [▪]
     (scrolls past 4)
```

Behavior:

- **Absent when idle.** Renders nothing when there are no non-terminal
  sub-agents *and* no undismissed failures; no reserved space, no empty state.
- **Bounded.** `max-height: calc(4 * var(--live-strip-row-h))`, `overflow-y:
  auto`, `overscroll-behavior: contain` — matching `.context-panel__scroll`
  ([app.css:16341](apps/desktop/src/renderer/src/styles/app.css:16341)).
- **Membership = `!isTerminalSubAgent(subAgent)` plus undismissed failures.**
  Reuses the existing helper from `subagent-format.ts` so the strip and the rail
  panel can never disagree about what "running" means; the failure carve-out is
  layered on top rather than by redefining the helper (see resolved decision 1).
- **Starts expanded at 1–2 active, collapsed at 3+**, with a manual toggle
  always winning thereafter. In-memory only, not persisted.
- Row click expands nothing inline — it opens the existing
  `SubAgentDetailsModal`. The rail panel stays the full-detail surface; the strip
  is a presence indicator with a Stop button, not a second copy of the card.
- Reads `useSubAgents(thread)` off the existing navigation snapshot. **No new
  IPC, no new polling.**
- Stop reuses `desktopApi.stopSubAgent` (`agent:stop-sub-agent`), including the
  federated path already handled in
  [agent-ipc.ts:738](apps/desktop/src/main/ipc/agent-ipc.ts:738).

### 4. Give the band a height budget

With `LiveWorkRail` at up to 360px plus two strips plus a steer row, the composer
can be pushed well down the window. Propose a shared cap on the strip region
(everything except `LiveWorkRail`, which already caps itself) of
`min(20vh, 180px)`, scrolling internally past that. This is the part that
actually answers "huge" for the long tail — a thread with six parallel env
actions today produces six unbounded stacked cards.

---

## Incidental defects found during the review

Both are pre-existing and independent of this work; calling them out so they are
fixed deliberately rather than absorbed silently.

1. **`--danger-border` is self-referential in the dark theme.**
   [app.css:66](apps/desktop/src/renderer/src/styles/app.css:66) reads
   `--danger-border: var(--danger-border);`, which is invalid at computed-value
   time. The light theme defines it correctly at
   [app.css:337](apps/desktop/src/renderer/src/styles/app.css:337). This means
   `.composer__queued--env-action-failed` has no border color in dark mode —
   which is the default theme.
2. **`.thinking-scanner__beam` has no `prefers-reduced-motion` rule.**
   [app.css:15346](apps/desktop/src/renderer/src/styles/app.css:15346) sweeps
   infinitely regardless of the preference. Reusing the scanner for sub-agents
   would propagate that gap to a new surface, so it should be closed first — but
   note the "cannot stop and restart the beam" constraint above: the fix is
   likely a static reduced-motion variant, not `animation: none`.

## Tests this would touch

- [theme-contract.test.tsx:1307-1322](apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx:1307)
  pins thinking-scanner geometry and the shared sweep keyframe. Per
  [UI-THEME.md:372](docs/UI-THEME.md:372), a deliberate change here lands in the
  same commit as the change itself.
- [chevron-placement.test.tsx](apps/desktop/src/renderer/src/features/thread-detail/__tests__/chevron-placement.test.tsx)
  — extend to cover `.live-strip`.
- [LiveWorkRail.test.tsx](apps/desktop/src/renderer/src/features/thread-detail/__tests__/LiveWorkRail.test.tsx),
  [SubAgentsPanel.test.tsx](apps/desktop/src/renderer/src/features/thread-detail/context-panels/__tests__/SubAgentsPanel.test.tsx)
  — unchanged behavior, but the band reorder should get a regression test.
- New: strip is absent at zero active sub-agents; strip scrolls past 4;
  Terminate is not reachable while the env action row is collapsed.

## Resolved decisions

Settled with the operator on 2026-08-10.

1. **A failed sub-agent lingers until dismissed.** Strip membership is not
   purely `!isTerminalSubAgent`. A sub-agent reaching `failed` or `failure`
   keeps its row, restyled with `.rail-chip--alert`
   ([app.css:17658](apps/desktop/src/renderer/src/styles/app.css:17658)), until
   the operator dismisses it or navigates away from the thread. Rationale: a
   silent disappearance is the worse failure mode — the sidebar and rail copies
   are not in the operator's eyeline while they are typing.

   Consequence for §3: the strip is **not** absent whenever the active count is
   zero. It is absent when there are no non-terminal sub-agents *and* no
   undismissed failures. Successful and cancelled sub-agents still leave
   immediately; only failures linger.

   Consequence for the liveness mark: a lingering failed row must not carry a
   `<ThinkingScanner>`. It gets the static alert chip instead — nothing about a
   finished failure should animate.

2. **Expanded at 1–2 active, collapsed at 3+.** Evaluated when the strip
   mounts. A manual expand or collapse always wins and is never overridden by a
   later count change — the auto-rule seeds the initial state only. Not
   persisted (see decision 3).

3. **No dock-to-sidebar toggle in v1.** The strip removes itself at zero, which
   is the bulk of what a dock toggle buys, and a third dock preference alongside
   `actionRunsDock` and `editedFilesDock` is not worth it for a self-dismissing
   surface. Follows that the expand/collapse state from decision 2 is in-memory
   only — no new `config.toml` key in v1.

4. **Thread-scoped.** Reads `useSubAgents(props.thread)` off the existing
   navigation snapshot, no cross-thread aggregation. Accepted limitation: a
   sub-agent spawned from a thread the operator has navigated away from is
   invisible in the band. The Attention lens and the sidebar remain the
   cross-thread surfaces. Revisit only if operators report losing track of
   off-thread monitors.
