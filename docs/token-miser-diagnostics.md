# Token Miser diagnostic evidence

This contributor reference describes PwrAgent-owned diagnostic samples. The
additive `experimental.token_miser_diagnostics_enabled` boolean defaults to
false. Its desktop control is in the Token Miser experimental section. Capture
also requires the global Token Miser experiment. Disabling it clears unwritten
samples; existing files remain until rotation or local deletion.

The collector uses live hook acknowledgements, retrieval accounting, and Codex
App Server notifications. It never reads Codex rollout files or databases.
Only completed `agentMessage` items explicitly marked `phase: "commentary"`
are retained as narration. Unknown phases, final answers, reasoning items, and
user messages are excluded. Unphased hook `parent_intent` text is excluded too;
only the verified commentary events supply narration. Tool content can still
contain sensitive data.

## Storage and write budget

Files live at the active profile's
`state/token-miser/diagnostics/<runtime-instance-id>.jsonl`. Directories are
created with mode 0700 and files with mode 0600. Instance-specific names avoid
concurrent append and rotation collisions.

The diagnostic ring is separate from the exact-output retrieval cache. It has
an 8 MiB estimated memory budget (encoded event bytes multiplied by three for
JavaScript overhead), at most 32 events per thread, and a 4 MiB serialized queue.
Observation windows seal after 90 seconds, 12 following tool actions, turn end,
or memory eviction. Long detected bursts emit continuation records before ring
eviction so their following actions remain linked.

A 30-second timer appends the queued JSONL records in one batch. Turn end only
queues data; it does not append or fsync. Shutdown drains producers before the
final batch. Idle timers make no filesystem writes. The maximum sustained rate
is one append per 30 seconds (2,880 per day); bytes depend on sampled activity,
with a 4 MiB batch ceiling. There are no new SQLite writes. An abrupt process
exit can lose unwritten evidence.

Each instance rotates an 8 MiB active file and two backups. Cleanup retains at
most 24 diagnostic files across instances in the profile directory, removing
the oldest other-instance files first. Evidence is a bounded rolling sample,
not an archive. Queue eviction and failed batches increment loss counters;
diagnostic failures do not change tool delivery.

## Records and analysis

Each line is a version-1 `token_miser_chain`, containing a capture ID, thread ID,
backend, observed provider/model/reasoning/service tier, source object ID,
classification, window reason, and ordered events. Missing provider metadata is
explicitly `unknown`; other unavailable fields are omitted. Event context comes
from the last accepted gate, rather than an extra pricing read per event.

Gate events contain the before output, delivered summary, structured helper
summary, helper usage, parent baseline tokens, and original/replacement byte
counts. Summarized gates enter the collector only after their delivery proposal
is acknowledged. Discarded or unacknowledged proposals are excluded. A
pass-through gate references the before output as its delivered content.

Before output is capped at 64 KiB; other tool results, inputs, and summaries at
8 KiB; narration and individual grouped inputs at 4 KiB. Oversized fields retain
head/tail text, original byte count, an explicit omission marker, and SHA-256.
Code Mode groups retain up to 64 invocation identities. These files cannot
reconstruct content omitted by clipping, an upstream tool, or an unsupported
protocol. Group/member IDs link captured nested calls to accepted group gates.

The observational categories are:

- `summarized_no_recovery_observed`: a candidate saving; absence of a recovery
  does not establish correctness or operator satisfaction.
- `passed_through`: a candidate no-help case, including helper pass-throughs.
- `recovered`: confirmed model-visible retrieval followed the summary.
- `suspected_retry_burst`: at least three subsequent calls from the same tool
  and command family within 45 seconds of a summarized gate. Ordinary polling
  tools are excluded. Exact input repeats are counted separately. This heuristic
  does not establish that Token Miser caused the repeats.

Ordinary categories select the first and every eighth window per category.
Detected bursts bypass that sampling filter, subject to the same memory and
queue bounds. Join records by `burstGroupId` and order events by `sequence`;
continuation records omit already recorded events in that burst. Tool identity
and command-family hashes use full input even when its saved excerpt is clipped.
Different burst groups may share context events.

`retrieval_attempt` events distinguish full-source, partial-source/search, and
focused-summary requests. `retrieval_delivered` events report confirmed byte
deltas, cumulative delivered bytes, and focused-summary bytes. A request for all
content alone is not proof that all content arrived. Failed or expired retrievals
remain attempts unless delivery is confirmed.

Reviewers should compare the original and summary against the subsequent
commentary and actions, then label helpful summaries, missed material, and
unproductive retries. Use the existing accounting ledger for financial results.
Final-answer correctness and operator complaints require separately authorized
thread review because those messages are intentionally absent from this capture.
