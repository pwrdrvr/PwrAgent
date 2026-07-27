---
date: 2026-07-13
topic: pr-status-polling-and-ci-events
---

# PR Status Polling and CI Event Ingestion Requirements

## Summary

PwrAgent should keep a **reasonably fresh** view of pull-request status for every
project the operator has open, instead of only refreshing the PR that happens to
be selected (or that was last hovered). A main-process background poller should
walk the registry of tracked PRs on a **budget-aware, priority-tiered cadence**:
the focused/on-screen project fast (~60 s), everything else slower (~2–5 min),
round-robining so no project goes stale for long. Where possible it should fetch
**many PRs across disparate repos in a single API request** so a full sweep costs
a handful of rate-limit units, not one-per-PR.

The near-term deliverable is the poller. The forward-looking piece — turning a
detected CI/merge transition into an **inbound event that can start a turn in the
thread** (a webhook-mimic) — is designed here as a subscriber on the same
transition signal, but is **not** built now.

---

## Problem Frame

Today PR status is **pull-on-demand and single-thread**:

- The only recurring refresh is a renderer `setInterval` that refreshes **the
  currently-selected thread** every 60 s (`usePullRequestRefresh.ts`,
  `SELECTED_REFRESH_INTERVAL_MS`). Hover prefetch (750 ms delay, 10 s dedupe) and
  a post-turn refresh are the only other triggers.
- Nothing polls the other 20–30 projects the operator has open. Their PR chips
  are "a snapshot from the last time I moused over that PR 17 hours ago."
- We used to have a periodic refresh of PR status across open repos (the delta
  crawl in `ghcrawl`); that was lost. So new PRs, title edits, and CI/merge
  transitions on unfocused projects are invisible until the operator interacts.

The operator's actual need: **when a PR changes state because CI passed/failed,
it merged, or it developed a merge conflict, the app should reflect that within a
minute or few — proportional to how much attention that project currently has —
without spending the whole GitHub budget doing it.**

Two distinct freshness jobs fall out of this:

1. **Status refresh of PRs we already track** — CI rollup, mergeable/conflict,
   draft→ready, merged/closed, title. This is the high-value, high-frequency job.
2. **Discovery** of PRs we *don't* yet track (a branch just got a PR opened
   against it; a title changed on a repo we watch). Lower frequency.

---

## What We're Reusing (and From Where)

Three existing codebases already solve pieces of this. The design leans on them
rather than reinventing:

**PwrAgent (current) — keep the data model, caches, and push bus.**
- `PrSummary` already carries the rich fields we need: `checkState`
  (`failing|passing|pending|unknown`, derived from `statusCheckRollup`),
  `lifecycleState` (`open|merged|closed`), `reviewState` (`draft|ready_for_review`),
  `mergeState` (`mergeable|conflicting|unknown`), `commitShas`, `title`, `url`.
  **The data model is not the gap.**
