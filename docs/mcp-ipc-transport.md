# HTTP MCP over native IPC

PwrAgent's managed gateway accepts these URLs in the existing server URL
field, following the [VS Code MCP reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#http-and-server-sent-events-sse-servers):

```text
unix:///Users/example/Library/Application%20Support/Example/mcp/server.sock#/mcp
unix:///run/user/1000/example-mcp/server.sock#/mcp?mode=local
pipe:///pipe/example-mcp#/mcp
```

Replace the example endpoint with the running server's endpoint. These are
HTTP connections; a raw JSON-RPC stream or stdio relay is a different
transport. PwrAgent starts only its own byte-relay helper, never the server
app. No TCP listener, URL fallback or shell command is involved.

The URL before `#` identifies the socket or local pipe. Decode percent escapes
in that endpoint once (`%20` is a space; `%2520` is a literal `%20`). Encoded
separators, relative paths, dot segments, authorities, credentials, queries
before `#`, nested pipe names and remote UNC pipes are rejected. The fragment
is the HTTP request path and query, already URL-escaped. It defaults to `/`.
For example, `#/mcp/a%2Fb?q=%23%26` sends that exact HTTP request target;
it does not append anything to the filesystem path. HTTP targets requiring
URL normalization are rejected. Only canonical lowercase schemes are accepted.

The gateway-owning PwrAgent instance resolves the endpoint. A window viewing
a remote instance does not open a socket on the viewing computer. macOS and
Linux support `unix://`; Windows supports `pipe://`. Other combinations fail
explicitly on the executing instance.

## Authentication and authorization

IPC connections use approval in the independently running server app, or a
server that requires no HTTP authentication. If native approval produces a
bearer ticket (as PwrSnap's direct IPC HTTP session approval does), check the
URL and paste the ticket into **Session bearer token** before adding it. A
same-user HTTP 401 asks for that token without opening an authenticated MCP
session or starting OAuth discovery. It does not yet prove the server's MCP
capabilities; those are negotiated when the selected thread connects.

The token is saved in PwrAgent's encrypted credential vault, bound to the
exact IPC URL. It is never returned in connection records or written to TOML
connection rows. Edit the connection to replace or clear it. Set tokens on
the instance owning the profile's gateway; the local broker deliberately
refuses forwarding a pasted secret to a different owner instance. No token
is sent before native peer verification, even for initialize or SSE GET.
HTTP error bodies are replaced with a fixed message so an echoed bearer
cannot enter SDK exceptions or connection status.

Settings does not automatically discover IPC tools: that could consume a
one-use native ticket before a thread uses it. An explicit **Test connection**
does open and close an MCP session and can consume that ticket. PwrSnap's
ticket permits one initialized session, so approve and paste a new ticket
for another thread/session or after a test. PwrAgent never requests a fresh
ticket, restarts the session or replays an operation automatically. Server
approval remains responsible for scopes, expiry and revocation.

Network HTTP retains its existing OAuth credential flow. PwrAgent does not
discover an authorization server, open a browser, use network OAuth tokens,
or follow HTTP redirects for IPC. No extra MCP permission is inferred from a
native ticket or from the verified OS identity.

Same-user identity is only the transport boundary. It grants no MCP scopes,
tool permissions or access to other threads. The existing connection enable
switch, per-thread selection, approval rules and capability negotiation still
apply. Disconnect clears its saved token, disables the connection and closes active sessions;
the server app owns revocation of any grant it issued. Changing the URL
closes sessions and discards any old OAuth credentials. No active operation
is replayed after a disconnect, and a failed transport cannot reconnect.

## Native identity checks

`native/mcp-ipc-relay/main.c` owns a single connected endpoint and relays
opaque HTTP bytes over its private child-process standard streams. It emits
a readiness marker only after verification. The HTTP adapter waits for that
marker before sending even an HTTP header. There is no JavaScript fallback
when native verification or helper loading fails.

On Unix, the helper requires a user-owned socket with no group/other mode
bits in a user-owned `0700` parent. It traverses directories with
`openat(O_NOFOLLOW)`, rejects foreign-owned or writable ancestors (allowing
root-owned sticky ancestors such as `/tmp`), and checks the socket type,
owner and inode before and after connecting. It rewalks the original path to
detect ancestor replacement. macOS extended allow ACLs are rejected. Use the
physical path, not a symlink such as `/var` on macOS. A socket directly under
`/tmp` is deliberately rejected; use a protected user directory beneath it.
Neither path permissions nor those race checks replace connected-peer
verification: Linux uses `SO_PEERCRED`, macOS uses `getpeereid`, and the peer's
effective UID must match `geteuid()`. Lookup failures reject the connection.

On Windows, the helper opens only `\\.\pipe\name` with identification-level
security so the server cannot impersonate the client. It queries the owner
of the **connected handle**, the connected server PID and its process token
user SID, comparing both SIDs to the current process's token user SID. It
holds the process handle, checks that the server is still alive and rechecks
the connected PID. Missing rights or identity information fail closed.
Environment account names and server-supplied identity claims are never used.

PwrAgent is a client and cannot impose an ACL or first-instance policy on a
server's endpoint. The server must create a protected, explicit user-only
DACL with the user as owner, reject remote clients and use first-instance
creation to resist squatting. It must verify its clients before dispatching
requests. Client peer verification rejects a squatter from another user;
it cannot distinguish malicious code running as the same OS user or defend
against an administrator controlling that user's processes.

The relevant primary API references are
[Linux Unix sockets](https://man7.org/linux/man-pages/man7/unix.7.html),
[Apple getpeereid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid),
[GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation),
and [CreateFile security quality of service](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

## Build and verification

`node apps/desktop/scripts/build-mcp-ipc-relay.mjs` builds a dependency-free C
helper with the host C toolchain. Development setup attempts the build before
launch; without a compiler, IPC remains unavailable while network HTTP and
stdio remain usable. A failed rebuild removes the old helper.
Packaging builds the target architecture in `beforePack`, copies only the
executable outside ASAR, and fails if the compiler or identity APIs are
unavailable. Windows uses the installed Visual Studio C++ toolchain, located
with `vswhere`; macOS uses `cc -arch` for each packaged architecture.

The URI tests cover escaping and ambiguous forms. The HTTP integration tests
build the native helper and run real SDK initialization, tools, resources,
prompts, annotations/metadata, fragmented responses, notifications, aborts,
disconnects and unsafe endpoint rejection. Run the Windows tests on native
Windows; Linux does not establish Windows token/pipe behavior.

The existing gateway uses Streamable HTTP without legacy SSE transport
fallback. IPC preserves that choice: SSE responses and the Streamable HTTP
notification stream work, but an old standalone `/sse` transport is not
silently substituted. Network HTTP and standard stdio paths are unchanged.
