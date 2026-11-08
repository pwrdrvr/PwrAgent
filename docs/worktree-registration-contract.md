# Worktree registration contract

`register_thread_worktree` records operator authorization for a known local,
current-profile thread's existing linked Git checkout. It is an additive
`pwragent` orchestration tool, shared by dynamic-tool and MCP dispatch.

The tool takes `backend`, `threadId`, and the exact canonical `worktreePath`.
Its `action` defaults to `register`; `inspect` reads the persisted receipt and
its current validity without writes, and `unregister` revokes that thread's
authorization. Messaging callers require `thread.control.archive`.

Register and unregister always require an explicit operator card, including
in Full Access and for trusted directories. The card identifies the thread,
checkout and Git common directory, and states the removal and snapshot policy.
There is no agent-supplied approval field. A cancelled card saves no ownership
authorization. Registration changes no checkout files or branches.

Membership comes from the active profile's local provider inventories, including
archived threads and native children. The requested checkout must already be
attached to that thread. The provider inventory, attachment and Git identity
are read again after approval. Main checkouts, subdirectories, filesystem aliases,
copied `.git` links and unrelated checkouts cannot be registered.

The receipt lives in the thread's PwrAgent SQLite overlay. It contains the
canonical checkout, Git directory, common directory, directory identities,
authorization time and requesting thread. The external marker stays intact.
Provider cwd observations, PR links, directory trust and `to-project` moves
cannot create receipts. Managed new-worktree creation keeps its existing behavior.

Maintenance and archive admission validate the receipt against Git's worktree
inventory and administrative backlink. A move, replacement or snapshot restore
that changes directory identity requires fresh authorization. Registration
changes enter the existing lifecycle and workspace-mutation guards. They cancel
and wait for in-flight hibernation of that checkout before completing, including
when an archived co-owner revokes a receipt. Both hibernation and archive require
each outside external owner's valid registration; active shared owners still
block removal. Unknown ownership remains protective.

The managed-root rule from PR #3476 is independent: a Git-verified linked
checkout attached to a known thread inside a canonical PwrAgent worktree root
may ignore a legacy external flag. Registration does not extend those roots or
give a symlink escape that exception.

Registration only establishes ownership eligibility. Idle windows, current
activity, terminals, shared owners, watches, snapshot limits and final saved-tree
checks continue to govern removal. Snapshots retain tracked edits and non-ignored
untracked files. Ignored files are removed without recovery.

Write budgets measure one SQLite commit (observed 12,360 WAL bytes) for the
registration record and one for revocation. The native approval flow adds its
existing questionnaire receipt: two commits / 24,720 bytes when approved, one
commit / 12,360 bytes when cancelled. Inspection and maintenance discovery add
zero commits. WAL bytes vary with overlay size and page fill.
At 100 approvals per day, the measured approval path projects
2.472 MB/day (`100 / 86,400 × 24,720 × 86,400`); there are no timer writes.
