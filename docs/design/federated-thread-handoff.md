# Move an existing thread between PwrAgent instances

## Outcome

An operator can finish testing on Windows, then copy the thread and its workspace
to a faster machine for review and follow-up work. Move creates a new Codex thread
on the receiver and archives the original after validation. The source checkout
remains intact. Provider thread IDs change; ownership changes through an explicit
source/destination relationship rather than by rewriting a federation mount.

The first implementation exposes `handoff_instance_thread` through PwrAgent's
agent tools. It handles local-to-remote and remote-to-remote transfers; a local
viewer can request a transfer from the actual remote owner. It does not move the
example Windows thread automatically.

## Reuse

- `ThreadMigrationService` already uses Codex's `thread/fork(path)` to cross
  profiles, checks destination replay, and archives only after a successful copy.
- `CodexAppServerClient` now exports bytes through the protocol's `fs/readFile`.
  PwrAgent does not open, parse, rewrite, or discover Codex-owned storage.
- Federation file push already provides authenticated routing, chunking,
  backpressure, collision protection, byte limits, and SHA-256 verification.
- `BackendRegistry.forkThread` establishes the destination workspace, execution
  permissions, model defaults, environment runtime, and navigation state.
- The ordinary archive path still cleans up worktrees. Handoff requests the
  internal `preserveWorktrees` option so Move retains the source checkout.

