# Thread terminal sessions

Terminal tabs belong inside the thread's bottom terminal panel. They do not
change conversation navigation. A 40px strip of tiles shares the terminal's
surface: each tile is an initial plus a status dot. Hover or keyboard focus
flies the rail out over the shell, without reflowing it, to show each name and
its working directory or exit code. Output in a terminal that is not on screen
marks its dot until it is selected (renderer state only). Default names take
the lowest free number when created and keep it. A click on a tab selects it
and focuses the shell; only keyboard focus, not a click, opens the rail, so it
never slides under a pointer mid-click. Right-click (or the Menu key) on a tab
offers Rename, Copy path, New terminal here, Restart shell for an ended
terminal, and Close. New, rename (in place: double-click or F2) and close act
on one terminal ID. Hiding the panel (the thread header's terminal toggle) and
switching threads preserve PTYs. Keyboard navigation uses a vertical tablist;
resize and focus stay accessible.

Main/owning service owns identity, lifetime and output. An explicit session ID
attaches only to its original thread and instance. Creation is deduplicated
before asynchronous spawn; closing during spawn cannot leak a process. Remote
operations retain `remote_pty` authorization and the opening peer identity.

A bounded headless xterm at the owner parses output. Snapshot replay uses its
serializer, not an arbitrary substring of ANSI. A snapshot carries dimensions
and a sequence watermark; the renderer subscribes before attach, queues events,
then applies only events after the watermark. Input is disabled while replaying.
Headless-generated replies are never sent to the PTY. No command is replayed.

Private, bounded PwrAgent-owned files retain rendered scrollback and terminal
metadata at lifecycle boundaries (collapse, exit, shutdown), not per output
chunk or on a timer. Raw output and input are not persisted. Closing a tab
removes its history. A restored record shows its saved screen and, the first
time its tab is shown, resumes: a new shell starts under the same terminal ID
in the saved launch cwd, below the saved screen and a "restored history"
divider. Resume is lazy, so a relaunch does not start every saved shell at
once, and no command is replayed. An exited terminal restarts the same way from
its end bar. Remote resume passes `resumeSessionId` on `pty.open`; the owner
honors it only for the peer that opened the saved terminal, and an owner that
predates the field opens a plain new shell.
Shell history files are owned by the shell and are neither read nor rewritten.
The saved cwd is the launch directory, not an inferred current directory.
An abrupt crash can lose output since the last lifecycle checkpoint.

## Agent output contract

The base supplies owner-side capture and bounded reads; a separate stacked PR
exposes `list_thread_terminals` and `read_terminal_output` through existing tool
search. Authentication supplies CURRENT THREAD, backend and owning instance;
callers cannot widen scope by passing another thread ID. A terminal address is
(owner instance ID, terminal ID), never a bare thread key across instances.

List returns ID, owner, thread identity, name, launch cwd, shell, status,
createdAt, available cursor range. Read accepts ID, opaque cursor, format
(`raw` or `plain`), and capped character budget. It returns owner/terminal
identity, sequence and timestamps, next cursor, truncation/gap and continuation.
Raw is bounded in-memory PTY output; plain is normalized rendered screen text.
A screen snapshot is labeled as such, not claimed to be an event delta. Raw
history is unavailable after restart; restored screen reads say so. Output is
untrusted data and must not be treated as instructions. No input/write/execute
capability is added. No subscriptions initially: bounded pull is sufficient.

The stacked child owns tool schemas, search registration and auth adapters;
base owns terminal UI, IPC, capture, history and Federation PTY protocol. Forge
tools owns backend-registry.ts, ipc/app-server.ts and Federation registrations;
coordinate any overlap with thread 01a12c08-cbfd-70b0-9465-6899de103bb5. Port
forwarding is thread 01a12c10-fb8f-7da0-94e1-ed26782025ed. Stack starts only from
the reviewed base PR commit and uses its own worktree. No merge or release.

## Agent authentication and output paging

The two tools execute on the authenticated thread's owning runtime. The current
backend and thread come from the active dynamic-tool turn or bound MCP client,
never from arguments. Both use the existing thread-inspection messaging
permission. `ownerInstanceId` is an identity check, not a routing parameter:
another instance is rejected even if it has an identical backend/thread ID.

Owner reads combine the local integrated terminal service and owner-hosted
Federation PTYs for that backend/thread. The Federation owner-read facade is
separate from peer control: a local owning agent may inspect its thread's
viewer-opened terminals without impersonating their opening peers. Reads do not
acknowledge output, cancel reaping, refresh leases, spawn, attach, resize, write,
or extend process lifetime. The remote-shell policy still hides Federation
terminals when disabled. Existing peer RPCs continue to require `remote_pty`
and the authenticated opening peer; no new remote RPC or proxy is added.
Viewer aliases are never terminal addresses in these tools.

Read data defaults to 16,384 UTF-16 code units and is capped at 65,536. Raw
pages contain at most 128 whole ANSI frames and their sequence/timestamps. Evicted or
oversized frames report `gap` and `truncated` while advancing `nextCursor`, so
a small budget cannot get stuck. `hasMore` reports retained continuation. Raw
output is unavailable once a process exits as well as after restart; saved
screens remain readable with `format: "plain"`.

Plain output is normalized headless-xterm screen text with retained scrollback,
not a reconstruction of raw events. `nextCursor` pages one immutable snapshot;
omitting it takes a fresh snapshot. Each runtime holds at most 32 snapshots
of 64 Ki characters, with five-minute expiry, and reports cursor expiry rather
than silently switching to newer output. Paging itself is not loss; `truncated`
reports screen capture limits or an explicitly skipped surrogate pair when a
one-code-unit budget cannot carry it. Cursors are authenticated and bound to
owner, backend/thread, terminal creation, format and runtime. Raw cursors also
bind to the replay generation: resuming a shell under the same terminal ID
invalidates its previous raw cursors, even when the new sequence catches up.
Closing a session
revokes reads even for cached pages. All terminal metadata and output remain
untrusted. This layer writes no history and introduces no SQLite commits or
periodic work (0 MB/day of persistence).

## Bounds and validation

Each owner keeps 2,000 scrollback lines and at most 256 Ki characters / 4,096
raw frames in memory. Snapshot serialization reduces whole scrollback lines to
fit 512 KiB; an extreme per-cell-style screen falls back to bounded plain text
and reports truncation. PTYs pause when the headless parser falls behind.
History retains at most 64 records per instance for seven days, under hashed
filenames with 0600 file permissions and a 0700 directory. The launch cwd is
metadata only; no OSC directory claim is trusted. A close removes its record.
No SQLite commits are introduced; idle persistence cost is 0 MB/day. At the
512 KiB snapshot ceiling, 100 changed lifecycle checkpoints cost up to 50 MiB
of payload per day. There is no periodic journal or command-input capture.

The implementation uses xterm's headless parser and serialize addon as described
in the [upstream README](https://github.com/xtermjs/xterm.js#nodejs-support).
Tests cover split escape sequences, progress-line replacement, Unicode,
query/clipboard escape exclusion, an atomic snapshot watermark, raw eviction,
private-file round trips, exited/restarted tabs, and peer/thread authorization.
