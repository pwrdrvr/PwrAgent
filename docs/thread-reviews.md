# Thread review tracking

Completed code reviews are attention records in the profile's `state.db`.
An open review appears alongside questions, approvals, and ordinary cards in
To-dos, including the thread and project counts. Review artifacts remain in
the transcript after resolution or dismissal.

Each record has a stable review id, source artifact key, owning backend and
thread, findings, status, creation and last-update timestamps, and optional
source URL and workspace/PR provenance. Findings have stable ids and their own
status, last update, and resolution. A resolution records its reason, optional
HTTP(S) evidence link, actor, and date.

The stored text is capped excerpts kept so To-dos and the agent tools work
without the transcript. The transcript's review card renders from its own
entry and reads only state from this table. This is a documented exception to
[thread-history-persistence.md](thread-history-persistence.md#tracked-review-findings).

Findings are `open`, `addressed`, or `dismissed`. Reviews are `open`, `handled`,
or `dismissed`. Settling the last open finding automatically handles its review.
An agent cannot mark a review handled while findings are still open. It can
then document the whole outcome with a final note and link. Reopening a finding
reopens the review. Whole-review dismissal overrides its findings without
overwriting their individually recorded outcomes. The transcript labels it
**Do not address**, and reopening restores the findings that were still open.

The shared dynamic-tool and MCP catalog exposes four thread-scoped tools:

| Tool | Purpose |
| --- | --- |
| `record_review` | Track external or manually written findings using a stable `sourceKey`. |
| `list_reviews` | Read reviews and findings with ids and resolutions; defaults to open. Use `status: "all"` to inspect dismissals. While a finding is open, the result carries `guidance`: work on findings only when the operator asks, and mark a fixed one addressed with `update_review_item`. |
| `update_review_item` | Set a finding's status, with a `note` and optional `url` documenting its outcome. |
| `update_review` | Dismiss, reopen, or document a handled review with a `note` and optional `url`. |

The trusted calling context supplies backend and thread identity. An agent
cannot inspect or mutate another thread's review by passing its id. Reusing a
source key returns the existing record and never reopens settled findings.

Final native and managed review events are imported automatically. Existing
PwrAgent-managed artifacts are imported at startup. Older provider-owned
reviews are imported when the App Server returns them during a thread read;
the app does not scan provider storage or eagerly load every old thread.
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

## Controls

An open review's To-do card lists its findings, open ones first by priority,
four rows before **Show N more**. Each open row has a checkbox, ticked by
default, and **Do not address**; a settled row dims in place with its
outcome's glyph and offers **Reopen**. The head's dismiss control dismisses
the whole review, and the stack's **Undo** reopens it. **Fix N findings**
sends one reply to the review's thread: "Fix these N findings from <review>",
the ticked findings by priority and title, and one line pointing the agent
at `list_reviews`. That result holds the details, the ids, and how to record
each fix, so no per-turn note repeats it. Unticked findings stay open. The card stays open until
the last finding is settled. A review with nothing left open offers
**Mark handled** instead.

The transcript review keeps the record. A status row under the verdict gives
the open count, or how the review was handled or dismissed. Each finding's
footer holds its two actions, or a resolution line naming the outcome, the
actor, the agent's note, the evidence link, and the time. An operator's own
click shows "by you" without its stock note. Status tone is carried on the
glyph and label only.

The card's title derives from the stored context with
`threadReviewDisplayTitle`: the pull request, then the branch, then the stored
title. An agent's own title for a recorded review is kept.

Review controls use `listThreadReviews`, `updateThreadReview`, and the existing
To-do change event. `threadReviewTodo` projects review metadata into the card
list without duplicating persisted card state. Status changes are atomic,
with one SQLite commit per new review or status mutation. Duplicate imports,
reads, unchanged statuses, and idle time make no commits. The checked-in
`thread-review-lifecycle` write budget measures a two-finding review and both
resolutions at three commits and about 29 KB WAL, approximately 2.9 MB/day at
100 such review lifecycles per day. Larger findings increase the payload cost.