The path override on `thread/fork` is documented as unstable in the pinned Codex
protocol. A source that cannot serve `fs/readFile` fails explicitly, before Git
capture. There is no storage-reading fallback. See the [Codex App Server
documentation](https://learn.chatgpt.com/docs/app-server).

## Transfer sequence

```mermaid
sequenceDiagram
  participant V as Viewer / Agent tool
  participant S as Source owner
  participant C as Source Codex
  participant D as Destination owner
  participant R as Destination Codex
  V->>S: Copy or Move(thread, target, repository)
  S->>S: Reserve idle thread; reject queued work
  S->>C: thread/read and fs/readFile
  C-->>S: Protocol history and opaque rollout bytes
  S->>S: Capture Git state; gzip PwrAgent package
  S->>D: Federation file push
  D->>D: Verify peer receipt, checksum, limits, paths
  D->>D: Import Git bundle into a new detached worktree
  D->>R: thread/fork(path, destination cwd)
  D->>R: thread/read
  D->>D: Compare history digest
  D-->>S: Validated destination identity and workspace
  opt Move
    S->>C: Recheck source history
    S->>C: thread/archive
  end
  S-->>V: Destination link, archive outcome, warnings
```

The source reservation spans capture, transfer, and acknowledgement. It blocks
new turn admission, including starts already in flight, held submissions, and
queue submissions. An active Codex thread also fails the protocol preflight.
Move checks scheduled actions before capture and again before archival. The
operator must cancel pending scheduled actions or choose Copy.

## Git transport

A Git bundle replaces the need for SSH or a temporary network Git remote. The
receiver advertises up to 256 recent commits before capture. When the source has
a shared ancestor, the bundle omits history reachable from that ancestor;
otherwise it includes full history. The bundle also carries two private
snapshot commits. The first snapshot records the source index; the second
records actual working-file bytes, including non-ignored untracked files.
Neither commit changes the source branch or checkout. The temporary bundle ref
is deleted when capture finishes.

The package also carries working-file bytes. The receiver materializes those
bytes directly into a worktree created with `--no-checkout`, then restores the
index with `read-tree`. This preserves binary data, CRLF, and staged/unstaged
layers without invoking receiver clean/smudge filters. Object hashes verify each
file against the bundle's tree. Hashing and index updates are batched, so Git
process count does not scale with the number of files.

The receiver must have an existing repository with shared root history. It
imports into a unique detached worktree under its PwrAgent profile. Existing
branches, worktrees, working files, and FETCH_HEAD are preserved. A bundle with
unrelated history is rejected. Shallow histories may need deepening first.

A normal upstream push/fetch can also become an explicit operator choice. The
bundle path makes transfers independent of upstream credentials and publication
permissions.

## Package and permission boundary

The versioned gzip envelope contains source identity, an operation UUID, a
digest of protocol-rendered messages, opaque rollout bytes, optional title,
and optional Git bundle plus workspace files. It carries no authentication
profile, database, repository config, hooks, or unsent composer draft.

Decoded packages are limited to 128 MiB, including base64 overhead. Decompression
has an output ceiling. File data must be canonical base64. Import validates
object IDs, bundle ancestry, file count, paths, modes, and blob hashes. It rejects
path traversal, `.git` components, case collisions on macOS/Windows, and invalid
Windows names. Git conflicts, symlinks, and submodules are unsupported.

Both endpoints advertise `thread_handoff`. The requesting peer also needs turn
control and environment actions. Import additionally requires file push and the
receiver's existing **Allow file push** preference. Every routing hop must be
running a compatible version. An import can consume only a file for which the
receiver recorded a completed push from that authenticated source instance.
Arbitrary local paths in an import request are rejected.

## Failure behavior and current limits

- Destination history mismatch archives the partial destination and rolls back
  the newly created workspace. If retirement fails, the workspace is retained.
- Loss of acknowledgement retains the source. A validated destination may exist;
  search for it before retrying from the agent tool.
- Failure to confirm source archival returns the ready destination with a warning.
  This is a completed Copy, not a completed Move.
- Repeated import RPCs with the same operation ID and identical inputs share one
  result while the receiver process is running. Changed inputs are rejected.
- Import deduplication and file receipts are bounded, process-local caches. There
  is no restart recovery or automatic retry. A future durable operation journal
  should make retries recoverable across restarts before the UI offers Resume.
- PR tracking, messaging bindings, grouping, and other PwrAgent metadata are not
  transferred. They remain source-local. Destination execution uses receiver
  defaults. Existing archive semantics retire source messaging bindings on Move.
- No-repository transfers move history into a fresh scratch directory. They do
  not copy arbitrary source-directory files.
- Source-only history attachments and absolute paths are not relocated. A future
  attachment manifest should copy supported protocol-owned assets separately.
- The destination starts detached at the source commit. Source branch information
  is returned as a warning. Branch conflict resolution and PR attachment are
  follow-up work; the source branch is never force-moved.
- The transfer orchestration adds no SQLite tables, timers, progress writes, or
  polling. Existing fork, rename, and archive operations retain their persistence.

## Operator entry point

Discover endpoints with `list_federation_instances` and find the receiver's
repository with `list_instance_projects`. Then use:

```json
{
  "sourceInstanceId": "pwr_source",
  "sourceThreadId": "existing-codex-thread-id",
  "targetInstanceId": "pwr_receiver",
  "targetRepositoryPath": "/Users/operator/projects/PwrAgent",
  "operation": "copy"
}
```

Omit `sourceInstanceId` for a local source. The repository path belongs to the
receiver and uses that machine's native format. Move requires an idle source with
no queued prompts or pending scheduled actions. Return the tool's destination
thread link and warnings to the operator.

## Desktop interaction to add next

Add **Send to another machine…** to the thread menu and remote-view header. Show
connected compatible instances, receiving profiles, and their existing projects.
The operator selects **Copy** or **Move**, previews branch/dirty-state details and
the metadata that will stay on the source, then starts the transfer. Progress
should report capture, upload, workspace preparation, history validation, and
source archival. Completion opens the destination thread.

Before adding automatic repository matching, use normalized remote identities
and shared commit ancestry. Never match only on basename. Missing repositories
need an explicit clone destination. Before calling the operation a full ownership
handoff, add durable provenance, PR references, and explicit policies for
scheduled work, messaging bindings, child threads, and branch-name conflicts.
