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
| Bindings | `MessagingBindingService` owns creation, metadata, preferences, status surfaces, the render lock, name sync, audits and the single `runDetachPipeline`. The facade keeps the public boolean revoke entry point. |
| Commands | `MessagingCommandHandlers` owns dispatch, schedule management, help, review entry and command routing for monitors, default Agents and Claude continuation. It delegates existing workflows through `MessagingCommandHost`. |
| Callbacks | `MessagingCallbackHandlers` owns callback dispatch and its entry methods. `MessagingCallbackHost` delegates retained workflows and reads existing queue/private-response owners lazily. |
| Inbound input | `MessagingInboundTurns` owns text/media admission, preparation, startup, prompt buffers and timing, through lazy ports. |
| Access control | `MessagingAccessControl` owns the actor-ID set, admission, capability and federation gates, retained-source/tool authorization, and Full Access policy/warnings. Public authorization methods remain facade delegates. |

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

## Callback owner and observable protocol

The callback extraction starts at main
`55b5bff62dbcf3250a253f1a2026ba61a110b1d3`, after #3823 merged. Nineteen
methods move into `MessagingCallbackHandlers`; 58 shared declarations move to
`messaging-callback-helpers.ts`. The context has 15 store operations, eight
backend operations, two optional adapter operations, capability profile, clock,
logger and 116 exact workflow/data ports. Backend operations reached through a
local alias or the launchpad helper are included. The adapter getter continues
to read the facade's current adapter, including its shutdown stub.

Run `node scripts/inventory-messaging-callbacks.mjs --verify`. The checker audit
records 1,552 effects/branches and 43 resolved references. Two broad test-seam
candidates are an unrelated contained-tool stand-in and the explicit command
host fixture; neither calls a moved operation through the facade. Verification
checks moved bodies and declarations, retained methods, fields and helper
bodies, original constructor order, all host ports and lazy context getters.
No module imports the facade. The test-only `messagingModules` seam exposes the
actual callback owner and its host ports.

`messaging-callback-observable.property.test.ts` drives real controller input
with SQLite bindings, pending proposals and provider-visible deliveries. It
covers stale approval surfaces, permission denial, replay, backend acceptance
before proposal retirement, independent callbacks during an in-flight submit,
help navigation through delivered controls, provider action budgets, shared
provider stores and replacement overlays. It passes unchanged against pinned
original main and extracted production. The actual-owner callback model covers
access changes and status ordering; focused tests cover construction laziness,
host/store replacement after awaits, exception identity and the stale-notice
error boundary. Pure properties cover identity, risk payloads, reply-option
bounds, help payloads and provider preference isolation.

Run `node scripts/mutate-messaging-callbacks.mjs --baseline` for the original
production oracle, or omit the flag for extracted production and 15 deliberate
mutations. All 15 fail assertions. The first oracle missed a dropped submit
await; the acceptance-boundary assertion was strengthened, then both baselines
and all mutations were rerun. `--check` checks mutation anchors; `--only` selects
a case. Sources are restored after every mutation and protected fixture hashes
are checked. Logs stay in `.local/pwr-149-callbacks/`; run mutations separately
from other source checks.

A separate same-timestamp counterexample fails on both original and extracted
production: two live approval cards share `createdAt`, and clicking the most
recently delivered card submits nothing. It shrinks to `[2]` (original seed
`34413503`, extracted seed `80586874`). That semantic fix is proposed in
standalone to-do `13a3246b-29b9-4c5a-b004-ce1573f432d7`; it is outside this
move-only extraction. The intended oracle gives strictly newer persisted
proposals different clock values. The counterexample and its restoring probe
remain separate from that oracle.

The final base is main `a2a1ef72ea66038504a64bceb2bc75ea652948f4`;
its three additional commits do not overlap this extraction. The controller
falls from 22,568 to 19,371 lines. The callback owner, helpers and context are
2,349, 1,006 and 146 lines respectively. Fifteen focused tests and all required
static checks pass. Protected/focused verification passes 118 files and 4,978
tests, with two skipped. Both protected fixtures match the current main base
byte for byte. Main added a merge-queue SQLite budget row after the pinned
callback baseline; this extraction preserves that upstream addition.