- Persistence: `pr_status_cache` / `pr_lookup_cache` tables + per-thread overlay
  (`prsFetchedAt`, `prsRefreshKey`). In-memory `prStatusRegistry` (per-PR, keyed
  `provider/org/repo#number`) and `prRefreshContextByThreadKey` (remembers *every*
  thread's refresh context — a ready-made enumeration of pollable targets).
- Rate-limit hygiene already present: `PrStatusTokenBucket` (cap 20, refill
  20/min), per-lookup in-flight coalescing, min-interval gates, and a
  terminal-state short-circuit (stop polling once all cached PRs are merged/closed).
- Push-to-renderer bus: `publishLocalEvent` → agent-event channel → renderer
  patches the navigation snapshot in place (`thread/pullRequests/updated`,
  `pullRequest/status/updated`). **New PR data rides this existing bus.**

**PwrGit — the in-process GraphQL + token + backoff pattern.**
- Token from `gh auth token` (fallback `GITHUB_TOKEN`), cached in-memory ~5 min.
- `@octokit/graphql` only; one **aliased** GraphQL query batches ~50 lookups per
  HTTP request. Hand-rolled retry (`MAX_RETRIES=4`) that honors `retry-after`,
  `x-ratelimit-remaining`/`-reset`, and exponential backoff — chosen because the
  octokit throttling/retry plugins dragged in a `bottleneck` transitive dep that
  was painful to install. We can reuse either the plugins or this hand-rolled
  wrapper; see Open Decisions.

**ghcrawl — the delta-timestamp discovery crawl and backoff config.**
- `deriveIncrementalSince()`: window = gap since last successful scan, rounded up
  to whole hours, **minimum 2 h overlap** (never a razor-edge cursor — avoids
  missing items updated mid-crawl). Persist a per-repo "last scanned at" watermark.
- Discovery via `GET /repos/{owner}/{repo}/issues?sort=updated&direction=desc&since=<ISO>`
  which returns issues *and* PRs (PRs carry a `pull_request` key); run once for
  `state=open` and once for `state=closed` to catch both. Octokit
  retry+throttling plugin config (`doNotRetry: [400,401,403,404,422]`,
  `retries: 4`, `onRateLimit`/`onSecondaryRateLimit` returning `true`).

---

## Answering the Batching Question

> "Can we give GitHub, in one API request that counts as one call, a list of
> disparate PR numbers across different repos?"

**Yes — via a single aliased GraphQL query.** GraphQL lets us alias many
top-level `repository(...)` selections in one request, each drilling straight to
one PR by number:

```graphql
query PollPRs {
  p0: repository(owner: "acme", name: "web")    { pullRequest(number: 128) { ...PrStatus } }
  p1: repository(owner: "acme", name: "api")    { pullRequest(number: 47)  { ...PrStatus } }
  p2: repository(owner: "other", name: "infra") { pullRequest(number: 991) { ...PrStatus } }
  # ... ~30–50 of these per request
}

fragment PrStatus on PullRequest {
  number title url state isDraft updatedAt
  mergeable                                    # MERGEABLE | CONFLICTING | UNKNOWN
  reviewDecision                               # APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  commits(last: 1) { nodes { commit {
    oid
    statusCheckRollup { state }                # SUCCESS | FAILURE | PENDING | ERROR | EXPECTED
  } } }
}
```

**Cost.** GitHub GraphQL bills per query on a **node/point** model against a
5,000-points/hour budget, with a **floor of 1 point per request**. Single-node
lookups (`repository(owner,name)`, `pullRequest(number:)`, `statusCheckRollup`)
and a `commits(last: 1)` connection cost essentially the floor — so **~30–50 PRs
across arbitrary repos = ~1 point in 1 HTTP request.** A full sweep of, say, 150
tracked PRs is ~3–5 batched requests ≈ ~3–5 points. Even sweeping every minute is
~300 points/hour against a 5,000 budget — comfortable headroom, and the priority
tiers below keep the real number far lower.

Contrast with the current `gh pr list --head <branch>` path: one subprocess spawn
per directory/branch, each a separate REST-ish cost — fine for one selected
thread, prohibitive for background-polling 30 projects.

**This is the core reason to move known-PR polling in-process to Octokit GraphQL.**
The `gh` CLI has no batched cross-repo call; it's one invocation per branch.

---

## Recommended Architecture

### Two layers, different cadences

**Layer A — Targeted status poll (high frequency, cheap).** For PRs already in
the registry (we know `org/repo#number`), poll **by number** in batched aliased
GraphQL requests. This is the workhorse: it catches CI pass/fail, merge, conflict,
draft→ready, and title changes on PRs the operator cares about. Cost ≈ 1 point per
batch of ~40 PRs.

**Layer B — Discovery crawl (low frequency).** For each open repo, run the
ghcrawl-style delta list (`issues.listForRepo?since=<watermark>`, open + closed)
to find **new** PRs, PRs opened against branches we're on, and title/state changes
on PRs we weren't yet tracking. Runs on a slow cadence (e.g. every 5–15 min per
repo, staggered) because it's per-repo and pagey. Newly discovered PRs get folded
into the registry and thereafter ride Layer A.

Layer A answers "did anything change on the PRs I'm watching?"; Layer B answers
"did a PR I'm *not* watching appear or change?" Most operator value is in Layer A.

