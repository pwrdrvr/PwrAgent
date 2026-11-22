# Pull-Request Status

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Pull-Request Status Source of Truth

There are two stores holding PR data, and they answer **different
questions**. Do not treat them as interchangeable:

- **Attachment list** — `ThreadOverlayState.prs` (sqlite `threads`
  overlay JSON, written by `setThreadPullRequests`). Authoritative for
  *which* PRs belong to a thread. The status fields on those rows are a
  cached projection and go stale by design: they are only rewritten when
  the attachment list itself is rewritten (a branch lookup).
- **Status** — the PR status registry in `DesktopAppServerService`
  (`prStatusRegistry`, durable via the `pr_status_cache` table).
  Authoritative for *what state* a PR is in. The background poller
  writes here and here only, then emits `pullRequest/status/updated`.
  It never writes back into the overlay.

**Every path that serves PR chips to a client MUST canonicalize the
overlay rows through the status registry.** The seam is the injected
`ThreadPullRequestCanonicalizer` (`setThreadPullRequestCanonicalizer`,
backed by `canonicalizeStoredPullRequests`, which loads
`pr_status_cache` first so it works before any window has driven a
lookup). Use `canonicalizeNavigationThreadPullRequests` for a navigation
snapshot's threads.

Skipping it is not a cosmetic staleness bug. `collectPrPollTargets`
drops terminal PRs from the rotation, so once a PR merges the background
poller emits no further `pullRequest/status/updated` for it — a client
served an uncanonicalized snapshot shows that PR as open with checks
running until something else happens to refresh it. (An owner-side
branch lookup still republishes terminal PRs via
`thread/pullRequests/updated`, so the row can converge if the *owner*
opens that thread — but nothing the viewer does will fix it.) This is
exactly what federation remote viewers hit: their only snapshot source
is `DesktopMessagingBackendBridge.getNavigationSnapshot`, which did not
canonicalize, while the renderer's local path did.

Canonicalization failures degrade rather than propagate:
`canonicalizeNavigationThreadPullRequests` catches, logs, and serves the
overlay rows, because possibly-stale chips beat a failed snapshot (which
for a viewer means a disconnected window).

Compact navigation rows carry a preview of up to 16 PRs and the full count
when attachments exceed that preview. The preview retains the lead and the
PRs whose readiness determines the two rollup indicators. The shared
membership index carries stored attachments. A status observation can refresh a
page without rebuilding that index. The owner validates automatic attachments
and applies canonical statuses before calculating the page's preview, attachment
count, and wire bytes. Cursor backing keeps compact row references and observed
previews. The owner reads full attachments only when the page demands them.
Directory index and archive planning reads use membership alone. Federated pins
and watched threads receive owner-validated previews. A continuation keeps the
same row offsets and reuses PR projections it already observed. A fresh read
reuses a cursor generation only if its baseline proves every retained PR
observation within the page work budget. Star Map facets and filtering use
validated PR membership across their inventory. Selected detail and bounded
pages take priority over those inventory checks.

Owner refresh seeds status polling from stored attachments and repository
observations. A PR that already has a repository identity can poll by number
without re-reading its checkout or default refs. The owner resolves an
origin when a primary workspace changes or a live attachment has no saved
repository identity. Branch discovery runs on turn completion and branch
adoption, on selection, and in the existing slow rotation. That rotation
considers up to 100 threads with access in the last seven days, runs at most
three per tick, and excludes focused threads. Selection and the owner’s
seen timestamp can put a thread in that pool. A background inventory event
does not count as access.

Watch creation and Auto-fix delivery check the attached PR against the current
primary checkout. Forge project rules resolve the checkout on demand. Stored
polling identity is used for status ownership and selection of poll targets.

The sidebar's PR disclosure and row menu request the owner's complete list through the paged
selected-detail collection, with one restart on an expired cursor. The owner
canonicalizes the overlay attachments before serving those pages. The
disclosure reconciles status events that arrive while pages are loading.
Individual copy actions can use the preview. Bulk actions wait for the
complete list.

### Which PRs a thread attaches automatically

A thread gets a PR without the operator asking from two sources only:

