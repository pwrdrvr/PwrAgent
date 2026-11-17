# Messaging controller split

PWR-149 starts from main `f5ce854b255650cba3a22eb6e4b741c0fdc3c53d`,
after the phase 5 observer extraction. PWR-149's controller limit is **5,000
lines**; it is stricter than PWR-142's 10,000-line controller limit. Historical
sizes and offsets in the Linear brief are not a source-code inventory.

## Reproducing the inventory

Run `node scripts/inventory-messaging-controller.mjs --output <directory>`.
The script uses the TypeScript AST and checker across desktop, owner-core and
messaging sources. Full records stay under `.local/pwr-149/`; stdout reports
counts. `--ref <revision>` reads changed sources through the compiler host
without changing working files. Baseline controller member names remain in
subsequent scans so a cast into a moved member cannot disappear from the audit.

The baseline contains 407 methods and 70 fields in the controller. The scan
examined 3,925 files, 41,108 effect/read/branch records, 19,567 references,
6,523 test-seam records, 483 construction/getter records and 36 checked
store/context/host declarations, with no syntax failures or warnings. These
are audit records, not counts of distinct behavioral dependencies: generic
names such as `deliver` intentionally include other owners for inspection.

Each effect has a source span, enclosing owner, branch ancestry, enclosing try
boundaries and resolved call/property declarations. Separate records retain
constructor wiring, inferred collection types, exact signatures, optional and
readonly properties, named and inline casts, spies, `Object.assign`, prototype
patches, plain-object stand-ins and reads inside catchable regions.

## Current ownership and extraction boundaries

| Concern | Owner and boundary |
| --- | --- |
| Backend events | `MessagingBackendEventRouter` now owns routing, pending failed-event deliveries, review pairing/deduplication, plan artifacts and markdown artifact selection. |
| Shared thread mutations | The existing Thread-State Update Bus remains the refresh source. Execution-mode apply still precedes queue-clear. |
| Messaging status | The controller still owns `activeTurnsByThreadKey`. Its callers include bus routing, accepted starts, pending-request reconciliation, queue steering and status rendering. A later PWR-149 PR replaces this with the explicit reducer. |
| Admission and draining | `MessagingTurnAdmission` still owns debounce/start admission and its duplicate queued-entry collection. The controller still owns drain requests, timers and pending drains. Retirement into `ThreadTurnQueue` remains required. |
| Private responses | `MessagingPrivateResponses` owns one discriminated state per turn and `transitionPrivateResponse` owns its changes. `MessagingPrivateReplyClaims` owns continuation request receipts, which are keyed by request ID rather than turn ID. The controller retains delivery effects and forwards state changes to these owners. |
| Bindings | The controller's existing `runDetachPipeline` remains the single detach pipeline. Its extraction belongs to the binding-service PR. |
| Commands, callbacks, inbound input and access | These remain controller-owned until their focused PWR-149 PRs. |

The event router receives only the collaborators it uses: a narrow store port,
clock, logger and lazy typed host. It never imports its facade. The facade
forwards events and failure-settlement requests. Its host functions resolve
current methods; shared-state getters resolve current collections. Store access
still reaches the current wrapped store at the original point in each method.
No collaborator is read during router construction. The same await, early
return, iteration, failure and cleanup boundaries remain in the moved methods.

At the first PR's head (`5a51525bcdc53ed873d68fa45ee9ecbb4adf3f5c`),
`--ref <head> --verify-router-move` compares all three moved method bodies to
the pinned baseline after reversing only the explicit port substitutions.
Behavior tests remain necessary: textual equivalence alone does not prove
that wiring supplies the right owner.

## Observable and mutation evidence

`messaging-backend-observable.property.test.ts` observes delivered assistant
text and provider activity through the real controller and SQLite store. Its
oracle comes from valid provider sessions: start, final item, terminal, with
redelivered final items/terminals, successful completion, failure, cancellation,
independent concurrent threads, three backend identities and several provider
capability profiles. It does not inspect controller maps or invoke production
normalization helpers to calculate expected results.

`messaging-backend-event-router.test.ts` exercises the actual new owner and
actual facade host ports. It checks construction laziness, replacement of a
host/store during an await, queue-outcome ordering, pending failed-delivery
settlement, unchanged exception identity, early exits and terminal cleanup
before activity and queue draining. Successful completion does not force an
automatic status card; interruption does. The helper suite separately checks
protocol terminal interpretation, final-output selection and owner identity.
The test-only `messagingModules` seam exposes owners and ports, not moved state
through private controller members. The baseline audit found no casts, spies
or overrides reaching the fields and routing implementation moved in this PR.

