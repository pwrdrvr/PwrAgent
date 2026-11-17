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
| Commands | `MessagingCommandHandlers` owns dispatch, schedule management, help, review entry and command routing for monitors, default Agents and Claude continuation. It delegates existing workflows through `MessagingCommandHost`. |
| Callbacks, inbound input and access | These remain controller-owned until their focused PWR-149 PRs. |

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
retires a record; settled history is bounded at 1,000 entries in settlement
order. The reducer emits `retainHistory` when a terminal turn has no pending
effects, including when its final delivery returns after the terminal event.
The owner appends that record to history then. Repeated terminal events do not
refresh history. A missing record cannot claim fallback. Held text is
independently bounded at 256 payloads in first-hold order, preserving the map policy;
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
counterexamples. Without flags it checks 17 deliberate transition, bound,
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

The review of #3810 exposed another production counterexample at head
`3a22f787cb0d92b21965f35a24048f9d888f1c05`: an older turn delivers privately
after 1,000 newer turns settle, then its own terminal cleanup immediately
evicts that fresh evidence in admission order. A repeated final item publishes
the private body to the source. The production property failed at `[1000]`
(seed `405300016`, path `0`); the independent FIFO settlement model shrank to
`deliver(old-1), finish(old-1), retire(old-1)` after history pressure. Named
regressions cover both finish/terminal orderings and source privacy. Run
`node scripts/mutate-messaging-private-responses.mjs --retention-baseline` to
prove both model and router assertion failures on that pre-fix owner. The two
additional mutations remove settlement recency or refresh replayed terminals;
both must fail assertions. No delivery effect, await or persistence is added.

Private-state verification passes 24 focused tests, the required static checks
and 100 protected test files (4,852 passing tests, two skipped). In the latest
full suite, 2,062 files and 28,887 tests passed, with 107 skipped and one
unrelated failure in `mcp-gateway-skills.property.test.ts`: 24,001 bytes against
its 24,000-byte limit. A seeded replay confirms that failure on unchanged
gateway code, and a separate handoff card proposes the fix to its existing
owner. Both protected fixtures are byte identical to the pinned baseline. No
test timeout required an isolation run.

## Command owner and observable protocol

The command extraction starts at main
`337cf083a1894aab6e6e8b5328c55b5a97411cde`, after #3810 merged. Twelve
methods move to `MessagingCommandHandlers`, with ten shared pure declarations
in `messaging-command-helpers.ts`. `MessagingCommandContext` names one store
operation, six optional backend operations, the capability profile, clock and
27 exact workflow ports. Construction reads none of these collaborators.
Adapter delivery and logging remain in the existing workflow owners because
the command methods do not use them directly. Host methods and wrapped store
overlays resolve at the original call sites, including after awaits.

Run `node scripts/inventory-messaging-commands.mjs --verify`. The checker audit
records 406 command effects/branches and 44 resolved references. Its 507 broad
test-seam candidates include backend mocks with similar method names; no test
casts or spies target the twelve moved facade operations. Verification compares
all moved bodies and helper declarations against pinned main, and checks every
retained controller method after reversing only caller/port substitutions.

`messaging-command-observable.property.test.ts` drives public controller input,
real SQLite bindings, a contrived accepting/rejecting backend and an adapter.
The oracle observes backend decisions before visible confirmations, invalid
input, mutation aliases, failure reporting and replacement store overlays.
It passes unchanged on pinned main and extracted production.

The actual owner model generates valid command sessions and access changes from
an independent policy table. Scheduler properties interleave separate command
permission continuations. Focused tests also cover provider action budgets,
late-bound stores/hosts, optional getter reads and receivers, exception identity
and awaited workflow effects. Pure helper properties cover aliases, units,
scope parsing, attribution and failure interpretation.

Run `node scripts/mutate-messaging-commands.mjs --baseline` for the pinned
production oracle, or omit the flag for extracted production and eleven
deliberate mutations. All eleven fail assertions: permission, scope exemptions,
dispatch, awaits, receiver binding, getter error boundaries, schedule payloads,
failed acceptance, facade callers, host ports and stale store capture. The
script rejects bootstrap/import/missing-owner failures as evidence, restores
sources after each mutation and checks protected fixture hashes. Logs stay in
`.local/pwr-149-commands/`; run this separately from other source checks.

The final base is main `6bfb1efff40106882e1dc82d9ee90e5662636aad`; its two
additional commits do not overlap the extraction. The controller falls from
23,420 to 22,568 lines. The command owner, helpers and context are 656, 240 and
48 lines respectively. Fourteen focused tests pass. Protected/focused
verification passes 106 files and 4,915 tests, with two skipped. All required
static checks pass, and both protected fixtures match pinned main byte for byte.

The full suite passes 2,082 files and 29,042 tests, with 107 tests skipped;
five tests fail in three files. Agent IPC, a messaging approval/queue protocol
and the auto-updater model time out at five seconds, followed by two
auto-updater staging assertions. All affected files plus the command owner
properties pass together in isolation: 719 tests, one skipped. The timeout
investigation is proposed to its existing owner in to-do card
`aebdc93f-1217-4f4d-b04f-d3e103c1ba9a`. No timeout, worker or concurrency
configuration is changed, and this PR does not claim the full suite passed.

## Remaining state-machine work

The turn/drain machine, canonical queue retirement, the four remaining named
extractions, controller size reduction and the parent's registry/test size
criteria remain tracked work. These focused PRs do not claim PWR-149 or PWR-142
complete. No registry activity/receipt ownership or notification concurrency is
changed. There is no new persistence, timer or filesystem access in production:
additional writes per event are zero, or **0 MB/day**. The turn-event recording
and SQLite budget fixture must remain byte-identical.
