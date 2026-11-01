# Local command (stdio) MCP connections

A PwrAgent-managed connection can be a remote URL that signs in with OAuth or
a local command that PwrAgent starts and talks to over stdin and stdout. Both
reach agents through the same managed gateway: the per-connection bridge
server that Codex and ACP agents load, and the fixed `search_mcp_tools` /
`call_mcp_tool` entry tools. Offer to threads, Select for new threads, the
thread MCP access panel, and tool approval work the same for both.

The operator adds one in **Settings → Plugins → Add an MCP server → Local
command**. An agent cannot add one: `manage_mcp_connections` still probes and
stores URLs only, so a model can never choose a program for PwrAgent to run.

Design review: [Claude Design, PwrAgent project](https://claude.ai/design/p/019df437-879b-7ea9-89a7-aa689d28f06f?file=Local+Command+MCP+Connections+UX+Review.html):
`Local Command MCP Connections UX Review.html`.

## Code map

| Piece | File |
|---|---|
| Contract, splitter, display line, setup state | `packages/shared/src/contracts/mcp-connections.ts` |
| Validation, executable lookup, environment, owned transport | `apps/desktop/src/main/mcp-connections/mcp-stdio-launch.ts` |
| Encrypted secret values | `apps/desktop/src/main/mcp-connections/mcp-stdio-secret-vault.ts` |
| Rows in `config.toml` | `apps/desktop/src/main/mcp-connections/mcp-connection-registry.ts` |
| Test, sessions, attach lease, cleanup | `apps/desktop/src/main/mcp-connections/mcp-connection-gateway-service.ts` |
| Settings form and row | `apps/desktop/src/renderer/src/features/settings/LocalCommandConnectionForm.tsx`, `PluginsSettings.tsx` |

## Stored shape

A local command is one `[[mcp_connections.connections]]` row:

```toml
[[mcp_connections.connections]]
id = "project-files"
display_name = "Project files"
transport = "stdio"
command = "/opt/homebrew/bin/npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Projects"]
cwd = "/Users/you/Projects"            # optional; home folder when absent
env = ["LOG_LEVEL=info"]               # plain variables, NAME=value
secret_env = ["API_TOKEN"]             # names only
enabled = true
select_for_new_threads = false
tool_approval = "auto"
```

- `args` is an array, never one string. The form takes one command line, as
  a server's README gives it, and splits it once (`splitMcpCommandLine`:
  quotes group, a backslash escapes only before whitespace, a quote or a
  backslash, nothing expands). It shows the resulting words under the field.
  Leading `NAME=value` words move into the variable rows, marked secret when
  the name looks like a token or key. PwrAgent never re-parses a stored
  string; the edit dialog shows the stored argv re-quoted
  (`formatMcpCommandLine`), which splits back to the same words.
- `command` is the absolute path found when the operator tested or saved it.
  A bare name is resolved on the login-shell PATH that Codex uses, once, so a
  later PATH change cannot silently swap in another program of the same name.
- Secret values live in the profile's encrypted secret store under
  `mcpStdioConnectionSecrets`, a JSON envelope keyed by connection id and then
  variable name. They are never written to `config.toml`, sent to a window,
  sent to a federation peer, or written to a log. Every write is read back;
  a store that drops a value fails the save instead of failing a later start.

### Config evolution

This is a new row shape, not a change to an existing key, so the
[config-file-evolution](config-file-evolution.md) rules apply as follows:

- **Read fallback.** A row with `transport = "stdio"` is read as a local
  command. Any other row, including one with another `transport` value, keeps
  the URL shape it always had.
- **Older builds.** A stdio row has no `server_url`, so a build from before
  this change skips it. The registry's merge keeps rows it cannot read
  verbatim on every rewrite, so an older build that changes another
  connection does not delete it. The secret slot is separate from the OAuth
  credential envelope, so an older build's OAuth writes cannot drop it.
- **Lazy conversion, legacy comment, dual write.** Not needed: no existing
  shape changes meaning, and no key is written in two forms.
- Editing a row deletes `cwd`, `env` and `secret_env` when the operator
  clears them, rather than leaving stale keys behind.

## Where it runs and with what

- On the machine that owns the profile's MCP broker, as the operator's
  account. In a multi-instance profile every instance forwards create, test,
  and session work to that owner (`broker/create`, `broker/test-stdio`,
  `broker/close-thread-sessions`). A federation peer sees only the
  connection's name and state; `mcpConnectionsForPeer` strips the launch and
  any server output.
- The test and all Settings mutations are local-owner IPC only; a peer's
  window cannot start a program on the owner's machine.
- Spawned with `shell: false` and an argv array. On Windows, a `.cmd` or
  `.bat` shim (such as `npx.cmd`) can only run under `cmd.exe`, so
  `createCommandInvocation` wraps it in `cmd.exe /d /s /c` with each argument
  escaped, the same path ACP agent launches take. Everything else starts
  directly.
- The environment is an allowlist, not PwrAgent's own environment: `HOME`,
  `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`
  (and the Windows equivalents), plus the login-shell `PATH` with the
  command's own folder first, plus the connection's variables, which win.
  Values that look like exported shell functions are dropped. Nothing from
  Electron, PwrAgent, or the agent's environment leaks in.