The full suite passes 2,093 files and 29,139 tests, with eight files and 107
tests skipped. It exits nonzero with one unhandled renderer teardown error:
Tiptap's deferred editor destruction reads `window` after the environment is
gone in `composer-named-providers.test.tsx`. That file passes all six tests in
isolation. Its sources and dependencies are unchanged by this extraction.
Follow-up card `af6e2338-5b96-43d6-bec0-f05c97400888` proposes investigation to
the existing Composer owner. The earlier timeout paths do not fail in this
run. No timeout, worker, concurrency or teardown policy is changed here.

## Binding owner and observable protocol

The binding extraction starts at main
`9e8826a71db9f97c1cb1edf6a033d22872cb753a`, after #3832 merged.
`MessagingBindingService` receives 24 methods and the existing status-render
lock. Eight shared declarations move to `messaging-binding-helpers.ts`.
Its context has 12 store operations, three backend operations, one optional
adapter operation and 20 workflow/data ports. All collaborators and the two
optional configuration values resolve lazily through the original configuration
object. The clock port calls the facade's clock lazily with its original
receiver. The optional audit getter remains
outside its method-call catch, and the adapter method keeps its original
receiver. The facade's public revoke method preserves its boolean return.

Run `node scripts/inventory-messaging-bindings.mjs --verify`. The checker audit
records 440 effects/branches and 142 resolved references. Two actual private
facade tests now call the binding owner through `messagingModules`. The six
remaining broad seam matches are unrelated stand-ins or explicit workflow host
fixtures. Verification checks moved bodies, helper declarations, retained
callers and fields, lock ownership, public delegation, constructor order, every
host port, lazy clock call and context/configuration getter. No new module imports
the facade.

The eight observable tests use real controller entry points and SQLite. Their
independent session model covers bind, replacement, metadata, status, command
detach and UI revoke. Additional protocols cover pinned retirement, provider
isolation, failed best-effort work, optional name-sync capability, replacement
store overlays, a late normal render after revoke, and replacement-adapter
routing when shutdown interrupts a name-sync read. They also check native clock
and configuration callback receivers and optional getter reads. These assertions
failed on the initial extraction; the corrected ports preserve the original
object and call receivers. The observable oracle passes
pinned original main and extracted production.

The owner suite checks construction laziness, late host/store replacement,
optional getter boundaries and receiver binding, remote admission, awaited
detach failures and the shared status lock under scheduler-controlled renders.
Pure helper properties check whitespace and breadcrumb order, targeted owner
projection, handoff identity and observed branch precedence.

Run `node scripts/mutate-messaging-bindings.mjs --baseline` for the original
oracle, or omit the flag for extracted production and 19 deliberate mutations.
All 19 fail assertions. `--check` verifies anchors; `--only` selects a case.
Three initial probes also caused missing-clock errors or a timeout and did not
count. The snapshots were narrowed to one collaborator and the delivery probe
was directed to a test that can observe the missing effect without waiting on
it. The complete oracle and mutation run was repeated. Sources restore in
`finally`; protected fixture hashes are checked. Logs stay under
`.local/pwr-149-binding/`; do not run mutations alongside other source checks.

A separate counterexample holds **retirement**, before the normal render. A
public `/status` command pauses while retiring its old surface, UI detach
commits a revoke, and late retirement restores the binding from its stale
record. Both original and extracted production fail assertions. Run
`node scripts/mutate-messaging-bindings.mjs --retirement-counterexample` to
replay both paths independently of the intended oracle. The first clean paired
replay used seeds `-2016786528` and `1504060681`, path `0`. Standalone card
`0e360f1d-4301-406b-8196-6d2729db231e` tracks the semantic fix; this extraction
preserves the current production behavior.

The final base is main `358fd7736dad52f32e98f693fd97a67cae236ac8`, whose
additional commit fixes an unrelated approval-property fixture and teardown.
Both private-test migrations are preserved on that current test owner.

The controller falls from 19,381 to 18,245 lines. The binding owner, helpers
and context are 985, 129 and 49 lines respectively. Eighteen focused tests,
all required static checks and the main-function bytecode check pass. The
largest measured function is 23,846 bytes against the 25,600-byte budget.
Protected/focused verification passes 122 files and 5,000 tests, with two
skipped. Both protected fixtures remain byte-identical to current main.

