# Attached pull-request review targets

An attached PR target identifies the PR by URL. It is separate from a base-branch
review, which compares the active checkout. This lets a thread review an earlier
PR in a stack while its checkout contains later commits or uncommitted work.

The owning PwrAgent instance resolves the attachment and selected repository,
requests fresh provider metadata, and captures the base tip, head tip, and unique
merge base before scheduling. Incoming snapshot fields are not authoritative.
Only internal scheduler release passes the separate trusted-snapshot argument;
IPC, Federation, messaging, and agent-tool requests cannot supply that argument.
Rescheduling the same captured PR preserves its commits. Create a new review to
capture a newer head.

Missing objects are fetched by exact SHA without destination branch refs or
FETCH_HEAD writes. Private `refs/pwragent/review-objects/<sha>` refs protect the
captured objects from pruning after a force push. These retention refs currently
have no automatic cleanup. A missing object or ambiguous merge base fails the
review instead of substituting HEAD. No checkout, reset, stash, or worktree
switch occurs.

At the Codex adapter boundary, the target becomes a supported custom review
request with the immutable merge-base-to-head diff and `git show <head>:<path>`
file-reading instructions. The original identity and snapshot remain in review
provenance. This retains the selected native review engine; it does not use a
single-commit review for the whole PR. As with other custom reviews, adherence to
file-reading instructions depends on the reviewer. The application does not
isolate the review in a separate filesystem.

## Choosing between a pull request and the checkout

The composer offers the attached-PR target only when the selected project has
attached pull requests and the owning workspace executes locally. An
always-present row that dead-ends on "no attached pull requests" is noise, and
the keyboard target walk only visits the targets it draws.

The PR target reviews the provider's published head. Base branch and Current
changes review the checkout in front of the operator. Those describe the same
commits only when the checkout sits on the PR's head branch with a clean tree,
nothing unpushed, and the same head commit, so that is the one case where the
composer defaults to the pull request. A dirty tree, an unpushed commit, a
different head commit, or a different branch keeps the local default, and
selecting the PR then names what the review would skip. Local Git state that
has not been probed counts as unknown, never as a match.

The checkout's head commit is compared directly when the directory row reports
the same branch; Git refuses the same branch in two worktrees, so that is what
establishes the row describes this checkout. Otherwise the clean/unpushed
counters stand in for it.

The initial provider scope is GitHub.com. Other providers keep the generic Base
branch, Current changes, Commit, and Custom targets. Codex remote execution
workspaces are explicitly unsupported for attached-PR review. A Federation peer
owning a local workspace is supported: resolution and Git commands run on that
owner, never against a same-named path on the viewer. Separate Federation PR
routes make older owners reject the request instead of downgrading the target.

Regression coverage includes two multi-commit stacked PRs with a dirty newer
checkout, queued snapshots after provider-head changes, exact-object fetching
after branch movement, repository scoping, forged incoming snapshots and flags,
native wire translation, and UI selection across linked projects.

Inline PR review records its scope as a parent review card through the existing
overlay projection. It creates no sub-agent and does not claim a second turn
lifecycle. The ordinary parent turn owns the findings. The checked-in write
budget measures one SQLite commit and 16,480 bytes of WAL for the scope card.
At 100 inline PR reviews per day, `(100 / 86400) × 16480 × 86400` is 1.65 MB/day.
There are no timer, stream-event, or completion writes for this card.
