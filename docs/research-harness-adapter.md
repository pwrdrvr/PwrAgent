# Research Harness process contract

Contributor reference for the optional Phase 2 adapter. Native research is still
the default. This adapter does not bundle or launch an Open Math OS deployment.
The investigated upstream revision is
`687f2a20dc6ff552d3c881e10910b46c13e84e2a` in `open-math-harness`.

## Ownership and scope

The local operator starts execution or imports an observed prefix from the
Research panel on a local Codex coordinating thread. PwrAgent owns the request
identity, journal, review records, workspace binding, settings, deadline and
cancellation disposition. External members are source identities, never invented
PwrAgent worker threads. Native assignments and revision delivery are disabled
for source observations. Local acceptance/rejection remains available.

## Research panel

**New run** opens one form. When the adapter is available, a switch chooses
PwrAgent workers or Open Math Harness. The Harness form starts with a **Bridge**
block from the owner's status read: the bridge executable's file name, the
execution model and endpoint origin, the model-credential variable's name and
whether it is set, and a reminder that MathOS Platform sign-in belongs to the
bridge. Credential values never reach the window. With no bridge configured it
shows an example `[research.harness]` table and **Show config.toml**, which
reveals the profile's own file; the window supplies no path. A config error is
shown as text.

**Check bridge** is an explicit owner request: it starts the configured bridge,
sends `hello`, closes it, and reports the advertised capabilities. It makes no
model call, creates no run and writes nothing. A thread without a directory is
checked from the temporary directory, because a check binds no evidence.

The operator picks one of three operations: **Import swarm records** and
**Snapshot a discovery run** are read-only and need only source IDs and an
optional title; **Run a new swarm** adds the objective, member limit, deadline
and an itemized model-budget acknowledgement. An operation the checked bridge
cannot perform, or execution without a model, endpoint or set credential,
explains why on its own card. The form names the canonical workspace that will
bind evidence and blocks early when the thread has none. A request ID is derived
from the request content: an unchanged retry reuses it, and any edit takes a new
one. Errors show the owner's own message.

A Harness run's chip follows the Harness state, not the native status the owner
uses to retire it: *Observing*, *Imported*, *Snapshot*, *Starting*, *Running*,
*Stopping*, *Stop unconfirmed*, *Stopped*, *Source ended*, *Reconciling* and
*Outcome unknown*. Run summaries carry only that `{state, mode, source}` phase,
selected in SQL so a discovery snapshot is never read for a list. Imports show
when they were observed instead of a deadline. An unknown outcome is one callout
with **Reconcile from source**; an imported swarm offers **Import newer records**.
**Source details** holds the IDs, record cursor, model, reported usage, evidence
root and protocol revision. Items show a compact `From m1 · #4` source tag whose
tooltip and accessible text carry the full receipt and digest.

The discovery view shows the reported state, solved count and usage, a problems
table, a score-by-round plot and an indented ancestry outline. The plot and the
outline use the same recorded node and parent IDs; selecting a point opens the
node's detail. The outline is the keyboard and screen-reader path, pages 25 rows
at a time, and places every recorded node once: a node whose parent is missing
starts its own branch and says so, and a recorded parent loop cannot recurse.

Version 1 covers swarm records and read-only discovery status, problems and a
selected problem's bounded tree. Running Lean verification remains the next
milestone. A source `solved` outcome, verification report or accepted verdict never
creates a PwrAgent review or formal-verification result.

`research.harness` is an additive, optional profile configuration section. The
internal configuration has `command` (absolute executable), literal `args`, and
optional `endpoint`, `model`, `api_key_env` (an environment-variable name).
No existing setting changes shape; no conversion or dual write is needed.
Configuration comes from the owner's watched config-store research domain and is
captured per connection. Invalid profile edits block new adapter use, including
when the store retains a last-known-good snapshot. A malformed argument list fails closed.
Neither model text nor IPC selects an executable, endpoint, model or workspace.
Execution requires the budget acknowledgement; imports and snapshots make no
model call and do not ask for it.
The form discloses the configured execution model and endpoint origin; the owner
retains that selection before paid probing, separately from any source model name.
Import never initializes or validates the model transport.
The bridge receives a minimal OS environment and no model credential. Production
operator setup documentation belongs in `pwrdrvr/docs.pwragent.ai`.