The final full suite passes 2,097 files and 29,166 tests, with eight files and
107 tests skipped; one federation resumable-blob model times out at five
seconds. Its nine-test file passes in isolation, and the exact printed seed
`1494783974` passes an isolated replay. The blob production and test sources
are unchanged. Card `41ed7f56-1d31-4342-a395-5380d981f147` proposes the new
evidence to its existing native-suite owner. The final full run is not reported
as passing. No timeout or concurrency setting is changed.

## Inbound owner and observable protocol

The inbound extraction starts at main
`c7219ed95c1d7f70f10fd6648eb65e7317857cfc`, after the binding service merged.
`MessagingInboundTurns` receives 40 methods, the admission timing map and the
two pending-prompt maps. Forty-three shared declarations move to
`messaging-inbound-helpers.ts`. The controller remains the public event router.
The turn admission queue, turn liveness, queue notices and drain scheduling
retain their existing owners for the later state-machine change.

Run `node scripts/inventory-messaging-inbound.mjs --verify`. Its TypeScript
checker records 159 resolved method references, 1,105 effects/branches, 12
store operations, ten backend members and 45 host ports. Contextual adapter
analysis also records the attachment processor's complete adapter signature;
the inbound context needs only its required structural members and optional
download operation. The audit retains casts, overrides, spies and stand-ins,
including field accesses. The one direct facade prompt-buffer cast now targets
the actual inbound owner through `messagingModules`.

Verification checks every moved signature and body, shared declaration,
retained caller, retained field and helper, constructor order, both staged
cleanup operations and each host port. Store, backend, adapter, capability,
logger and configuration resolve lazily. Configuration retains the original
object and callback receiver. The clock calls the facade's clock with its
original receiver. Optional PDF-support getters keep their original catch
boundary; attachment downloads keep their native receiver. No new module
imports the facade.

The independent observable protocol runs through real public controller entry
points and SQLite. Its valid command model covers text/media requests,
started/queued/failed acceptance, completion/failure/cancellation and repeated
terminal evidence for both owner-queue and legacy backends. Other protocols
cover provider mention capabilities, conversation response mode, Full Access
resume policy, typing before acceptance, post-acceptance failures, replacement
overlays after awaited reads, optional metadata failures, default Agents,
recoverable new-thread prompts and remote owner identity. The final nine-test
oracle passes pinned original production and extracted production.

The owner tests cover construction laziness, replaced hosts after permission
awaits, failed private-claim retry, permission/scope denials, optional getter
exceptions, metadata effect ordering, native download/configuration/clock
receivers, timing consumption and cardinality, coalescing and shutdown cleanup.
The timing generator always crosses the 256-entry bound. Pure properties cover
explicit slash arguments, bare mention commands, affirmative private-response
language, target-specific missing-thread evidence and in-memory routing state.

Run `node scripts/mutate-messaging-inbound.mjs --baseline` for the pinned
observable oracle, or omit the flag for extracted production and 22 deliberate
mutations. Every mutation fails an assertion, including gates, acceptance,
claim retry, effect order, cardinality, lifecycle callers and lazy/native ports.
`--check` verifies anchors and `--only` selects a subset. Missing-owner errors,
import failures and timeouts do not count. Sources restore in `finally` and
protected fixture hashes are checked. Logs stay in `.local/pwr-149-inbound/`;
do not run mutations alongside other source checks.

The final tested base is main
`1025a96c3cdba8ca430beeec31a9101f6bd692b4`, including the later property-owner
and blob-receiver teardown fixes. Its messaging production sources are
unchanged from the pinned extraction baseline. Main also added two CI-run
write-budget rows in #3840; this change preserves the current fixture exactly.

The controller falls from 18,245 to 15,307 lines. The inbound owner, helpers
and context are 2,349, 542 and 92 lines. Original method and helper comments
move with their declarations. All required static checks and the bytecode
check pass; the largest measured function is 23,846 bytes against the
25,600-byte budget. Protected/focused verification passes 179 files and
5,561 tests, with two skipped, including every current SQLite-budget caller.
Both protected fixtures remain byte-identical to the final main base.

The full suite passes 2,104 files and 29,274 tests, with eight files and 107
tests skipped. Five tests reach their five-second deadlines: selection
publication, the held-updater model, private-response history, listing overlay
reads and quit-dialog default action. Those five files pass together in
isolation: 51 tests in 11.65 seconds. No fast-check seed is printed by the
timeouts. Their sources are unchanged by this extraction; an isolated pass
does not establish the cause. Card `a2e8dc7e-2b4b-4b9d-a7d5-a9a9806d7ae9`
proposes the retained evidence to the existing native-suite investigation
owner. `.local/pwr-149-inbound/full-timeouts.json` records the cases and raw
log hashes. The full run is not reported as passing, and no timeout, worker,
retry, concurrency or property-bound setting is changed.