- **A branch lookup of its own branch and directories.** A default branch
  (`main`, the remote's `HEAD`) looks up nothing, so a thread on it
  attaches nothing automatically (`resolvePrLookupBranches`).
  The lookup uses the upstream's branch name when the branch tracks one.
  A branch with no remote upstream may have been pushed under another
  name, and that branch may be deleted after a merge. When its own name
  finds no PR, the lookup asks the forge for PRs on the tip commit and
  keeps only one whose head *is* the tip. It skips that step when a
  default branch already holds the tip, because the PR that landed the
  commit there belongs to another thread.
- **Its own history.** A PR the thread attached earlier, on another
  branch, stays attached after the checkout moves on.

**A thread never inherits another thread's PRs**, even when both are on
the same branch in the same checkout. The PR lookup registry
(`prLookupRegistry`, durable via `pr_lookup_cache`) is keyed by provider,
branch and directories, not by thread. Every thread on that branch and
checkout reads the same entry. It must therefore hold only what
`detectPullRequestsForThread` returned. Never seed it from a thread's
overlay `prs` or `detachedPrs`. That list is the thread's history.
Seeding it once attached four old merged PRs to every new thread in a
primary checkout on `main`. Detaching them on one thread did not stop the
next thread from getting them.
`app-server-ipc.test.ts` ("never shares one thread's PR history…") holds
this.

### Who owns a PR's status when two instances can see it

A window with no federation target shows local threads and pinned remote
rows together, so the same GitHub PR can appear twice — once monitored
by the local poller, once as a peer's observation. Two monitors writing
the same rows from slightly different points in time reads as the status
flickering. The rule is **local monitoring wins, and a peer only fills a
gap it alone can see**:

- `broadcastAgentEvent` drops a remote-stamped `pullRequest/status/updated`
  before it reaches any non-federation window when
  `registry.isPullRequestLocallyMonitored(prKey)` — the PR is attached to
  a local thread's primary workspace, so our own poller owns it. The
  resolver is injected from `DesktopAppServerService` and uses the same
  test as `collectPrPollTargets`. Terminal PRs still count as ours: they
  leave the poll rotation, but our last observation of them is final.
- Federation windows always receive the event. The peer is their only
  source of truth, and their renderer-side target filter decides whether
  it belongs to the instance they front.
- When we *do* own the PR, the pinned remote row still updates — local
  `pullRequest/status/updated` matches by `prKey` across every thread in
  the snapshot, so the local observation lands on the remote row too.
  That is why dropping the peer's copy loses nothing.

`thread/pullRequests/updated` is **not** gated: a thread's *attachment
list* is owned by the instance the thread lives on, so a peer is always
authoritative for its own threads' lists. It is instead scoped by origin
in `applyThreadPullRequestsUpdate`, which matches the thread's
`federation.ref.target` against the event's, so a peer's event cannot
rewrite a local thread that happens to share an id. Do not "fix" the
asymmetry by adding this method to the gate — status and attachment
lists have different owners, and a test pins the distinction.

Two deliberate cases where we defer to the peer rather than claim
ownership, both because claiming it would assert a freshness we do not
have:

- **Non-primary attachments.** The test is the PR matching a local
  thread's *primary* repository, matching `collectPrPollTargets`. Fork
  contributions match their separate `sourceRepository`; an explicitly attached
  contribution also matches its destination repository. Use the shared
  `pullRequestMatchesRepositoryKey` predicate. Keep `explicitlyAttached` on the
  thread's attachment when applying shared provider status; never copy it into
  the status cache. Their status key still belongs
  to the destination repository. A PR
  attached to a local thread some other way is not polled by us either,
  so the peer's observation is the fresher one.
- **Before the first local snapshot.** `attachedPrsByThreadKey` is
  populated by the local navigation-snapshot path, so until it first
  runs every PR answers "not monitored" and peer observations flow
  through. The local poller corrects any row it owns on its next
  observation.

### Transcript PR fetch trust and status ownership

- Automatic transcript/composer PR reads admit only the exact HTTPS origins
  `github.com` and `gitlab.com` in the main process. A URL in authored text is
  not authorization to send inherited CLI credentials to its host. Never
  replace this origin allowlist with GitLab URL syntax or a hostname prefix.
- Self-hosted references can still display navigation status and use explicit
  attachments. Display-only parsing must not authorize automatic fetching.
- A `ci_run` Continue After wait reads an agent-supplied run URL. It admits
  github.com, gitlab.com, and the exact GitHub Enterprise hosts the operator
  listed in `[git] github_enterprise_hosts` (`parseCiRunUrl`). A CLI login is
  not authorization. Never match that list by pattern, suffix or subdomain.
- The renderer resolves status authority per PR across all navigation rows:
  local primary-workspace attachments win, then peer observations, then other
  local attachments. Use `pullRequestMatchesRepositoryKey` with main's
  `primaryGitRepository` for the local-primary check, including explicit fork
  contributions to that repository.
- Both transcript chips and composer hover cards use `useTranscriptPullRequest`.
  Peer observations suppress local subscription results in every window,
  including pinned peers in the main window. An ownership change must notify
  subscribers even if the visible PR metadata did not change.