## Wire contract

The installed bridge exchanges UTF-8 JSON-RPC 2.0 lines over stdio. Stdout is
protocol-only. Frames are bounded to 512,000 bytes; requests time out after
30 seconds, with at most sixteen outstanding. Bridge callbacks use string IDs;
owner requests use numeric IDs. Callback identities cannot be replayed within a
connection. Stderr is drained without copying it into the research journal.

| Owner method | Parameters / result |
| --- | --- |
| `hello` | `{version: 1, upstreamRevision}` → `{version: 1, upstreamRevision, import, execute, cancel, researchFunctions?}`. Versions and the upstream revision must match. Capabilities must be explicitly true. |
| `execute` | `{version: 1, runId, project, session, swarm, objective, workers, deadlineAt}`. The bridge must bind this identity and these limits before admission. A lost response is not retried. |
| `records` | `{project, session, swarm, after, limit: 50}` → the upstream `RecordsResponse`: `{swarm, records, next?}`. Records carry their original `seq` and `at_ms`. |
| `discovery.status`, `discovery.problems`, `discovery.tree` | `{project, run, problem?}` → upstream discovery v6 snapshots via UI `runs.status`, `runs.problems`, `runs.tree`. Explicit `discovery: true` capability is required; discovery execution is unavailable. |
| `cancel` | `{runId, project, session, swarm}` → `{runId, swarm, stopped: true}` only after the exact run's owned work stopped. A request being accepted, a disconnected socket or a bridge process exiting is insufficient. |

The bridge's `model_complete` callback accepts `{messages}`. PwrAgent selects the
endpoint and model and supplies only ordinary `research_read` and
`research_update` functions on every request. The bridge must implement those
functions against its authenticated run/member service; `researchFunctions: true`
asserts that dispatcher exists. `research_update` proposes a finding or candidate,
never a review or an ownership change. Never advertise this capability without a
dispatcher, or bypass Harness's service grants or member confinement.

Execution requires cancellation capability and two actual compatibility calls:
a nonce-bearing ordinary function call, then consumption of its tool result.
There is no model listing, native tool-search request, deferred schema loading,
implicit endpoint selection or assumed tool capability. Imports skip the model
adapter entirely. Probe calls spend model budget. The owner fences new model
calls at cancellation/deadline; remote cancellation still requires acknowledgement.
Tokens/dollars remain unknown, source call counts are partial observations, and
there is no hard spend cap. Provider billing may continue for an in-flight call.

`scripts/research-harness-ui-bridge.mjs` implements observation against an
explicitly authorized **unlabelled development UI socket**, using the actual
upstream `{id, op: "swarm.records", ...}` / `{id, ok}` envelope. It advertises
neither execute nor cancel. Labelled/platform links and authorized execution
require a separately installed bridge; the window API cannot start/stop/judge a
swarm. The full runtime still requires its Linux/bubblewrap/deployment environment.
The reference script is supplied in this repository, not installed as a packaged
runtime. The desktop ships the adapter and loads only an explicitly configured bridge.

The reference bridge also maps `status` to `swarm.status`, and discovery reads to
the actual UI `runs.*` operation names. A discovery import retains status, all
returned problem rows, and optionally one problem's tree. It makes no model call
and has no source start/stop control. The source tree's `truncated` flag is visible;
its missing suffix is never invented or treated as a continuation cursor.
Snapshot provenance explicitly identifies an owner observation ordinal/time,
because these APIs provide no source event sequence. Raw bounded responses and
their hashes are retained alongside normalized values in one transaction. The
graph and paged list use the same recorded node/parent identities. Source-reported
verification remains separate from a PwrAgent verification target or review.

## Normalization and recovery

The owner records schema version, upstream revision, project/session/swarm,
original sequence/time, member/direction and canonical-record SHA-256. Every
record has a retained observation, including unknown additive variants. Directions,
findings, submissions and member execution states also project into native items.
Source verdicts are observations, preserving independent local review history.
After local acceptance, the operator can explicitly complete a retained import
or ended execution. Completing an import does not request source cancellation.