## Session scope

**One process per thread and connection.** Stdio servers keep state per
process: a filesystem server's allowed roots, a browser server's open page, a
database server's transaction, Sandboxer's "last sandbox used". Sharing a
process between threads would let one thread's state answer another's call,
which is the isolation the gateway gives remote servers through one upstream
session per grant. Each bridge grant (thread × connection) therefore gets its
own process, created lazily on the first request.

The process stops when any of these happens, with no timer involved:

| Event | Mechanism |
|---|---|
| The agent's bridge child exits | The bridge holds an `attach` socket to the gateway from startup. When the last one for a grant closes, the gateway closes that grant's session. |
| The thread turns the connection off | `setThreadMcpConnections` calls `closeThreadSessions` for the released ids. |
| The command is edited | Sessions close; the next call starts the new version. |
| Offer to threads turned off, connection removed, or gateway switched off | Existing session closure paths. |
| PwrAgent quits | `close()` destroys attach sockets, test processes, and sessions. |

A Settings test or tool listing starts a short-lived process of its own and
stops it on every path out, including failure and shutdown. Only thread
sessions count toward the row's **Running · N threads** chip.

## Process ownership

The SDK's `StdioClientTransport` signals only its direct child. `npx`, `uvx`
and `docker run` start the real server as a grandchild, which survives that.
`OwnedStdioClientTransport` instead makes the server a process-group leader
(`detached` on POSIX) and stops the group with `terminateOwnedProcessTree`:
stdin is closed first, then the tree is terminated gracefully, then forced.
When the server exits on its own, the rest of its group is reaped too. On
Windows the tree is stopped with `taskkill /T`.

`mcp-stdio-connections.test.ts` asserts this against a fake server that
starts a grandchild: closing a thread's lease stops both processes, and the
other thread's process keeps running.

## Startup errors

A test, or a thread's first call, reports one of: `not_found`,
`not_executable`, `invalid`, `secret_unavailable`, `spawn_failed`, `exited`,
`no_handshake`, or `gateway_off`. The last 4 KB of the server's stderr is kept
with ANSI sequences stripped and every stored secret value masked. That
output goes only to Settings (the test result and the row's last failure). An
agent receives PwrAgent's one-sentence message, never server output.

## Limitations

- The bridge forwards tools, resources and prompts. Form elicitation during
  a tool call is routed to the caller; see "Upstream MCP forms on managed
  connections" in [mcp-gateway-tools.md](mcp-gateway-tools.md). Other
  server-to-client requests (sampling, URL elicitation, roots) and progress
  and log notifications from a local server are not forwarded.
- On Windows, a descendant that detaches from its parent before the server
  exits can escape `taskkill /T`. POSIX process groups do not have this gap
  unless a descendant deliberately starts its own session.
- If the gateway restarts while a bridge is alive, its attach socket closes
  and ends the native bridge. The host must reconnect explicitly.
- Native hosts receive advertised discovery-change notifications. A host
  that does not rediscover after them needs an explicit MCP reconnect.
  Fixed gateway tool searches always read the current catalog.

## Desktop-owned session contract

A desktop relay is a local command whose MCP surface belongs to an already
running application. PwrAgent starts the configured relay only. The built-in
PwrSnap and PwrGit Connect flows also require a running endpoint; they do not
launch an installed desktop as a side effect of connecting.

The native bridge forwards the upstream initialization identity, instructions
and `_meta`, including desktop/relay versions when the server supplies them.
Gateway search returns those identities in `servers`. Ownership metadata stays
as supplied: a standalone process is not described as desktop-authoritative.
Application release numbers are not a compatibility test or a reason to stop
a live session.

Tool revisions bind to the actual upstream session as well as its definitions
and authorization generation. Every gateway call lists and validates again
after approval. A replacement session therefore cannot consume an outstanding
approval, even if its tool definition is byte-identical. Calls are never
replayed on failure. Existing connection-wide consent remains tied to the
catalog and authorization; a new schema does not broaden it.

The native bridge advertises upstream tool, prompt and resource list-change
capabilities. Supported notifications travel over the existing authenticated
attach socket. Resource subscriptions are explicit and their update
notifications are forwarded; PwrAgent keeps no resource-content cache here.
A tool-list change also invalidates the separate Settings tool-name cache.
The SDK still owns protocol negotiation; the metadata transport preserves
initialize extensions without replacing its negotiation or client capability
handling.

Stdio EOF ends the native bridge and blocks reopening that grant implicitly.
The error instructs the operator to start the desktop independently, turn the
connection off and on in the thread MCP access panel, then rediscover tools
and reread relevant skills/resources. A native host must reconnect its MCP
bridge to receive fresh initialization data. Already injected instructions
or resource text can remain in conversation history. Neither a reconnect nor
fresh discovery authorizes replaying writes or reusing elicitation responses.
The existing off/on action is explicit and leaves other threads' sessions
alone; discovery refresh does not terminate active sessions.
