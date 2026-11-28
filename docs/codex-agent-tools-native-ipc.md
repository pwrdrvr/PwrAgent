# PwrAgent tools over native MCP stdio

[PR #4368](https://github.com/pwrdrvr/PwrAgent/pull/4368) introduced the
default-off `pwragent_apps` experiment. The owner issued a loopback Streamable
HTTP URL and a bearer grant for each thread. This follow-up issues a required
stdio server configuration with an absolute relay command, a private endpoint
argument, and an environment-scoped registration grant. The owner retains
the MCP catalog, instructions, enumeration, and tool dispatcher. Local
Claude Code and the verified Antigravity ACP worker can use the same relay on
macOS. The separate Codex PDF MCP server still uses HTTP.

## Transport comparison

| Implementation | Process and protocol ownership | Reuse in this prototype |
| --- | --- | --- |
| [PwrAgent connection bridge](../apps/desktop/src/main/mcp-connections/mcp-connection-bridge-entry.ts) and [gateway](../apps/desktop/src/main/mcp-connections/mcp-connection-gateway-service.ts) | The bridge is an MCP server for selected upstream connections. It mirrors discovery, tools, progress, and resources using grant-scoped RPC to the gateway. The gateway owns the upstream clients and session lifecycle. | Follow the gateway's short random endpoint and per-thread registration pattern. The agent-tool relay needs neither an SDK instance nor upstream RPC in the relay. |
| [PwrSnap bundled relay](https://github.com/pwrdrvr/PwrSnap/blob/8686d6fb5626c364592a5f2960db9cd80d6df2ab/docs/mcp-third-party-agents.md) | Rust client and listener exchange a short greeting before passing bytes. The listener multiplexes connections over inherited stdio. Electron serves MCP and applies live consent. The build produces signed native resources for each platform. | Use the byte relay and private endpoint model. PwrAgent can listen in Node on Unix and pass only the connected descriptor to a short-lived identity probe. |
| [PwrGit native relay](https://github.com/pwrdrvr/PwrGit/blob/c79d1ddeba52cc0f19f80c13c6c7a904fa22247f/docs/desktop-owned-mcp.md) | Builds on PwrSnap. Its Windows listener uses a protected SID-only DACL, rejects remote clients, reserves the first instance, and cancels outstanding I/O at teardown. Electron owns role grants and dispatch. | Use those owner-side controls for a future Windows listener. The native relay client already in PwrAgent has connected-server SID verification and overlapped pipe I/O. |
| [PwrAgent MCP stdio relay](../apps/desktop/native/mcp-stdio-relay) | A Rust executable verifies a private Unix socket or Windows pipe and forwards stdio bytes after the registration preamble. | Reuse the same relay across providers. The existing C executable still serves HTTP IPC and the file and maintenance helpers. |

The Rust crate records the PwrGit and PwrDisk MIT notices and the locked
dependency notices. Desktop release preparation builds each target before
signing. Outpost installs build the target from the packed Rust sources and
lockfile. Outpost can still install without Cargo and use its existing HTTP
and Dynamic Tools paths. A requested native configuration requires the relay.

## Claude and ACP launch support

- On macOS, PwrAgent obtains the actual native Claude CLI child from the Agent SDK's
  local spawn hook. It pins that child before delivering its owned MCP server
  over the SDK control channel. If the proof or connection fails, Claude
  receives the existing HTTP configuration, as do script launchers and
  injected drivers. Other servers remain in their normal SDK delivery path.
- Antigravity ACP 1.5.18 with `--process-per-session` on macOS lets the owner pin
  the local ACP process before sending `session/new` or `session/load`. The
  session worker launches the relay under that process. The native grant
  follows the session and is revoked when it closes or the root exits.
- Other ACP builds, transports without an owned child, and full ACP protocol
  captures use the existing HTTP registration or the stdio-to-HTTP bridge
  selected by ACP capability. Managed reviews keep their own HTTP registration.
  Linux and Windows Claude/ACP combinations use these existing paths.

## Unix admission and lifetime

1. The owner lazily creates a socket in a new mode-0700 directory under
   the system's short `/tmp` path and sets the socket to mode 0600. The
   versioned preamble carries a 256-bit in-memory registration grant.
   Before sending any grant bytes, the relay verifies the connected endpoint
   with the existing native helper. The grant travels in the Codex launch
   environment. The grant stays out of command arguments and relay diagnostics,
   and the App Server protocol observer redacts MCP launch-environment values.
2. The provider adapter binds the grant before sending its MCP configuration.
   The Codex desktop adapter does this immediately before forwarding
   the actual start, fork, or resume to the selected App Server generation.
   It takes the live child it owns from that generation's stdio transport.
   A native probe verifies that child belongs directly to this owner and
   records its OS process generation. The grant may be prepared before the
   thread ID exists, which lets Codex initialize and discover tools during
   thread creation.
3. After receiving a valid preamble, the owner gives the native probe the
   accepted socket as fd 3. The probe reads connection credentials and
   walks the live parent chain. The owner requires an exact match with the
   pinned root within four parent hops. Local launchers may use exec or
   retain up to three live wrapper processes. Detached wrappers, an
   exited ancestor, a different runtime generation, or an unverifiable
   process observation cannot establish a session.
4. Every MCP message stays scoped to the live grant and runtime. Tool
   dispatch also requires a bound thread, a unique active turn on that thread,
   the matching `_meta.threadId` for Codex, and the owner's
   existing tool authorization. Initialization assigns the stdio stream a
   session identity for tools that key mutation admission by wire request
   ID. Acknowledgement-dependent effects wait for the owner socket write
   callback. A new stream has its own identity and carries no replay state.
5. A fork receives a fresh grant and binds it to the new thread. Resume on
   the same App Server reuses the existing grant. Rebinding after an App
   Server replacement closes the old streams. An owner restart creates a
   new endpoint and grants from the existing per-thread transport selection.
   Orderly shutdown closes streams and removes the socket and directory.
   A force-killed owner can leave an inert socket pathname in its private
   directory. The next owner uses a fresh directory, so it never takes over
   that pathname or grant.

Ancestry proves where the connected peer ran at admission. The grant and
the thread and turn checks establish what it can call. A process with the
ability to control the expected App Server, read the relay's memory, or
take over its connected descriptor is inside this local trust boundary.
Several threads may share an App Server, so ancestry alone cannot
distinguish them. A runtime on another machine can use this transport if the
owning PwrAgent and launched Codex are local to each other on that machine.
A launcher that crosses a machine, user, or PID namespace boundary has no
local owned ancestry proof here. Forwarding a socket or accepting a PID
from the relay would lose that proof.

## Platform compatibility

| Platform | Connected identity and ancestry | Compatibility |
| --- | --- | --- |
| macOS | `getpeereid` verifies the connected UID. `LOCAL_PEERTOKEN` supplies the connector's PID and audit PID version. The process probe checks that version and follows exact process and parent unique IDs, then rereads the chain. [XNU process info ABI](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h) | The prototype uses a libproc flavor outside the public SDK header. If it is unavailable or returns a different record size, admission fails closed. Minimum supported macOS and signed builds need separate verification before graduating the experiment. |
| Linux | `SO_PEERCRED` provides UID and PID. `SO_PEERPIDFD` gives a handle to the connected process, which must still be live after the `/proc` ancestry walk. Process start times accompany PIDs. The walk rechecks links and rejects parents started after their children. [Linux socket implementation](https://github.com/torvalds/linux/blob/master/net/core/sock.c), [procfs documentation](https://docs.kernel.org/filesystems/proc.html) | Requires Linux 6.5 or a kernel with the socket option backported and a readable local procfs view. Older kernels and restricted or split PID namespaces have no PID-only fallback. Linux start times have clock-tick granularity. |
| Windows | The relay can connect to a verified named pipe. An owner listener could obtain the actual client PID with `GetNamedPipeClientProcessId`, then hold a process handle and verify the SID and creation time. A Toolhelp parent chain is insufficient for strict proof because a caller with `PROCESS_CREATE_PROCESS` can select its reported parent. [Connected client PID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid), [Windows process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) | Owner-side admission is disabled. The Windows owner implementation below uses a protected listener and debugger creation events. The shipping owner remains gated pending platform compatibility evidence. |

A thread that requests the experiment requires successful relay launch and
admission. An unsupported runtime, unavailable helper, or failed ancestry
probe produces a startup error. Threads created with the setting off use
Dynamic Tools. A thread created with the experiment retains that choice
when it resumes or forks.

## Windows owner transport

[PR #4372](https://github.com/pwrdrvr/PwrAgent/pull/4372) verified actual
launch proof on one Windows stream. Its inventory inspector needed a
second handshake. This implementation gives each verified connection a
separate byte stream to the same owner. Stock Codex still starts the same
relay and the owner retains the grant, catalog, and call authorization.

### Endpoint and generation ownership

- The supervisor starts the selected executable suspended, associates it
  with a non-inheritable kill-on-close job, and resumes it under
  `DEBUG_PROCESS`. The job owns termination. Admission comes from actual
  debugger creation events, including when Windows reports a
  caller-selected parent. The kernel process object and handle challenge
  are the proof used in #4372. If process-object comparison, job
  assignment, or event monitoring is unavailable, the generation cannot
  establish proof. [Process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
- The generation reserves a local public pipe name with first-instance
  protection, a protected current-user DACL, and remote-client rejection.
  Each peer must match a live debugger-recorded process and signal a
  fresh anonymous event duplicated into that exact process. The relay
  verifies the supervisor on the connected handle before sending a
  registration. Pins and workers are bounded. A stopped client cancels its
  pipe I/O without terminating other clients or the runtime.
- Successful proof allocates a private, random one-instance back pipe.
  Only its name travels through the inherited supervisor control stream.
  The native supervisor verifies the back connection against the live
  process object of its owner. Relay bytes then flow between two
  overlapped pipes. One blocked writer has a bounded deadline and cannot
  block another stream. There is no global payload buffer.
- The thread adapter replaces an owner-local registration alias with the
  selected runtime's address and supervisor identity just before
  forwarding the App Server request. The owner accepts a grant only on
  the runtime object it was bound to. Closing the owner control
  descriptor stops the runtime and retires its job and all pipe instances.
  A restart changes the endpoint and binds the existing thread's grant to
  a new generation. A managed fork gets its own registration.
- In-flight calls still use the owner’s thread and active-turn checks.
  A live pipe and successful launch proof do not authorize calls on
  another thread, calls after a turn ends, or calls after a grant is
  rebound. Paths, grants and handshake values stay out of public logs.

### Compatibility and rollout

The native test uses the packaged binary and the same owner admission
implementation as the desktop candidate. Its stock Codex 0.169.0 scenarios
use a direct native executable and Windows' unelevated sandbox in
read-only and workspace-write threads. It exercises concurrent sessions,
the inventory inspector, configuration reload, fork, and a restart
against a disposable profile and local model stub. The process oracle
also checks unauthorized clients, isolated stream closure, endpoint
removal, and process termination.

The product integration keeps the Windows path disabled until the
supported launch and sandbox combinations have evidence. Command
shims, brokered or remote launches, raised integrity, and alternate
debuggers can produce a different creator or process token, or deny
the needed process rights. No named-pipe owner or process-parent
lookup can substitute for that proof. Shipping also requires evidence
that debugger attachment has acceptable interaction with sandbox setup,
root crashes, and supported launcher packaging.

Run `node apps/desktop/scripts/run-windows-codex-mcp-prototype.mjs <codex.exe>`
from a native Windows checkout with MSVC. The hosted Windows workflow
supplies the pinned release and runs the same oracle without an account.