A service page is at most fifty records and 256,000 JSON characters, with a
16,000-character record bound. The complete page is validated before one atomic
append of its normalized events and cursor. Gaps, conflicting duplicate records,
foreign origins, members the `started` record did not name, and escaping paths
are refused. Exact duplicate pages write nothing.

Members come from the source. The `started` record, always sequence 1, names every
member of the swarm, so the existing `records` reply carries the count and the
protocol version is unchanged. Execution declares the operator's member slots
before dispatch, because the bridge binds that limit, and refuses a `started`
record that names more. An import has read nothing when it is created, so it
declares no slots and a limit of `RESEARCH_MAX_WORKERS` (64). When `started`
arrives, each named member takes the next slot, `a1` onward, through one
`members` event in that page's commit; a source naming more than 64 is refused.
An import created before this rule declared eight slots and keeps that limit;
its unused slots are marked stopped, as before. Run summaries and replay read a
run's limit from its creation event through `researchWorkerLimit`. The run card
shows an import's member count without a limit, and execution's against the
operator's. A continuation cursor must match the observed prefix. The
native 100,000-event guard stops a runaway journal; receipts and cancellation remain
available at that guard. Empty polling does not persist state.

Evidence remains relative to the canonical local workspace captured by the owner
at admission. The main process rejects traversal, absolute paths, root replacement
and escaping symlinks. A remote path is never opened on the viewer's filesystem.
This does not fetch remote artifacts: the operator must have the originating
project mounted at that workspace.

Intent is durable before launching or dispatching. A timeout, lost execution
response, unknown cancellation, malformed page or owner loss retains an unknown
outcome. An unacknowledged cancellation is recorded as `unresolved: "cancel"` in
the Harness state, so it survives the owner rewriting the run's status on
restart. No execution or cancellation is blindly retried. Reopening never starts
the bridge or a model request. A late page cannot resurrect a stopped run.

A process that dies writes no unknown boundary. The next launch retires the run
as interrupted, but its last Harness state still says `pending` or `running`.
`researchHarnessEffectiveState` treats that pair as `unknown`: the run chip,
the outcome callout, the run list's attention group and reconcile eligibility
all read it, so a dead run never shows as running and can always be reconciled.

**Reconcile** is an explicit, read-only import into the same run from its stored
cursor. It applies to `unknown`, `stopping`, `imported` and stale `reconciling`
swarm runs; a discovery snapshot has no cursor and takes a new snapshot instead.
It is refused for a non-coordinator, while this process still holds the run's
connection, and for a run another process holds. Holding follows
`researchRunHeldBy`: a run's own process, or any later process once a Harness
run is no longer live and the process that started it is gone. A native
PwrAgent run is different: it outlives its process and is taken over, still
running, by the next one. The same rule lets the
operator review and finish a retained import or ended execution after a
restart; cancelling still needs the process that holds the bridge. The
`reconciling` intent commits before the bridge starts. The bridge must advertise
`import`; the owner sends only `hello` and `records`, never `execute` or
`cancel`. Each page commits with its cursor under the same validation as a live
page, at most twenty pages per reconcile. Only the source's own `ended` record
settles the outcome: it sets `ended`, clears `unresolved`, and turns a
still-`stopping` run into its requested terminal status. Otherwise an execution
stays `unknown` and an import returns to `imported`, with a note giving the
records read. A bridge failure or shutdown restores the prior outcome and keeps
the records already committed.
Shutdown aborts model calls, drains pending requests and awaits bounded termination
of the owned bridge process tree. This says nothing about remote work stopping.

## License review

The upstream repository is Apache-2.0; its full deployment includes separately
licensed dependencies and Codex notices. This change independently implements
public wire shapes and ships no upstream source, runtime, images, Rust crates,
model weights or new npm dependencies. First-party MIT and existing disclosures
remain intact. Vendoring or distributing any Harness material requires another
dependency/disclosure review; the upstream top-level license alone is insufficient.

`node scripts/research-harness-wire-oracle.mjs /path/to/pinned/checkout` is an
offline, development-only conformance check. It builds a temporary oracle using
the upstream interface crates and their existing MIT/Apache-2.0 serde dependencies,
and checks the contrived fixtures with the actual Rust deserializers. It neither
copies upstream source into this repository nor installs a shipped dependency.

## Verification and persistence budget

