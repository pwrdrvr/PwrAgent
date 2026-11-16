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
foreign origins, unknown members and escaping paths are refused. Exact duplicate
pages write nothing. A continuation cursor must match the observed prefix. The
native 4,096-event limit bounds journal growth; receipts and cancellation remain
available at that limit. Empty polling does not persist state.

Evidence remains relative to the canonical local workspace captured by the owner
at admission. The main process rejects traversal, absolute paths, root replacement
and escaping symlinks. A remote path is never opened on the viewer's filesystem.
This does not fetch remote artifacts: the operator must have the originating
project mounted at that workspace.

Intent is durable before launching or dispatching. A timeout, lost execution
response, unknown cancellation, malformed page or owner loss retains an unknown
outcome. No execution or cancellation is blindly retried. Reopening never starts
the bridge or a model request. A fresh explicit read-only import can reconcile
the source without replaying work. A late page cannot resurrect a stopped run.
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

Mutation checks removed each lifecycle fence independently. The late-record oracle
then observed `exhausted` instead of `stopped`; the late-probe oracle observed an
`execute` after cancellation. Both failed with exit 1 and pass with the guards
restored. The malformed-argument oracle also failed before the config parser was
made to reject unsupported Harness values instead of skipping them.

The checked-in SQLite budgets measure the feature after database setup:

| Boundary | Commits | Observed WAL bytes |
| --- | ---: | ---: |
| Eleven-record completed import | 4 | 156,592 |
| Six-record source page and cursor | 1 | 57,680 |
| Fifty repeated pages | 0 | 0 |
| Confirmed cancellation | 2 | 74,160 |
| Execution admission with model provenance and an initial source page | 4 | 156,592 |
| Changed Harness configuration revision | 1 | 4,120 |
| One thousand adapter configuration reads | 0 | 0 |
| Discovery status/problems/three-node tree import | 3 | 111,272 |
| Repeated discovery request identity | 0 | 0 |

At one six-record page per minute across the owner, the measured rate is
`(1/60 commits/s) × 57,680 bytes/commit × 86,400 s = 83.06 MB/day`.
Idle polling and token streaming add zero writes. Four imports/hour at the measured
size add approximately 15.03 MB/day. WAL bytes vary with payload/page layout and
are recorded, not asserted; commit/statement/row budgets fail in either direction.
Configuration reads add zero MB/day. One configuration edit/hour at the measured
commit size adds approximately 0.10 MB/day through the existing config snapshot.
Four explicit discovery imports/hour at the measured three-node fixture size add
approximately 10.68 MB/day; there is no background discovery polling or per-node
commit. Larger bounded snapshots cost more WAL bytes in the same three commits.

## Milestone acceptance

`research-performance.spec.ts` measures native Electron navigation with 1,000
contributions across ten recorded worker identities over the lifetime of a run,
while retaining the eight-concurrent-worker admission limit. The initial checked
gate is 2,000 ms for opening Research, 2,000 ms for finding and opening the last
contribution, and 64 MiB of incremental renderer JS heap. Every run attaches its
measurements as JSON, including failures. These are fixture performance budgets;
deployed model execution and source-service compatibility require separate evidence.

The production authorized execution bridge and deployed Harness acceptance remain
outstanding until an accessible, authorized Linux/Open Math OS composition is
provided. The read-only UI bridge cannot acquire those capabilities. Passing
fixture tests or upstream wire deserialization does not establish live execution,
remote cancellation, or hosted-model compatibility.

The opt-in `research-harness-live.integration.test.ts` accepts a private JSON
configuration path in `PWRAGENT_TEST_HARNESS_ACCEPTANCE_CONFIG`. It requires the
explicit bridge configuration, canonical workspace, persistent private state
directory and stable acknowledged request identity. Ordinary unit/CI runs skip it.
It runs the real process/model adapters, requests scoped stop after active
execution, and retains a digest-only result alongside the private journal. Reusing
the request identity never replays an unknown start. A failed or interrupted
acceptance run requires source reconciliation before any new identity is used.