Run `node scripts/mutate-messaging-backend-events.mjs --baseline` to replay the
observable property against original-main production. Run the script without
flags for deliberate caller, host, awaited-effect, cleanup, queue and terminal
interpretation mutations. `--only <pattern>` selects a subset. A mutation counts
only when assertions fail; build, import, missing-owner and signature-bootstrap
errors do not count. Sources are restored in `finally`, and both protected
fixture hashes are checked. Full logs stay in `.local/pwr-149/mutations/`.

The original-main observable replay passes. All nine deliberate mutations fail
the intended assertions. Local protected verification passes 98 files and
4,744 tests; the full suite passes 2,042 files and 28,722 tests. Typecheck,
both Oxlint passes, dependency boundaries and Codex-storage lint pass. Both
protected fixtures remain byte-identical to the baseline. The controller is
23,399 lines after this first extraction; the new router, helper and context
files are each below 1,000 lines.

## Private-response state and production counterexamples

The next focused PR starts at main
`b54346c56247fef9e6ee8c925aad5ea37a37595c` after #3805 merged. The eviction
hypothesis is now confirmed through public controller calls and real SQLite
bindings, without seeding internal maps. A fallback visibly delivers, then
continuation persistence fails. The old wrapper restores fallback eligibility.
After 1,000 other private turns, terminal and attempt history have evicted the
old turn while its eligibility survives. Replaying its final item privately
delivers the body a second time. The property shrank to `[1000]` (seed
`284912773`, path `0:0`); the named regression retains that exact cardinality.

A separate scheduler counterexample shows a repeated final item publishing
the private body to the source while the first private delivery is unresolved
(baseline seed `733395119`). Both counterexamples fail assertions on pinned
pre-fix production. They are separate from the sequential observable oracle,
which passes both baseline and fixed production. All provider data is contrived.

The turn state uses `available`, `claimed`, `completed`, `fallbackHeld`,
`fallbackAttempted` and `terminal`. `available` represents an admitted origin
that has not requested private output. An explicit failed attempt completes
without suppressing source output. A fallback claim withholds source content
through its await and remains attempted after failure. Visible delivery is
terminal evidence, even if later source cancellation or continuation setup
fails. An explicit tool retry remains permitted; fallback cannot be claimed
twice. Completion routing is cleared at the original terminal-cleanup boundary.

Live origins and pending receipts cannot be evicted. Authoritative turn cleanup
retires a record; settled history is bounded at 1,000 entries in admission
order. A missing record cannot claim fallback. Held text is independently
bounded at 256 payloads in first-hold order, preserving the existing map policy;
evicting a payload retains its turn's claim evidence. Detach retains a live
origin until its terminal event, as before. Shutdown disposes both owners, and
generation receipts reject late effects without recreating records. Request
claims have their own `claimed | completed` reducer: failed admission or
cancellation releases its receipt; only completed requests can be evicted.

Run `node scripts/inventory-messaging-private-responses.mjs` for the checker
inventory and a pinned-baseline AST comparison. All 411 existing controller
and router methods retain identical ordered await expressions. The audit
records 1,095 private effect/read/branch records, two test seams and six ports;
the five turn collections are gone, and the request set is now its typed owner.
No private test cast or spy reached a retired collection. The test-only
`messagingModules` seam exposes the actual new owners.

Run `node scripts/mutate-messaging-private-responses.mjs --baseline` for the
baseline sequential oracle and both assertion-failing production
counterexamples. Without flags it checks 15 deliberate transition, bound,
receipt, ordering, caller and host-port mutations. `--only <pattern>` selects
one mutation. The script rejects bootstrap/import errors and timeouts as proof,
restores sources in `finally` and verifies both protected fixture hashes. Logs
stay under `.local/pwr-149-private/`. Run mutations separately from other checks
because they temporarily change production source.

Focused tests cover actual owner models, supported/unsupported resolvers,
successful/failed deliveries, repeated items/terminals, overlapping provider
responses and terminal cleanup, explicit retries, claim release, real history
and text bounds, detach and shutdown. Scheduler settlement uses `setImmediate`;
there are no property polling loops, retries or increased timeouts.

Private-state verification passes the required static checks, 100 protected
test files (4,852 passing tests, two skipped), and the full suite (2,062 passing
files, 28,882 passing tests, 107 skipped). Both protected fixtures are byte
identical to the pinned baseline. No test timeout required an isolation run.

## Remaining state-machine work

The turn/drain machine, canonical queue retirement, the five remaining named
extractions, controller size reduction and the parent's registry/test size
criteria remain tracked work. These focused PRs do not claim PWR-149 or PWR-142
complete. No registry activity/receipt ownership or notification concurrency is
changed. There is no new persistence, timer or filesystem access in production:
additional writes per event are zero, or **0 MB/day**. The turn-event recording
and SQLite budget fixture must remain byte-identical.