Generated lifecycle commands compare dispatch/cancel counts and lifecycle against
an independent model over real SQLite. Oracles exercise the actual process and
socket envelope, split frames, malformed frames, process exits, a loopback Chat
Completions server, the two-call probe and an external execution fixture. These
are contrived fixtures, not evidence of a deployed Open Math OS service or a paid
hosted-model run. Electron fixtures show source provenance, unconfirmed cancellation
and a source-accepted candidate still awaiting local review.

`research-harness-members.property.test.ts` generates source swarms of 1 to 64
members over real SQLite. An import admits exactly the members its source names
and attributes each record to its member's slot; execution keeps the operator's
limit; gaps, conflicting duplicates, foreign origins, escaping paths and unnamed
members are refused at every size. Before this rule it failed on its first run,
shrunk to a nine-member import.

The adapter follows the native incremental research contracts. Run summaries omit
source state; the selected run receives it with its change pages, and source item
provenance travels on the changed item. Admission, cancellation, model callbacks
and source redelivery checks read headers, bounded items and indexed source
receipts rather than replaying the journal. A real SQLite oracle forbids replay
on those paths and checks the source indexes across a 1,000-record journal.

Mutation checks removed each lifecycle fence independently. The late-record oracle
then observed `exhausted` instead of `stopped`; the late-probe oracle observed an
`execute` after cancellation. Both failed with exit 1 and pass with the guards
restored. The malformed-argument oracle also failed before the config parser was
made to reject unsupported Harness values instead of skipping them.

The checked-in SQLite budgets measure the feature after database setup:

| Boundary | Commits | Observed WAL bytes |
| --- | ---: | ---: |
| Eleven-record completed import | 4 | 156,592 |
| Sixty-four-member import: two pages and the ended boundary | 5 | 486,192 |
| Six-record source page and cursor | 1 | 70,040 |
| Fifty repeated pages | 0 | 0 |
| Confirmed cancellation | 2 | 78,280 |
| Execution admission with model provenance and an initial source page | 4 | 185,432 |
| Changed Harness configuration revision | 1 | 4,120 |
| One thousand adapter configuration reads | 0 | 0 |
| Discovery status/problems/three-node tree import | 3 | 98,912 |
| Repeated discovery request identity | 0 | 0 |
| Reconcile: intent, one seven-record page with cursor, settled outcome | 3 | 131,840 |
| Bridge capability check (`hello` only) | 0 | 0 |

At one six-record page per minute across the owner, the measured rate is
`(1/60 commits/s) × 70,040 bytes/commit × 86,400 s = 100.86 MB/day`,
or 8.40 MB over one run's maximum two hours. The source-state and source-receipt
indexes add WAL pages while preserving the commit, statement and row budgets.
Their two extra pages also add 8,240 bytes to the daily compaction fixture
(1,483,232 bytes total), with the same two commits: approximately 0.00824 MB/day
of additional maintenance WAL at one compaction per day.
Idle polling and token streaming add zero writes. Four imports/hour at the measured
size add approximately 15.03 MB/day. Declaring members adds rows, not commits:
the `members` event and one item per member ride in the page that carries
`started`. An eleven-record import has one more row than when it pre-declared its
slots, and a discovery snapshot one fewer, since it no longer declares an unused
slot. A 64-member import is 5 commits and 394 rows; four of those an hour add
`4 × 24 × 486,192 bytes ≈ 46.67 MB/day`. WAL bytes vary with payload/page layout and
are recorded, not asserted; commit/statement/row budgets fail in either direction.
Configuration reads add zero MB/day. One configuration edit/hour at the measured
commit size adds approximately 0.10 MB/day through the existing config snapshot.
Four explicit discovery imports/hour at the measured three-node fixture size add
approximately 9.50 MB/day; there is no background discovery polling or per-node
commit. Larger bounded snapshots cost more WAL bytes in the same three commits.
Reconcile is an operator action, not a timer: four per hour at the measured size
add `4 × 24 × 131,840 bytes ≈ 12.66 MB/day`, and each additional page adds one
commit. Bridge checks and status reads add zero. The `observedAt` and
`unresolved` fields ride in Harness state events that were already committed, so
no existing budget's commits, statements or rows changed. Run-list summaries read
the Harness phase through the existing indexed state subquery and write nothing.

## Milestone acceptance

