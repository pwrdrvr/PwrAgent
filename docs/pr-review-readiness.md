# PR review readiness

PwrAgent offers to review a thread's pull request, and later to merge it, in
that order. It raises each offer as a to-do card. An agent does not have to
remember to.

## The rule

A pull request head is **reviewed** when a review covers its change. A review
covers two commits: the head it reviewed (`context.headCommit`) and the head
its findings were fixed through (`fixedThroughCommit`). Another head is
covered when it carries the **same change** as either commit.

| Readiness | When | Offer |
| --- | --- | --- |
| `needs_review` | CI is green, no review covers the head, and the latest review has no unsettled findings. | **Review #N** (`start_review`) |
| `findings_open` | The newest covering review has unsettled findings. Or no review covers the head while the latest review has unsettled findings: the new commits are its fixes. | None. The review offer is withdrawn. |
| `ready_to_merge` | The newest covering review is settled, and CI is green. | **Merge #N** (`merge_pull_request`) |
| `ci_pending`, `ci_failing`, `ci_untested` | CI is running, failing, or skipped every check. | None. |
| `conflicting`, `draft`, `queued`, `no_head` | The PR cannot merge yet, or is already in a merge queue. | None. |
| `closed` | Merged or closed. | Any offer is withdrawn. |

A review counts as settled when its status is `handled` or `dismissed`. An
open review with no structured findings counts as one unsettled finding.
Reviews are matched to the PR by the PR they name. A review that ran before
the PR existed is matched by its branch. Reviews come from every thread
showing the PR, so a review run in a sub-thread counts for its parent. Only
the eight newest reviews are read.

### What does not reset "reviewed"

- **Rebasing onto the target branch, and merging the target branch in.**
  Change identity is `git patch-id --stable` of the head's whole diff
  against its merge base with the target, taken with `-U0`. Both operations
  keep the diff's changed lines. They change only the merge base and line
  numbers, and patch-id ignores line numbers. Without context lines, a target
  edit next to a changed line does not count as a change.
  `git range-diff` and `git cherry` use the same equivalence.
- **Review fixes.** When a review's last finding settles, PwrAgent reads the
  reviewed checkout's HEAD. It does this only on the reviewed branch, or for a
  detached review, from a descendant of the reviewed commit. It records that
  commit as `fixedThroughCommit`, once per settlement: `fixedThroughAt`
  holds the settlement time it was read for. Editing an already settled
  finding is not a settlement, so it never moves the commit. Reopening a
  finding and settling it again does. Commits made while findings were open are
  review fixes. While the latest review has unsettled findings, PwrAgent
  offers nothing for an uncovered head, even if CI turns green before the
  findings settle. Commit and push a fix **before** marking its finding
  `addressed`. A fix committed after settlement is a new change, so PwrAgent
  offers another review.

What does reset it is any edit to the change itself, including resolving a
rebase conflict differently.

### Known limits

- With `-U0`, moving an identical added line elsewhere in the same file
  keeps the identity.
- A diff over 32 MB, or a commit the checkout does not have, has no identity.
  Its head counts as reviewed only by an exact commit match.
- The target tip is the forge's `baseSha` when the checkout has it.
  Otherwise PwrAgent uses `upstream/<base>`, `origin/<base>`, or the local
  branch. A stale target ref can make a rebased head look new. That causes
  an extra review offer, never an early merge offer.
- A review of uncommitted changes records the HEAD it started from. A clean
  review of that kind does not cover the commit made afterwards.
- Reviews recorded before this feature have no `fixedThroughCommit`. Their
  fix commits read as new changes once.

## Offers

Each PR has at most one offer card on its thread, keyed `pr-offer:<prKey>`.
The offer id is stored as the card's dependency id, which is unique:

- A review offer is per **change**: `pr-offer:review:<prKey>:patch:<id>`.
  Rebasing an unreviewed PR does not ask again.
- A merge offer is per **head**: `pr-offer:merge:<prKey>:sha:<sha>`. Each
  head needs its own green CI.

An offer the operator dismisses or runs stays closed. PwrAgent never raises
it again. An offer that PwrAgent withdraws itself can come back. For
example, a finding reopens and settles again at the same head. The withdrawn
card then reopens rather than adding a new one.

