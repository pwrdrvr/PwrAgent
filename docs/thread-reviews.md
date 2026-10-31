# Thread review tracking

Completed code reviews are attention records in the profile's `state.db`.
An open review appears alongside questions, approvals, and ordinary cards in
To-dos, including the thread and project counts. Review artifacts remain in
the transcript after resolution or dismissal.

Each record has a stable review id, source artifact key, owning backend and
thread, findings, status, creation and last-update timestamps, and optional
source URL and workspace/PR provenance. Findings have stable ids and their own
status, last update, and resolution. A resolution records its reason, optional
HTTP(S) evidence link, actor, and date. A deferred finding's resolution also
names the to-do card that tracks it, by id and its title at the time.

The stored text is capped excerpts kept so To-dos and the agent tools work
without the transcript. The transcript's review card renders from its own
entry and reads only state from this table. This is a documented exception to
[thread-history-persistence.md](thread-history-persistence.md#tracked-review-findings).

## Finding outcomes

One vocabulary names a finding's outcome in the agent tools, their results,
the transcript, the To-do card, and this document. Each name says what was
done:

| Status | Meaning | Requires | Label |
| --- | --- | --- | --- |
| `open` | Still waiting on work. | Nothing. | No label; **Select**, **Fix now**, **Decline**. |
| `addressed` | Fixed. | A note on what changed; a commit or PR link when there is one. | **Addressed** |
| `declined` | Will not be fixed. | A note giving the reason. | **Declined** |
| `deferred` | Left for later, on a to-do card. | The card's `todoId` from `add_todo`, and a note on why it waits. | **Deferred**, with the card's title |

A deferral must name a to-do card that the same thread raised; the tool
refuses any other id. That keeps the work on the operator's list after the
finding leaves it. The repository's "Deferred work" rule in `AGENTS.md` gives
such a card a `send_message` action when an existing thread owns the work,
or a `start_thread` action for new work. Both carry a prompt that stands
alone. A message proposal names `target: { backend, threadId }`, plus
`instanceId` for a remote owner and a `title` for the destination preview.
The operator can change the destination and inspect the prompt before
clicking **Send request**. Existing start-thread cards also offer
**Send to thread…** in their action menu; selecting a destination never sends.

`update_review_item` also accepts other names. `dismissed` is the older name
for declined. Claude Code's code review reports `fixed`, `no_change_needed`,
and `skipped`, and treats all three as settled. `fixed` means addressed. The
other two mean declined: `skipped` is Claude Code's "real but not applied".
The tool keeps its name: a second name for the same tool would put two
entries in the catalog for one action.

Builds before this vocabulary stored a declined finding as `dismissed`. Each
open of the state database renames those in place, in its one schema
transaction; a profile with none left writes nothing. Reads also rename any
that an older build sharing the profile writes later. Over federation, a
peer's reviews are renamed as they arrive, and the Decline control sends
`dismissed` for a finding, which an owner of every version accepts. An older
viewer of a newer owner shows a declined or deferred finding as settled but
without its new label.

Reviews are `open`, `handled`, or `dismissed`. Settling the last open finding
automatically handles its review. An agent cannot mark a review handled while
findings are still open. It can then document the whole outcome with a final
note and link. Reopening a finding reopens the review. Whole-review dismissal
overrides its findings without overwriting their individually recorded
outcomes. The transcript labels the review and each of its findings
**Dismissed**, and reopening restores the findings that were still open.

## Agent tools

The shared dynamic-tool and MCP catalog exposes four thread-scoped tools:

| Tool | Purpose |
| --- | --- |
| `record_review` | Track external or manually written findings using a stable `sourceKey`. |
| `list_reviews` | Read reviews and findings with ids and resolutions; defaults to open. Use `status: "all"` to inspect dismissals. While a finding is open, the result carries `guidance`: work on findings only when the operator asks, and settle each one as addressed, declined, or deferred with `update_review_item`. |
| `update_review_item` | Settle a finding as `addressed`, `declined`, or `deferred` (with `todoId`), or reopen it, with a `note` and optional `url` documenting the outcome. |
| `update_review` | Dismiss, reopen, or document a handled review with a `note` and optional `url`. |

The trusted calling context supplies backend and thread identity. An agent
cannot inspect or mutate another thread's review by passing its id. Reusing a
source key returns the existing record and never reopens settled findings.

## Import and the queue

Final native and managed review events are imported automatically. Tracking
starts once per profile, with a persistent timestamp shared across instances
and restarts. Startup does not scan stored artifacts. Thread reads can recover
reviews dated at or after that boundary; older or undated history stays in the
transcript and does not become pending work. Undated live completions can be
tracked because the completion event establishes that they are new.

Records distinguish automatic imports from explicit `record_review` calls.
An automatic PR review appears in the active queue only while that exact PR
(host, organization, repository, and number) is attached to its owning thread.
Detachment does not change its outcome or erase the artifact. Reattaching
restores eligible open work. Explicit records do not depend on attachments.

The To-dos list also checks the complete local owner navigation index for
every card. Archived and absent owners are excluded even if no archive event
was observed by this process. An overlay alone does not establish that a
thread is active. The same read projects the current owner title, so a valid
thread outside the sidebar's loaded window keeps its name. All cards share
one cached owner index read, and the projection makes no SQLite writes.
Provider discovery and authentication recovery refresh the full To-do list,
so eligible cards return when their owners become available without requiring
a separate card mutation.

Attachment filtering applies to queue reads. Full review status reads
(`status: "all"`) retain detached records for the transcript and agent tools,
including partial resolutions, evidence links, and remaining review controls.

The initial tracking implementation (#2685) imported historical reviews without
provenance or an observation timestamp. Untouched generic legacy imports are
excluded from lists, preserving their stored records and transcript artifacts.
Even their creation date cannot prove eligibility: undated artifacts used the
import time. Records with documented resolutions, explicit provenance, an
external source URL, or a custom title are preserved. An old explicit record
with the same generic title and no URL is indistinguishable from an import;
calling `record_review` with its source key explicitly enrolls it again,
preserving its finding ids and outcomes. No historical finding is declared
fixed or declined by this correction.

Structured reviews with no findings are handled immediately. Unstructured
output that cannot be parsed remains open for explicit inspection and handling.
Archiving a thread dismisses its open reviews with a recorded system reason.

The renderer's `ThreadTodosPanel` accepts a `ThreadTodoFilter` through its
`filter` prop. It independently selects `questions`, `approvals`, `reviews`,
and `todos`; omitted categories remain visible. MCP input and questionnaires
are questions; MCP approvals are approvals. A card proposing **Start review**
is an ordinary To-do card; a completed review awaiting resolution is a review.
The same predicates filter scope counts and resolved rows. No filter picker
is introduced in this change.

## Claude Code reviews

PwrAgent sets `CLAUDE_CODE_REPORT_FINDINGS=1` for the Claude CLI. This
declares that the host renders typed findings. Claude Code then runs
`/code-review` inline and reports through its `ReportFindings` tool. Without
the variable, the CLI forks the review into a subagent and returns only a
rendered text list as `local_command_output`, and the SDK stream carries no
structured findings.

The Claude backend turns each `ReportFindings` call into a review entry, not a
tool row, and publishes it as `exitedReviewMode`, so the import above tracks it.
It waits for the call's tool result: the CLI validates the input first, and the
model retries a rejected call, so a rejected call stays a failed tool row and
only the accepted retry becomes the review.
A finding's short summary is its title. Its body holds the full summary, the
failure scenario, and the category and verdict when present. Claude reports
no priority, verdict, or confidence, so findings keep the reported order,
render as `P?`, and the card's verdict follows from whether any finding was
reported. Provenance resolves the way a native review's does: the workspace,
its checked-out branch, and the attached pull request on that branch.

After `--fix`, or when later work fixes findings, Claude reports the same
findings again with an `outcome` on each one. That re-report does not create a
second review. The backend pairs it with the latest Claude review in the thread
by location and title, then by location, then by position when both lists have
the same length. Position alone pairs only within the review's own turn; a
later turn's report must also match one finding's location. It publishes
`thread/review/outcomesReported`. Tracking marks `fixed` findings addressed
and `no_change_needed` and `skipped` findings declined, with the agent as the
actor, in one commit. That matches Claude Code, which counts all three as
settled. Each note names the reported word ("Addressed automatically: the code
review reported it `fixed`."), so an agent reading `list_reviews` can tell an
automatic outcome from one it recorded. A reported outcome never overrides an
outcome already recorded for that finding. An
outcome report that matches no earlier review is recorded as a new review with
those outcomes. The checked-in `thread-review-reported-outcomes` budget
measures one commit per settling report (~8 KB WAL, about 0.8 MB/day at 100
reports per day). Repeats make no commits.

A `skipped` finding is real, and the report gives no reason for it. A
`PostToolUse` hook on `ReportFindings` (`claudeReportFindingsHooks`) therefore
adds context to the tool result when a report has any. It lists them (ten at
most) and says they were recorded as declined with no reason. It tells the
agent how to defer one worth doing later to an `add_todo` card, or document a
decline, through `update_review_item`. A report without `skipped` findings
gets no added context.

## Controls

An open review's To-do card lists its findings, open ones first by priority,
four rows before **Show N more**. The head counts settled findings of the
total, the way a card with steps does, but a finding row has no box: a tick
there would read as "done" on one card and "include" on the other. A row
shows only its priority and title at rest. Hovering it, or moving focus into
it, raises its chips. An open row offers **Select**, **Fix now**, and
**Decline**; a settled row reads **Addressed**, **Declined**, or **Deferred**
and offers **Reopen**. Declining is a final outcome the agent can see in
`list_reviews`, not a hidden row. The head's dismiss control dismisses the
whole review, and the stack's **Undo** reopens it.

The footer button reads **Fix all** and sends every open finding. Selecting
rows turns it into **Fix N selected**. **Fix now** sends its one finding.
Each sends one reply to the review's thread: "Fix these N findings from
<review>", the findings by priority and title, and one line pointing the
agent at `list_reviews`. That result holds the details, the ids, and how to
record each fix, so no per-turn note repeats it. The selection clears once
the reply is sent. The card stays open until the last finding is settled. A
review with nothing left open offers **Mark handled** instead.

Fix actions show a spinner and **Sending…** while the composer takes the
request, then **Working…** while the owning thread has an active turn. Both
the stack and panel disable duplicate Fix actions during either phase. A
failed submission keeps the selection, shows its error, and allows a retry;
ending or cancelling the turn re-enables fixes for findings that remain open.

The transcript review keeps the record. A status row under the verdict gives
the open count, or how the review was handled or dismissed. Each finding's
footer holds its two actions, or a resolution line naming the outcome, the
actor, the agent's note, the to-do card a deferral waits on, the evidence
link, and the time. An operator's own
click shows "by you" without its stock note. Status tone is carried on the
glyph and label only.

The card's title derives from the stored context with
`threadReviewDisplayTitle`: the pull request, then the branch, then the stored
title. An agent's own title for a recorded review is kept.

Review controls use `listThreadReviews`, `updateThreadReview`, and the existing
To-do change event. `threadReviewTodo` projects review metadata into the card
list without duplicating persisted card state. Status changes are atomic,
with one SQLite commit per new review or status mutation. Duplicate imports,
reads, unchanged statuses, and idle time make no commits. Starting tracking
costs one profile-wide commit (~8 KB WAL), with no recurring writes: 0 MB/day.
The checked-in `thread-review-tracking-start` budget verifies that restarts
and reads do not repeat it. Explicit legacy enrollment costs one commit
(~4 KB WAL), about 0.4 MB/day at 100 enrollments/day; repeated enrollment is a
no-op, covered by `thread-review-legacy-enrollment`. The checked-in
`thread-review-lifecycle` write budget measures a two-finding review and both
resolutions at three commits and about 29 KB WAL, approximately 2.9 MB/day at
100 such review lifecycles per day. Larger findings increase the payload cost.
