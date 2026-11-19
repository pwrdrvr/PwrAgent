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

PR scope is retained in the existing native and managed review provenance.
Codex Inline is no longer a supported execution mode. Queued PR review keeps
its captured native or managed mode together with the immutable target snapshot.

## Choosing pull requests

The target lists the project's attached PRs in the panel, not a popup, in the
sidebar PR popover's order (`resolvePrRollup().ordered`): open PRs first,
newest opened first, then merged and closed PRs, newest finished first. Each
row prints its state, head branch, and the time it is sorted by; its chip
opens the standard PR card on hover.

A thread composer whose owner takes queued reviews offers checkboxes. Checking
several PRs submits one review per PR, in list order, through the owner's
review queue: the first starts when the thread is free and each of the rest
runs after the one before it, each with its own captured snapshot. Such a
batch never auto-fixes, because the fixes would all land in this checkout,
which is on at most one of the PRs' branches. A launchpad offers radios.

## Reviewing several pull requests together

Once two or more PRs are checked, **Review them** offers **Separately** (the
default, one review per PR as above) or **Together**: one review of a
`pullRequests` target, `{ type: "pullRequests", pullRequests: { url, snapshot? }[] }`.
It takes two to eight distinct GitHub.com PRs of one repository, all attached
to the thread.

The owner resolves each PR exactly as it resolves one, and if any one fails the
whole review fails: a combined review that silently dropped a PR would read as
covering it. Each snapshot also records `changedPaths`, the paths its
merge-base-to-head diff changes (renames as a deletion and an addition), up to
500; beyond that the field is absent, which means unknown. Incoming snapshots,
changed paths included, are replaced; only internal scheduler release reuses
them. Rescheduling keeps the captured snapshots only for the same PRs in the
same order and the same workspace.

Codex's native `review/start` takes one target, so a combined review runs on the
PwrAgent Sub Agent: an omitted run mode selects it and an explicit
`codex-sub-agent` is refused. The panel switches the mode and says why. The
reviewer reads the PRs bottom first when they form a stack (each one's base
branch is another's head branch), otherwise in list order, each with its own
pinned range, and is asked to report each finding once, on the PR that
introduces it.

The review lands as one card and one record. Provenance holds
`pullRequests` and `pullRequestSnapshots` in reading order, with `pullRequest`
the first and no single branch or commit. Each finding is tagged with the
reviewed PRs whose `changedPaths` include its file
(`reviewFindingPullRequests`): one tag, the finding's PR; two, both changed the
file; none, no reviewed PR did. The tag comes from the diffs, not the reviewer,
and the review is never split by guess. Fix and Auto-fix messages name each
finding's PRs. Auto-fix is off for a combined review, as for a batch.

The owner advertises `reviewPullRequestSet`. Combined, branch and path targets
and Claude Code's run mode travel on separate extended-review Federation routes
(`backend.startExtendedReview`, `backend.createScheduledExtendedReview`,
`backend.updateScheduledExtendedReview`), so an older owner answers
`method_not_found` and the viewer says to update it, instead of reviewing one PR.

From a bound messaging conversation, use `/review --pr 12 13` or pass full
GitHub.com PR URLs after `--pr`. Separate entries with spaces or commas. A number
must identify exactly one PR attached to the thread. `/review --pr <url>` still
starts a single-PR review.

For the `start_review` agent tool, pass a target such as
`{"type":"pullRequests","pullRequests":[{"url":"https://github.com/org/repo/pull/12"},{"url":"https://github.com/org/repo/pull/13"}]}`.
It schedules one review after the calling turn completes successfully. Both
surfaces require two to eight distinct, attached PRs from one repository for
a combined review. They default to the PwrAgent Sub Agent, or to Claude Code
on a Claude thread when reviewing in its own workspace with an owner that
supports `/code-review`. Claude Code uses the panel's default `high` effort.
Messaging requires reply permission and also requires remote control for a
peer's thread. Claude Code review turns retain the initiating contact's tool
permissions, including when queued or sent to a peer. A messaging connection
or peer must support retained contact provenance to run the review.

## Claude Code's `/code-review`

On a Claude thread whose owner advertises `reviewClaudeCodeReview`, the panel's
run mode defaults to **Claude Code**, which sends `/code-review` as the thread's
own turn (`runMode: "claude-code-review"`). The panel offers the targets the
command takes: Current changes, Attached PR, Branch and Path. An effort row
(low to max; `ultra` is left out because it runs a billed cloud review whose
findings do not return to the thread) carries the level as `reasoningEffort`,
and the panel shows the exact command. Several PRs Together are one
comma-separated argument, which Claude Code reviews as one report; Separately
queues one command per PR.

`claudeCodeReviewCommand` builds the command on the owner. A PR is its bare
number when the checkout has exactly one GitHub remote and the PR is that
repository's, otherwise its URL, so the review card's parser
(`parseClaudeCodeReviewPullRequests`) names exactly the PRs sent. A relative
path is written with `./` so it cannot read as a PR, and a branch that looks
like a PR number is refused. `/code-review` takes no commit, so Claude reads
each PR when its review starts; nothing is pinned or captured. The review runs
in the thread's own workspace; another project needs the PwrAgent Sub Agent.