A merge offer is withdrawn when the head moves, a review stops covering it,
or the PR conflicts or becomes a draft. A merge card whose merge is running
is left alone, and no other offer is raised beside it. The next event
reconciles again. A review offer survives CI runs and
failures, because the change still needs review. A covering review withdraws
it, however that review was started.

### Agents

`get_thread_status` and `check_thread_pull_request_status` return
`prAutomation.reviewReadiness` for up to three primary PRs. They also add
one guidance sentence for each PR. `add_todo` refuses a `merge_pull_request`
card for a head with no covering review, or one with unsettled findings,
even while CI is still running.
The direct `merge_pull_request` tool is not gated. It asks the operator to
approve, so an operator who says "merge it now" still can.

## Why offers were rare and backwards

Before this, PwrAgent had no notion of "reviewed". Review and merge cards
came only from an agent calling `add_todo`. The tool description said "Use
start_review when the work is ready for review" and "Use merge_pull_request
when the PR is green and ready to land." Nothing triggered either:

- A CI-success watch wake told the agent to "report that the watched PR
  checks succeeded and continue only if the operator's prior request
  requires another action". That suppresses both offers.
- Auto-fix turns start only for failures and conflicts.
- Watches exist only when an agent arms one.

When an agent did act on "green", merge was the instruction that matched,
so a merge card could appear before any review.

## Cost

PwrAgent does no scan at startup, runs no timer, and makes no forge request.

- **Triggers.** A PR status transition that moves CI, the head, the
  lifecycle, mergeability, the merge queue, or draft state can trigger an
  evaluation. So can a change to one of the owning thread's reviews.
  Transitions come from polling and refreshes PwrAgent already performs, and
  only for PRs attached to threads. The first observation after a restart
  emits none.
- **Scope.** Each PR has one owning thread: the elected Auto-fix owner, or
  the first primary-attached thread. The thread must not be archived. Its
  project's forge activity must not be paused. Background polling must be on.
- **Git.** Git runs only when CI is green, or to withdraw an open review
  offer. Reviews are read newest first, and the first one covering the head
  ends the reads. It runs in the thread's own checkout, through the shared
  PR-metadata process pool (purpose `pr-review-coverage`).
  - A head costs three processes once: `merge-base`, `diff`, and `patch-id`.
  - Resolving the target costs one `cat-file` or `for-each-ref`.
  - Results are cached by target tip commit and head commit, with up to 256
    entries. A target branch that moves is read again.
  - A settlement costs one `rev-parse`, plus a `merge-base --is-ancestor` for
    a detached review.
- **Concurrency.** Evaluations for the same thread and PR coalesce. A burst
  of events costs at most two evaluations.
- **SQLite.** These budgets are recorded in
  `apps/desktop/src/main/__tests__/fixtures/sqlite-write-budgets.json`:

| Event | Commits | WAL |
| --- | --- | --- |
| Raise an offer (`pr-review-offer-raise`) | 1 | ~29 KB |
| Swap review offer for merge offer (`pr-review-offer-swap-to-merge`) | 1 | ~29 KB |
| Evaluation with nothing to change (`pr-review-offer-unchanged`) | 0 | 0 |
| Record the fixed-through commit (`pr-review-fixed-through`) | 1 | ~8 KB |

At about 100 offers a day, this is about 3 MB of WAL a day. Each PR
typically sees two or three offers, so 100 offers is a very busy day.

## Code

- `apps/desktop/src/main/pr-status/pr-review-readiness.ts`: the pure rule
  and offer plan.
- `apps/desktop/src/main/pr-status/pr-change-identity.ts`: change
  identity, the target tip, and the reviewed branch's HEAD.
- `apps/desktop/src/main/pr-status/pr-review-offer-coordinator.ts`: events,
  coverage, and cards.
- `ThreadTodoService.reconcileOffer` and
  `ThreadReviewService.recordFixedThrough` handle the writes.
- The tests are `pr-review-readiness.property.test.ts` (properties),
  `pr-review-offer-coordinator.property.test.ts` (an `fc` model of pushes,
  rebases, CI, reviews, fixes, and operator actions), and
  `pr-change-identity.property.test.ts` (real Git as the oracle).