`research-performance.spec.ts` measures native Electron navigation with 1,000
contributions across ten recorded worker identities over the lifetime of a run,
while retaining the eight-concurrent-worker admission limit. The initial checked
gate is 2,000 ms for opening Research, 2,000 ms for finding and opening the last
contribution, and 64 MiB of incremental renderer JS heap. Every run attaches its
measurements as JSON, including failures. These are fixture performance budgets;
deployed model execution and source-service compatibility require separate evidence.

The production authorized execution bridge and deployed Harness acceptance remain
outstanding. The authenticated MathOS Platform probe below establishes access to
the deployed runtime, but that deployment's window API does not expose the
execution/cancellation or discovery operations required for Phase 2 acceptance.
The read-only UI bridge cannot acquire those capabilities. Passing fixture tests
or upstream wire deserialization does not establish live execution, remote
cancellation, or hosted-model compatibility.

The opt-in `research-harness-live.integration.test.ts` accepts a private JSON
configuration path in `PWRAGENT_TEST_HARNESS_ACCEPTANCE_CONFIG`. It requires the
explicit bridge configuration, canonical workspace, persistent private state
directory and stable acknowledged request identity. Ordinary unit/CI runs skip it.
It runs the real process/model adapters, requests scoped stop after active
execution, and retains a digest-only result alongside the private journal. Reusing
the request identity never replays an unknown start. A failed or interrupted
acceptance run requires source reconciliation before any new identity is used.

### Authenticated Platform compatibility probe — 2026-11-17

The operator-supplied **MathOS Platform API Key** authenticated both platform
metadata and the runtime's `whoami` operation. This credential was never used
against the OpenAI-compatible model API. A contrived project named
`PwrAgent contrived Harness acceptance 2026-11-17` was created once, with a
durable local intent before dispatch and an HTTP 200 confirmation. There was no
retry of project creation. No model work was started.

The [sanitized probe evidence](research-harness-platform-compatibility-2026-11-17.json)
records runtime version `0.58.0`, IPC version `6`, and its reported bundle hash.
The deployed Git revision is unknown; the investigated upstream revision remains
the bridge contract pin, not a claim about the deployed bytes. The evidence omits
credentials, runtime tickets, account/team/project identifiers and private content.

Platform metadata uses HTTPS `POST /v1/<operation>`. Runtime operations instead
use the ticket returned by `open` over WebSocket
`/v1/runtime/<environment>?ticket=<ticket>`, subprotocol `agent-vm-runtime-v1`,
and binary UTF-8 JSON lines. The public web client's transport established this
distinction; HTTPS 404 responses for runtime operation names did not establish
their availability. The authenticated probe used the existing `ws` dependency;
no dependency or runtime was added to distribution. `open` used `wake: false`.

The probe then established these narrower facts:

- `swarm.status`, scoped to the contrived project/default session, was recognized
  and returned `invalid_input: this session has started no swarm`.
- `runs.list`, scoped to that project, was rejected as an unknown operation. The
  runtime's reported handles contained no discovery endpoint, and its parser's
  enumerated operations contained no `runs.*` operation.
- That same enumeration exposed only `swarm.status` and `swarm.records` for
  swarms. Although a reported swarm handle included `stop`, the window dispatcher
  exposed no `swarm.stop` or `swarm.start`. A handle alone is insufficient evidence
  of a callable operation. No mutation was attempted to test that absence.

This is an authenticated compatibility result, not a successful live acceptance
run. There were no source records to import in the new project, and no hosted
function-calling, execution, reconnect or remote-cancellation acceptance was
performed. A conversation/session stop is not evidence that one exact swarm's
owned work has stopped. Starting an agent with prompt-only worker/deadline limits
would not satisfy the owner's admission contract either.

Completing Phase 2 requires an authorized deployment/service path that exposes
bounded execution, the small research-function dispatcher and exact-run stop
acknowledgement, plus a deployment exposing the required discovery reads. That
path must preserve the service grants and member confinement. A window credential
must not be relabelled or used to fabricate those grants. Once available, run the
existing opt-in acceptance scenario with explicit model configuration and a
stable request identity. Until then the PR remains a draft and Phase 2 remains
incomplete. The temporary credential file and in-memory probe processes were
removed after this probe.