### Priority-tiered, round-robin scheduler (main process)

A single main-process scheduler (sibling to / inside `AppServerService`, modeled
on the existing `startWorktreeWorkingStateRefresh` refresh-tick pattern, not a
naive `setInterval` per PR) maintains a due-queue of tracked PRs bucketed by tier:

| Tier | Membership | Target cadence |
|---|---|---|
| **Focused** | PRs of the selected thread's project + on-screen/visible thread rows | ~60 s |
| **Warm** | Other threads/projects open in the current lens / recently active | ~2–3 min |
| **Cold** | Everything else with tracked, non-terminal PRs | ~5 min |
| **Terminal** | All cached PRs merged/closed | stop (one confirmation, then drop) |

Each scheduler tick: collect PRs whose `(now - lastPolledAt) >= tierCadence`,
sort by tier then oldest-polled, take up to `BATCH` (~40), group by nothing (they
can be cross-repo — that's the point), issue one aliased GraphQL request, diff,
persist, publish deltas. Round-robin falls out naturally from "oldest-polled
first within due set." Concurrency across batches bounded by
`@shutterstock/p-map-iterable` (already a dependency) so a big sweep doesn't
burst.

**Budget guardrails (reuse + extend what exists):**
- Reuse `PrStatusTokenBucket` as the global ceiling on scheduled fetches.
- Skip PRs already covered by an in-flight coalesced request.
- Respect the terminal short-circuit — merged/closed PRs leave the active set.
- Back off tier cadences when the window is unfocused/hidden (visibility signal),
  and pause background tiers entirely when `gh` reports not-logged-in or when a
  rate-limit backoff is active.

### The one genuinely new signal we need: polling focus

Today only `selectedThread` exists (renderer-side). To poll "the project the user
is looking at" faster than the rest, the renderer must tell main **which thread
rows are on screen / which project is focused**. Proposal: a lightweight
`pollingFocus` signal (selected thread key + set of visible thread keys from the
virtualized list, debounced) sent renderer→main, which the scheduler maps to Tier
membership. Everything else the scheduler needs (`prRefreshContextByThreadKey`,
the registries) already exists in main.

### Transition detection is already latent — make it explicit

The upsert path already diffs previous vs. new `number`/`state`. Generalize that
into a typed **`PrStatusTransition`** emitted whenever a meaningful field flips:

```
PrStatusTransition {
  key: "provider/org/repo#number"
  url, title, commitSha
  changed: {
    checkState?:     { from, to }   // e.g. pending → failing
    lifecycleState?: { from, to }   // e.g. open → merged
    mergeState?:     { from, to }   // e.g. mergeable → conflicting
    reviewState?:    { from, to }
    title?:          { from, to }
  }
  threadKeys: string[]              // threads this PR is associated with
}
```

Near-term, the only subscriber is the existing UI-update publisher. But making the
transition a first-class, well-shaped event is what lets the future CI-notification
feature (below) subscribe **without changing the poller** — and, critically, lets
us later swap the *source* of transitions from polling to real webhooks with no
change to consumers.

---

## Requirements

**Coverage & freshness**

- R1. Every open project's tracked, non-terminal PRs are refreshed on a recurring
  cadence, not only when their thread is selected or hovered.
- R2. The project backing the selected thread and any on-screen thread rows
  refresh on the fastest tier (~60 s target).
- R3. Other open/recently-active projects refresh on a slower tier (~2–3 min);
  the long tail refreshes slowest (~5 min), round-robined so none starves.
- R4. Merged/closed PRs drop out of active polling after a confirming fetch.
- R5. A newly opened PR against a branch the operator is on, and a title/state
  change on a watched repo's PR, become visible without operator interaction
  (discovery crawl), within the discovery cadence.

**Efficiency & budget**

- R6. A full sweep of tracked PRs must batch across disparate repos so that the
  request count scales with `ceil(trackedPRs / BATCH)`, not with `trackedPRs`.
- R7. Scheduled fetching is bounded by the existing token bucket and by bounded
  concurrency; a burst of due PRs cannot exceed the budget in one tick.
- R8. When the window is unfocused/hidden, background tiers slow down or pause.
- R9. On rate-limit or auth failure, the poller backs off (honoring
  `retry-after`/`x-ratelimit-reset`) and does not hot-loop; it resumes cleanly.
- R10. Polling produces **deltas only** on the push bus — unchanged PRs generate
  no renderer churn.

**Correctness & reuse**

- R11. Reuse the existing `PrSummary` model, sqlite caches, registries, and push
  bus; do not fork the data model or add a parallel IPC channel.
- R12. Known PRs are polled by `(org, repo, number)` (unambiguous), not by branch;
  branch-based lookup / discovery is only for finding *new* PRs.
- R13. Every meaningful field flip emits a typed `PrStatusTransition` on an
  internal signal, even though the near-term only consumer is the UI publisher.
- R14. Token acquisition continues to flow through `gh` auth (mint via
  `gh auth token` for the in-process client); no raw PAT storage is introduced by
  this change. (If a non-`gh` token path is ever wanted, the existing encrypted
  `desktop-secret-store` is the pattern — out of scope here.)

**Layering**

- R15. All GitHub I/O and scheduling live in the **main process**. The renderer
  contributes only the `pollingFocus` signal and renders snapshot deltas.
  `packages/shared` stays types-only; no octokit import crosses the renderer or
  leaf boundaries. (Dependency-cruiser boundaries are load-bearing — see root
  `CLAUDE.md`.)

---

## Future Direction (design only — not building now)

### CI/merge events as turn-starting inbound signals ("webhook-mimic")

The operator's stated north star: *"drive continuous-integration event
notifications into the threads, so that can be a source of starting a turn — 'hey,
CI passed / CI failed, evaluate it.'"*

The `PrStatusTransition` signal is the seam. A future subscriber — call it the
**CI event ingestor** — would:

1. Filter transitions to the interesting ones (e.g. `checkState → failing`,
   `checkState → passing` after a push, `mergeState → conflicting`,
   `lifecycleState → merged`).
2. Synthesize an **inbound thread event** shaped like a webhook payload (PR url,
   commit sha, failing check names + conclusions, run URL) and drop it into the
   associated thread(s) timeline.
3. Optionally **start a turn** (respecting existing automation/attention gates)
   so the agent can react — "CI failed on abc123: `test:unit` — investigate."

Design implications to preserve now, so this stays a drop-in later:

- **Shape the transition like a webhook.** Carry commit sha, per-check
  conclusions, and run/URL references so the future payload doesn't require
  re-fetching. (Layer A's fragment may need to widen from `statusCheckRollup{state}`
  to include individual `checkRuns` names/conclusions when this lands — flagged,
  not built.)
- **Source-swappable.** Polling is the pragmatic bridge; real GitHub App webhooks
  would be timelier and cheaper but need a public callback endpoint + app
  registration (the messaging HTTP-callback tunnel infra is prior art). Keep
  consumers bound to `PrStatusTransition`, not to the poller, so the source can
  become webhooks later with no consumer change.
- **De-dupe & debounce.** A flapping check must not spam turns; the ingestor needs
  idempotency keyed on `(prKey, commitSha, checkConclusion)` and a quiet period.
- **Respect automation policy.** Turn-starting must route through existing
  inbound-triggered-automation gates, not bypass them.

This subsection is a **non-goal for the current implementation** and exists to
make sure the poller's transition signal is built webhook-ready.

---

## Budget / Rate-Limit Math (sanity check)

- GraphQL budget: 5,000 points/hr; batched known-PR request ≈ 1 point / ~40 PRs.
- Suppose 30 projects, ~150 tracked non-terminal PRs total.
  - Focused tier (~10 PRs) @ 60 s: ~10 sweeps/hr × 1 batch ≈ ~60 points/hr.
  - Warm/Cold (~140 PRs) @ 3–5 min: ~15–20 sweeps/hr × ~4 batches ≈ ~60–80 points/hr.
  - Discovery crawl (REST, 30 repos) @ ~10 min, ~1–2 pages each ≈ ~360 REST calls/hr
    against the separate 5,000 REST/hr budget.
- Total well under both budgets, with room to raise cadences or project count.
- The token bucket + visibility backoff keep the *worst case* (all tiers due at
  once, window focused) inside budget.

---

## Open Decisions

1. **Transport for known-PR polling: in-process Octokit GraphQL (recommended) vs.
   extend the `gh` CLI path.** GraphQL batching is the whole efficiency argument;
   `gh` can't batch cross-repo. Recommendation: add `@octokit/graphql` in the main
   process for Layer A, keep `gh` for token minting and for the current
   on-selection detail fetch until parity is proven. Adds one dependency
   (main-process only).
2. **Backoff implementation: reuse octokit retry/throttling plugins (ghcrawl
   style) vs. hand-rolled wrapper (PwrGit style).** Plugins are less code but pull
   `bottleneck`; PwrGit avoided that. Decide based on whether `bottleneck`
   installs cleanly in this tree.
3. **Discovery crawl scope: all open repos vs. only repos with active branches /
   recent threads.** Bounding to repos the operator actually has threads in keeps
   Layer B cheap. Recommendation: only repos with at least one open thread/linked
   directory.
4. **`pollingFocus` granularity: selected-thread-only vs. selected + visible rows.**
   Visible-rows gives better "on-screen project" behavior but needs the
   virtualized list to report visibility. Recommendation: start with selected +
   its project on the fast tier; add visible-rows if it proves worth the wiring.
5. **Should Layer A widen the fragment to per-check detail now or later?** Only
   needed for the future CI-event feature. Recommendation: rollup-only now; widen
   when the ingestor is built.

---

## Scope Boundaries

**In scope (near-term):**
- Main-process priority-tiered background poller for tracked PRs (Layer A).
- Batched cross-repo GraphQL fetch, in-process, token via `gh auth token`.
- `pollingFocus` signal renderer→main.
- Typed `PrStatusTransition` emitted internally; UI updates ride the existing bus.
- Reuse of existing caches, registries, token bucket, terminal short-circuit.
- ghcrawl-style delta discovery crawl (Layer B) at low cadence — *may* be phased
  after Layer A if we want to ship the high-value piece first.

**Out of scope (this change):**
- CI/merge events starting turns in threads (designed above, not built).
- Real GitHub App webhooks / public callback endpoint.
- Per-check-run detail payloads (widen fragment only when the ingestor lands).
- Any new PR data model fields (the model is already sufficient).
- Storing a raw PAT / non-`gh` auth path.

---

## Reuse Map (file pointers)

**PwrAgent (this repo):**
- Data model: `packages/shared/src/contracts/navigation.ts` (`PrSummary`, enums,
  `buildPullRequestStatusKey`).
- Fetch/derive: `apps/desktop/src/main/pr-status/github-pr-fetcher.ts`,
  `pr-detection.ts`.
- Registries + orchestration + caches + push bus + token bucket + terminal
  short-circuit: `apps/desktop/src/main/ipc/app-server.ts`
  (`prStatusRegistry`, `prLookupRegistry`, `prRefreshContextByThreadKey`,
  `PrStatusTokenBucket`, `publishThreadPullRequestsUpdated`,
  `publishPullRequestStatusUpdates`, `startWorktreeWorkingStateRefresh` as the
  refresh-tick model to copy).
- Renderer trigger to fold in: `apps/desktop/src/renderer/src/features/pr-status/usePullRequestRefresh.ts`.

**PwrGit (`~/pwrdrvr/PwrGit`):**
- Token + GraphQL client + hand-rolled backoff: `apps/desktop/src/main/github/pr-client.ts`.
- Aliased batched query builder: `apps/desktop/src/main/github/pr-query.ts`.

**ghcrawl (`~/pwrdrvr/ghcrawl`):**
- Delta window + watermark: `packages/api-core/src/service.ts`
  (`deriveIncrementalSince`, `syncRepository`, `get/writeSyncCursorState`,
  `applyClosedOverlapSweep`).
- Octokit retry/throttling config + paginate + `listRepositoryIssues(state)`:
  `packages/api-core/src/github/client.ts`.
