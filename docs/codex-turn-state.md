# Codex turn activity

PWR-147 replaces the activity representation used after registry split phase 3.
Its baseline is main `93caf4eb0a9f1868c26014fb8dfab281e7592892`, including
the runtime supervisor extraction in #3775. The event hub remains in the
registry; this work does not change the phase 2 event recording or SQLite
write budgets.

## Inventory and ownership

Run `node scripts/inventory-codex-turn-state.mjs` after selecting the repository's
Node version and installing its dependencies. The script writes its complete
TypeScript AST and checker inventory under `.local/pwr-147/inventory/` and
prints counts. Use `--output <directory>` to retain separate inventories.
Use `--assert-retired` on the final tree; string names in the retirement test
and historical review card metadata are allowed, activity identifiers are not.
It examines collection declarations, reads and mutations, construction ports,
module hosts, callers, inline and named casts, spies, object overrides,
prototype stand-ins, object stand-ins, aliased operation writes, and the
optionality of properties on the intersected context and source store types.
It also inventories module constructor contexts and marks reads inside
`try` blocks, including paths whose missing-owner errors could be caught.

The initial baseline scan examined 3,990 TypeScript files and found 621 activity
and entry-point references in 37 files, with no syntax failures. Construction
getters and host declarations expose a capability; they do not constitute a
second owner or prove that the capability is shared by providers.

| Baseline owner | State | Meaning |
| --- | --- | --- |
| Registry | `reservedCodexStartThreadIds` | Admission held across turn preparation, review start, compaction, revert, voice catalog preparation and managed worker start. Voice borrows an existing reservation without releasing it. |
| Registry | `activeTurnKeys` | Started notifications and explicitly registered accepted turns, across Codex, Claude and ACP. Deletion synchronously notifies quit/restart waiters. Global insertion order is observable. |
| Registry | `activeCodexTurnModes` | Execution-mode ownership, including accepted starts whose notification is absent. A mode can be unresolved while its notified turn is already registered. |
| Registry | `activeCodexTurnCollaborationModes` | Request collaboration policy, distinct from execution mode. It exists before synthetic start and transfers to the real turn. |
| Registry | `codexRetryableOperations` | Identity of a turn/compaction request, its correlated turn ID, early terminal receipt, and compaction lifecycle receipt. An accepted compaction owns activity until terminal delivery even without `turn/started`. |
| Registry | `backendActiveCodexThreadIds` | Provider activity recovered through reads/lists, including turns not started by this owner. It is distinct from local ownership. |
| Registry | `observedCodexThreadStatuses` and sequence fields | Local/provider observations override older list rows. The high-water mark survives acknowledgement of an observation, so delayed reads remain stale. |
| Registry | `activeCodexReviewTurnKeys`, `activeCodexReviewInterruptTurnIds` | Native review's outer turn and the separately notified inner turn. Interrupt routing and terminal cleanup require both correlations. |
| Registry | `startingTurnOrigins` | In-flight causal authorization before the origin row is persisted. It serves Codex, Claude and ACP and is not itself a busy signal. |
| Managed review service | `pendingReviewStarts` | Scheduled review requests, idempotency history, invocation rebinding, synchronous claim before an awaited start, and final admission outcomes. It serves all providers. |
| Managed review service | `pendingReviewTerminals` | Per-start terminal evidence armed before the provider call. The response can identify a different thread, so evidence cannot be restricted to the request's original thread. Its lifetime ends with that start call. |
| Managed review service | `activeReviewSubAgents` | Live native/managed review ownership. The parent and child can use different providers and thread IDs. |
| Managed review service | `reviewSubAgentsByReviewTurn` | Review card metadata retained after completion for output and usage attribution. Historical metadata is distinct from live ownership. |
| Managed review service | `managedReviewParentsByChildThread` | Attribution installed while creating the managed child, before its turn response and live review record exist. |

The supervisor, managed reviews and sub-agent monitor mutate activity through
their late-bound hosts at baseline. Forge reads collaboration policy; workspace
and directory services read execution mode; the usage ledger reads registered
turns. Construction belongs to `backend-registry-wiring.ts`. Modules never
import the registry or retain host/store ports during construction.

