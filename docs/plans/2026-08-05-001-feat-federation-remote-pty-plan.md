---
title: "feat: Remote PTY for federated threads"
type: feat
date: 2026-08-05
---

# Remote PTY for federated threads

## Summary

PR #1202 hid the integrated-terminal toggle in remote federation windows
(`ThreadHeader.tsx` / `ThreadView.tsx`) because the terminal panel spawns a
LOCAL shell — a remote window opening a local PTY under a peer-branded window
misrepresents whose machine the shell runs on. This plan restores the terminal
for remote threads by running the PTY on the owning instance and streaming
frames over the existing federation transport, so the panel in a federation
window is a true window onto the peer's shell.

Deliberately deferred from #1202; this is the follow-up design.

## Product Contract

- The terminal toggle reappears in remote federation windows. Opening it
  attaches to a PTY spawned **on the owning instance**, in the same
  worktree/cwd the owner's own terminal panel would use for that thread.
- Keystrokes, resizes, output, and exit status round-trip live. Latency is
  transport latency (Tailscale/LAN WebSocket) — no polling.
- Closing the panel (or the remote window, or the connection) ends the remote
  PTY after a short grace period. No orphaned shells on the owner.
- The owner can withhold the capability per peer; a viewer without the grant
  sees the toggle disabled with "Remote terminal not granted by <label>".
- The owner's activity log records remote terminal opens/closes with the
  requesting instance label (same operator, but the audit trail must show
  which machine drove the shell).

## Architecture

### New capability: `remote_pty`

Add `"remote_pty"` to `FEDERATION_CAPABILITIES`
([packages/shared/src/contracts/federation.ts](../../packages/shared/src/contracts/federation.ts))
and to `DEFAULT_CAPABILITIES` in
[federation-runtime.ts](../../apps/desktop/src/main/federation/federation-runtime.ts).
Federation is a same-operator trust domain and `turn_control` already permits
arbitrary code execution via agent turns, so default-granted is consistent —
but a dedicated capability keeps a direct shell revocable independently of
thread control (mirrors how `messaging_route` is separable).

### Protocol: request/response for control, notifications for streams

All frames ride the existing Noise-encrypted WebSocket envelope transport
([federation-transport.ts](../../apps/desktop/src/main/federation/federation-transport.ts));
no second socket, no new handshake.

Control plane (RPC requests via `FederationRpcEndpoint`, capability-checked in
the router like `FEDERATION_BACKEND_METHODS`):

- `pty.open { backend, threadId, cols, rows }` → `{ sessionId }` — the owner
  resolves shell + cwd from ITS OWN thread state
  (`resolveTerminalShell`, worktree path). The viewer never sends a path or
  shell; a compromised viewer must not be able to pick the cwd or binary.
- `pty.input { sessionId, dataBase64 }` — keystrokes.
- `pty.resize { sessionId, cols, rows }`
- `pty.ack { sessionId, bytes }` — flow control (below).
- `pty.close { sessionId }`

Stream plane (notifications, owner → viewer, same envelope kind as
`backend.event`):

- `pty.output { sessionId, seq, dataBase64 }` — chunked at ≤ 32 KiB.
- `pty.exit { sessionId, exitCode, signal? }`
- `pty.error { sessionId, message }`

`sessionId` is owner-generated (UUID). Sessions are keyed to the requesting
peer: only the opener's instanceId may write input to / close a session, and
output notifications target only that peer (never relayed by the gateway —
`hopCount` stays 0, mirroring how `relayRemoteBackendEvent` excludes
non-participants).

### Backpressure

The transport multiplexes RPC and PTY frames on one WebSocket; a runaway
`yes`-style output burst must not starve thread RPCs. Use ack-window flow
control on the owner:

- Owner counts unacked output bytes per session; viewer sends `pty.ack` every
  256 KiB consumed.
- Above a 1 MiB high-water mark the owner calls `IPty.pause()`, resuming below
  a 256 KiB low-water mark (`node-pty` supports pause/resume on all
  platforms we ship).
- Output chunks carry `seq` so the viewer can detect (and surface, not
  silently repair) a gap — the transport is ordered, so a gap means a bug.

### Owner-side service

New `apps/desktop/src/main/federation/federation-pty-service.ts` wrapping the
existing `IntegratedTerminalService` spawn/shell plumbing
([integrated-terminal-service.ts](../../apps/desktop/src/main/terminal/integrated-terminal-service.ts))
rather than duplicating it: extract the spawn/close/foreground-process core so
both the local IPC service and the federation service share it (same
close-during-spawn hardening). Reaping:

- `pty.close`, viewer window close, or peer disconnect → kill after a 10s
  grace (allows transport blips to reconnect without losing a running build;
  a reconnected viewer re-attaches by opening a new session — we do NOT
  persist scrollback server-side in v1).
- Owner shutdown → kill all remote sessions (same as local panel behavior).

### Viewer-side wiring

The renderer terminal panel already talks to the main process over
`INTEGRATED_TERMINAL_*` IPC. Keep the renderer protocol-unaware:

- In [ipc/integrated-terminal.ts](../../apps/desktop/src/main/ipc/integrated-terminal.ts),
  branch on `isFederationWindowWebContents(event.sender)`: federation windows
  route open/input/resize/close to the remote session and forward
  `pty.output`/`pty.exit`/`pty.error` back on the existing output/exit/error
  channels. Local windows are untouched.
- A federation window must NEVER fall through to a local spawn — the branch
  throws if the remote target is missing (same defense-in-depth shape as the
  #1202 PR-lookup guard).
- Re-show the terminal toggle for remote threads in `ThreadHeader.tsx` /
  `ThreadView.tsx`, disabled (with reason) when the peer lacks `remote_pty`
  or is disconnected.

### Explicitly out of scope (v1)

- Scrollback persistence / reattach to a still-running remote session.
- Multiple concurrent viewers of one PTY session.
- Gateway relay of PTY streams for client↔client topologies (sessions are
  point-to-point with the owning instance; a client viewing another client's
  thread through the gateway gets the disabled toggle until direct-dial or
  relay support lands).

## Verification

- [ ] Unit: capability mapping — every `pty.*` control method requires
      `remote_pty`; input/close from a non-opener peer is rejected.
- [ ] Unit: flow control — synthetic 10 MiB burst pauses the PTY at the
      high-water mark and resumes on acks; seq stays gapless.
- [ ] Unit: reaping — disconnect kills the session after grace; close-during-
      spawn does not leak a shell (reuses the existing hardening tests).
- [ ] Unit: federation-window IPC branch never reaches the local spawn path.
- [ ] E2E (two in-process instances, per the federation E2E plan): open remote
      terminal, run `echo`, assert output renders in the viewer and the
      process ran on the owner (marker file in the owner's worktree).
- [ ] Manual: interactive feel over Tailscale between two machines; resize;
      Ctrl-C; peer revokes `remote_pty` → toggle disables with reason.