## Access-control extraction

The access-control baseline is current main
`709b770acae5cc800b78074f41b5180e3219bfa0`, after inbound PR #3865.
`node scripts/inventory-messaging-access.mjs --verify` inventories 25 moved
methods, the actor-ID set, three shared declarations, six host ports, four
store members and two optional adapter methods. Its checker resolves callers
and records branches, awaits, returns, mutations, exception boundaries and test
seams. The broader `inventory-messaging-controller.mjs` audit retains complete
read, construction and cast records. Both leave full evidence under
`.local/pwr-149-access/`.

`MessagingAccessControl` owns admission, additive RBAC resolution, silent reply
floors, federation scope, retained-source authorization, dynamic-tool checks,
and Full Access policy/warnings. The facade keeps its three public delegate
signatures. The host exposes only delivery, pending-intent creation, intent IDs,
activity logging, channel scope and read-only origin lookup. Store, adapter,
configuration, logger, capability profile and host are read at call time. Actor
IDs are copied at the original constructor position. The owner does not import
the facade or read live collaborators during construction; it has no backend
port because these operations make no backend calls.

The audit reverses only the explicit port substitutions and checks every moved
signature/body and helper, every retained caller, state ownership, public
wrappers, construction order and native clock/host ports. The old contained-peer
test's prototype patch is replaced with a real controller, SQLite binding,
persisted human request and provider/policy collaborators. Remaining similarly
named gateway/runtime mocks target their public service boundaries, not moved
controller members.

The independent observable projection covers valid admission/policy commands,
reply acceptance, atomic policy reads, silent denials and auditing, tool fields,
explicit peer scope, lifecycle grants, retained provider approval interleaved
with revocation/rebinding, provider isolation, ambiguous attribution and a real
Default Agent turn. Its expected results come from declared permission grants,
provider outcomes and current binding identity rather than access-owner state.
Owner tests cover lazy replacement across awaits, error/getter boundaries,
remote render probes, Full Access double gates and effect order, warning expiry,
and native callback/clock/delivery receivers. Pure helper properties cover
explicit false controls and presentation precedence.

`node scripts/mutate-messaging-access.mjs --baseline` replays observable tests
against the pinned original controller, including the inbound protocol and
contained-peer model. The default mutation run checks transitions, ordering,
store/host capture, facade ports and callers. A timeout, import error or missing
owner cannot count as a detected mutation. Sources are restored in `finally`,
and both protected fixture hashes are checked. No production bug is inferred
from a brief hypothesis in this move-only extraction.

The final observable replay passes 16 tests against original production; the
focused extracted-owner run passes 17. All 27 deliberate mutations fail
assertions, with no invalid proof from a timeout or missing owner. The remote
tool-scope property includes inspection-granted cases so it reaches the extra
scope gate. Held provider callbacks record observations and settle before the
test asserts them, so a broken argument cannot strand a fixture waiter.

The controller falls from 15,298 to 14,692 lines. The access owner, helpers and
context are 654, 37 and 35 lines. Typecheck, both Oxlint passes, boundaries,
Codex-storage lint and the main bytecode check pass. The largest production
function is 23,834 bytes against the 25,600-byte budget. Protected verification
passes 184 files and 5,597 tests, with two skipped, including all 101 current
SQLite-budget callers. Both protected fixtures are byte-identical to the
pinned current main. Additional writes are zero, or **0 MB/day**.
The full suite passes 2,127 files and 29,434 tests, with nine files and 108
tests skipped, in 231.53 seconds. It reports no failed tests or unhandled errors.

## Remaining state-machine work

The turn/drain machine, canonical queue retirement,
controller size reduction and the parent's registry/test size
criteria remain tracked work. These focused PRs do not claim PWR-149 or PWR-142
complete. No registry activity/receipt ownership or notification concurrency is
changed. There is no new persistence, timer or filesystem access in production:
additional writes per event are zero, or **0 MB/day**. The turn-event recording
and SQLite budget fixture must remain byte-identical.