## Terminal ownership counterexample

The tech brief's `codex-turn-mode-leak-race` was fixed by #3593,
`20e4c47c0e764601921cede3d5accaaed7378d93`. Its regression test is
`codex-turn-terminal-ordering.property.test.ts`. The subscribed production
notification listener is invoked concurrently, as the transport invokes it.
All protocol data is contrived.

The bad schedule is:

1. `turn/started` registers the turn and awaits execution-mode bookkeeping.
2. The same turn's terminal notification removes its ownership.
3. The earlier mode read returns and writes execution-mode ownership again.

Terminal ownership must dominate the delayed continuation. The finished turn
must contribute neither busy state, registered keys, execution-mode ownership
nor collaboration ownership. Native reviews require the same property for
both their outer response ID and their inner notified ID.

On the baseline, all five terminal-ordering tests pass. Running
`node scripts/mutate-codex-turn-state.mjs --legacy` against that baseline
temporarily removes the production
late-mode guard, runs the scheduled property through the production listener,
requires an actual property assertion failure, and restores the source in
`finally`. The baseline proof failed with the completed/default/no-placeholder/
terminal-before-mode schedule (seed `1535462570`, path `0:0`). This seed is
evidence, not a seed pinned in CI. Mutation logs are under
`.local/pwr-147/mutations/`.

The counterexample is recorded separately from the compatibility oracle:
today's buggy output with the guard removed is never an expected projection.

An earlier window remained on main `93caf4eb0`: the event hub awaits managed
review forwarding and message-context bookkeeping **before** registering the
started turn. A terminal can finish during those awaits; the continuation
then registers both provider activity and mode ownership after termination.
The same ordering can occur before `emit`, in the listener's awaited headless
lifecycle work.

`prove-codex-turn-bookkeeping-race.mjs` proves the first window against the
unmodified pre-phase-4 registry and extracted modules. Create a separate
worktree at the baseline, install its own frozen dependencies, then run
`node scripts/prove-codex-turn-bookkeeping-race.mjs <baseline-worktree>` from
the implementation checkout. The script transplants the two contrived
production-listener tests and their gate helper, retains the baseline's old-map
oracle, and restores the test in `finally`. Build, import and missing-owner
errors cannot count as a proof. The observed counterexample was
`["turn/completed", true]` (seed `638428955`, path `1`), with `true` holding
start bookkeeping until terminal delivery finishes. Both the named example
and the property failed. Evidence is retained under
`.local/pwr-147/baseline-bookkeeping-red.*`.

## Activity value and transitions

`RegistryTurnState` is built once by the composition root and exposed as
`RegistryContext.turnState`. Its Codex map stores one `CodexThreadActivity`
per thread. The pure `transition` function is the only writer of that value.
There are no mutable Codex collection views. Query results are projections.
Live review membership is indexed by child backend and thread. Child lookups
and the owner-wide listing expose immutable snapshots in activation order.
Pending child attribution is keyed by child identity. A terminal visits only
parents with open start requests to retain evidence for an as-yet unknown
child. Unobserved idle listing rows do not allocate
activity records; sequence fences and request/history evidence are retained.

| Phase | Required evidence | Admission projection |
| --- | --- | --- |
| `idle` | Status high-water mark, request receipts, causal origins and review admission history can remain. | Available. |
| `reserved` | Request owner and operation kind, or the owner of an accepted compaction. | Busy; ignoring a start reservation does not ignore an accepted compaction. |
| `started`, execution | Primary turn ID and execution mode; all owned turns retain their individual correlations. | Busy. |
| `started`, provider | Provider status is active, including discovered turns without a local ID. | Busy. |
| `started`, registration | A notified turn has its registration receipt but not mode/provider ownership. | Registration alone did not contribute to the old Codex admission predicate; it still contributes to running-turn and shutdown projections. |
| `started`, review | A live native or managed review owns its parent; the record identifies the child's provider, thread and turn. | Busy. |
| `terminating` | Registered ownership has ended while execution-mode cleanup remains; turn ID and mode are retained. | Busy until that ownership is released. |

Each turn also has typed preparation, notification, accepted or terminating
ownership. This preserves multiple native review IDs, collaboration policy
before a response, and acceptance without a started notification. It does not
guess identities from separators when accepting a provider result: production
callers pass thread and turn identities explicitly. Canonical key strings
remain available for existing iteration and correlation consumers.

A start-delivery receipt is captured before the notification listener's first
await, or by `emit` for an owner-generated start. A matching terminal retires
that receipt even when registration has not happened. The continuation checks
it before committing activity; disposal runs in `finally`. Native review
admission can correlate an inner delivery that has not registered yet, so
retiring the outer review also retires that pending inner delivery.

Retry receipts distinguish active work, active work retained by an awaiting
request, and settled work still retained by that request. Binding and terminal
updates copy the receipt through the reducer. Releasing the request disposes
settled evidence without resurrecting work. Causal origins similarly retain a
request identity and an immutable bound value until their existing persistence
boundary. A competing reservation never receives the current owner's release
token.
Binding copies only the returned thread and turn IDs, preserving the original
backend and causal authority. Managed-child lookup similarly returns parent
metadata without its internal lookup key; the explicit new child identity
always wins when a provider returns a different thread.

Status observation identity and its sequence high-water mark remain distinct:
acknowledging a list row must not make an older read authoritative. Independent
insertion ordinals preserve provider membership, registered-turn, mode, review
and interrupt order without secondary mutable Codex indexes.

## Shared data and boundaries

Claude and ACP registration and causal-origin state remain separate from the
Codex activity map, inside the same owner used by shared readers. Their existing
registration/deletion behavior is preserved. Shared review admission uses the
same reducer and keeps provider identity explicit; non-Codex review data cannot
enter the Codex map. The process-wide voice lease count and app restart gate
remain registry-owned because neither is per-thread Codex activity.

Historical review card metadata remains with `ManagedReviewService`, including
the shared usage metadata updated by the sub-agent monitor. It does not decide
whether a review is live. Only the union's live-review membership owns that
answer. The remaining aliased writes in the inventory are that usage metadata,
the non-Codex branch of origin binding, and a deliberately invalid test request;
none mutates Codex liveness outside the reducer.

Modules read the context owner at call time. No new registry host operation is
needed; the existing host inventory and exact construction-port parameter
checks remain exhaustive. Tests obtain the owner through
`registryModules(registry).turnState` or use `registryContextStandIn` when
constructing a module directly. Context store getters still use the same
wrapped overlay store with their original optionality.

## Model and mutation proof

`codex-thread-activity.property.test.ts` compares valid ownership sessions with
the intended legacy collection projection after every transition. It covers
turn, compaction, revert, voice catalog, agent/catalog and worker reservations,
accepted starts without notifications, native review IDs, delayed mode reads,
duplicate starts/terminals, stale status reads and observation acknowledgement.
The two known bad schedules above are separate counterexamples.

`registry-turn-state.property.test.ts` checks the real composition root's public
admission predicate and construction host ports, provider and turn iteration
order, full placeholder identities, receipt cleanup, scoped process exits and
review admission outcomes. It also checks retirement of the old identifiers
in normal CI. The existing managed-review admission model now exercises the
new owner, and its generator reaches its stated sequence bound.

The production-listener properties use gates and fast-check scheduling to
cover terminals before registration, during mode lookup, during review start,
and while a review's inner delivery is pending. There are no polling waits,
longer timeouts or serialized test lanes. All fixtures are contrived protocol
data.

Run `node scripts/mutate-codex-turn-state.mjs` for the final mutation sweep;
`--only <pattern>` replays a subset. Mutations cover reducer guards, request
ownership, status fences, review terminal evidence, pending inner review IDs,
listener ingress, caller routing, host ports, wiring identity and subscriber
commit order, metadata field isolation and immutable-view invalidation. Each
must fail an assertion; build/import errors and missing-owner
TypeErrors do not count. Sources are restored after each attempt and both
protected fixture hashes are checked. Logs and per-mutation results go to
`.local/pwr-147/mutations/`.

The state owner adds no persistence, timer or filesystem access. New SQLite
commits per event are zero, so incremental write volume is **0 MB/day**. The
phase 2 recording and checked-in SQLite write budgets remain byte-identical;
their tests and the full unit suite are required verification for this change.
