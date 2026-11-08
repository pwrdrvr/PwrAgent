# Fixed MCP gateway tool contracts

PwrAgent advertises `search_mcp_tools` and `call_mcp_tool` in the parent Agent
catalog. Both definitions stay registered while the external catalog changes.
The existing PwrAgent tool search can reveal these deferred definitions in
Codex. ACP receives them through the existing PwrAgent MCP server.

Search returns the original server display name, stable connection ID, tool
name, exact MCP definition and opaque schema revision. Invoke through
`pwragent.call_mcp_tool` (or `tools.pwragent__call_mcp_tool` in Code Mode) using
`connectionId`, `toolName`, `schemaRevision` and an `arguments` object. A returned
upstream name is not a newly registered native tool.

## Authorization and execution

The registry derives backend, thread and turn from the authenticated tool-call
context. It checks that the turn is active and reads its current selection.
Messaging-originated calls additionally require `tools.instance_management`.
The selected connection must be enabled and authorized on the owning profile
broker. The owner re-reads the thread selection after discovery and before
invocation, including when another process changed it. The model cannot supply
another thread identity, endpoint or credential.

Full Access approves gateway invocations automatically, including headless
automations. Codex uses the active turn's applied mode, falling back to the
automation mode or saved thread mode when no active mode is recorded. Claude's
Full Access is bypass permissions. Claude uses its open process's permission
mode, so a change during the turn applies to the next call, falling back to
the automation mode or saved thread mode when no process is open. Under bypass
permissions Claude asks for nothing itself, so the gateway card would be the
only prompt. ACP uses its runtime mode selector when present, otherwise its
session execution mode.

In Default and Auto the gateway card is the only prompt for a gateway call,
whichever backend runs the thread. Codex does not review PwrAgent's dynamic
tools. A Claude query pre-allows `mcp__pwragent__call_mcp_tool` through
`allowedTools`, so Claude does not ask through `canUseTool` before the gateway
does. The operator's own Claude `ask` and `deny` rules for the tool still
apply. See [Claude provider](claude-provider.md).

A Claude plan turn, the composer's Plan toggle, is read-only. Claude's `plan`
mode asks for every `call_mcp_tool` call, so in a plan turn PwrAgent's
permission handler passes the call to the gateway without a card only when
the SDK identifies the host-registered `pwragent` server (`source: "sdk"`)
and no operator `ask` rule matched. Rule-forced asks, configured namesakes,
and calls without origin metadata keep Claude's approval card. The gateway
then runs an upstream tool marked read-only (`readOnlyHint` true and
`destructiveHint` not true) under the connection's tool-approval policy, as in
any other turn. It refuses any other tool before Full Access, automation
grants or conversation approvals are consulted, shows no card, and tells
Claude to put the step in its plan. A plan mode Claude entered on its own
keeps Claude's own card.

Selection, actor permissions, connection authorization and schema validation
still apply to every call. No permission is cached for the generic wrapper.

Default and Auto access follow the connection's tool-approval policy. The
built-in Sandboxer defaults to allowing tools: enabling and selecting remote
compute authorizes sandbox commands, file writes and lifecycle operations.
Other connections default to the server's annotation-based policy, which runs
read-only tools without confirmation. An explicit `prompt` policy also asks
for reads; an explicit `approve` policy allows every tool on that connection.
When required, confirmation shows the original connection, tool and complete
arguments. Codex's App Server does not expose an
API for submitting host-owned dynamic calls to its Auto reviewer. Auto gateway
calls that need approval require human confirmation; PwrAgent does not use a model to choose MCP
consent or its persistence scope.
Headless calls without Full Access or an automation MCP grant decline because
they cannot obtain it.
Native invocation remains available under the backend's own policy; inherited
provider MCP servers are not exposed through this gateway.

Only the gateway's host-created invocation approval follows this policy.
Upstream MCP forms, including empty forms, and URL flows remain interactive:
their shape alone does not distinguish tool approval from a question or login.
For an identified MCP tool approval with an empty form, the desktop offers
the persistence scopes advertised in `_meta.persist`. **Allow this conversation**
returns `_meta: { persist: "session" }`; **Always allow** returns
`_meta: { persist: "always" }`. Browser origin approvals use the same advertised
scopes. For upstream approvals, the server owns the grant's scope and storage.
Questions and login requests do not receive persistent grants.

Gateway confirmations offer a once-only grant, a tool conversation grant
(`session`), and a connection conversation grant (`server-session`). The last
scope is host-owned and is never forwarded to an upstream server. It permits
all tools in that connection's current catalog with any arguments, for this
backend and thread only. Consent is recorded in memory after the owner accepts
the invocation. It ends on shutdown, selection revocation, or a changed catalog
revision, which includes every tool's schema and authorization revision. Tool
listing order does not affect consent. Ordinary upstream MCP elicitation still
requires its own response.

### Upstream MCP forms on managed connections

A managed connection's server can ask a person a question in the middle of a
tool call with a form-mode `elicitation/create`, for example to confirm a
destructive removal. This is separate from the gateway's invocation approval
above. Approving the invocation, Full Access, a connection's tool-approval
policy and conversation grants never answer the server's form. Only the
person's own response does.

The owner broker's thread sessions, for both remote URL and local command
connections, declare `elicitation: { form: {}, url: {} }`. Local command
thread sessions also declare `roots: { listChanged: true }`. Settings
listings and connection tests declare no capabilities. Links are described in
"Upstream links" and roots in "Upstream roots" below.

MCP does not link a server's request to the client request that caused it,
and one session serves every request on a bridge grant. The owner therefore
routes a form to the request in flight on that exact upstream client. It
does so only when exactly one request is in flight and that request is a
tool call from a caller that can show forms. Every other case fails closed
with `-32601`, the error the server received before the capability was
declared:

- No request is in flight.
- Several requests are in flight.
- The request is not a tool call.
- The caller cannot show forms.
- The caller is a Job Monitor's read-only scope.
- The caller is a headless automation run.
- The turn is no longer live.

The routes are:

- **Native bridge.** The bridge forwards `tools/call` with the caller's form
  route only when the agent's MCP client declared form elicitation. It sends
  the form to that client with `relatedRequestId` set to the call.
- **Fixed gateway tools.** `call_mcp_tool` shows the form on the calling
  thread's card as `mcpServer/elicitation/request`, with a request ID that
  begins `mcp-upstream-form:`.

The forwarded form keeps the server's `message`, `requestedSchema`, `_meta`
and `mode` exactly as sent. This includes schema keywords that the SDK does
not model. The owner refuses a form whose `_meta` contains
`codex_approval_kind` or `pwragent_approval_kind`, because those keys would
draw it as a host tool approval. It does not rewrite those keys.

The owner checks each answer before it returns the answer upstream:

- An acceptance must include content that validates against the requested
  schema. An `accept` without content is refused. An empty form is refused
  when it does not validate.
- A decline or cancel carries no content.
- The client's `_meta` passes through unchanged.

PwrAgent records no answer, so the next form asks again.

The bridge RPC socket carries one request. A request opts in with
`elicitation: "form"`. The owner can then write
`{ "elicit": { id, params } }` lines on that socket before the final
`{ ok }` line. The requester replies with `elicitResult` or `elicitError`.
`elicitCancel` withdraws a form. The owner drops a reply for an ID that is
no longer open. An owner never sends a form to a request that did not opt
in. For that reason, either side may be an older build.

A pending form settles as `cancel` and is never answered later in these
cases:

- The caller disconnects, including bridge EOF.
- The call is cancelled or the turn ends.
- The upstream server exits or its session closes.
- The thread stops selecting the connection.
- The grant is revoked.

The card is withdrawn, and a late submission finds no pending request. The
owner checks the grant, the exact session and, for fixed gateway tools, the
thread's selection both before it asks and before it delivers an answer.
After a reconnect, the replacement session can be answered only by its own
form. Nothing launches the server's desktop application to answer a form.

### Messaging confirmations

An upstream server can ask for a decision without requesting field values:
`requestedSchema: { type: "object", properties: {} }`. PwrAgent presents it
as **MCP Confirmation**, including the server's complete proposal. Its Allow
button returns `{ action: "accept", content: {} }`; Decline and Cancel never
accept it. Required input fields still need the desktop form. URL-mode
acceptance still needs the desktop, which shows the address.

Messaging callbacks must identify the original pending card through its
durable handle or delivered surface. An old button never answers the newest
request. Text approval uses the displayed `approve <card code>` phrase;
a bare "yes", an action label or another card's phrase does not approve it.
The code distinguishes requests; it is not a credential. Existing actor,
conversation, binding and `approval.respond.escalation` RBAC checks apply.
Proposals that exceed the surface's complete-card limit offer no messaging
acceptance and direct the person to desktop. Telegram and Discord declare
complete multipart approval delivery; Feishu declares its smaller card limit.
These confirmations never inherit tool grants or Auto/Full Access consent.
A disconnected or expired originating operation cannot be revived by a
restored card or late callback.

PwrDisk uses this empty-form contract to request Trash, permanent deletion
or owner-cleanup approval for its expiring, single-use native preview. The
server remains responsible for exact plan validation and execution guards.
`PWRDISK_APPROVAL_TEST_BINARY=/absolute/path/to/pwrdisk pnpm test
apps/desktop/src/main/__tests__/messaging-controller.test.ts -t 'round trips
PwrDisk deletion through fake messaging'` runs an opt-in smoke against a real
PwrDisk MCP binary. It uses the actual upstream relay and messaging controller
with simulated human callbacks and a fixture-only native-window stand-in;
only owned disposable files can be removed. It does not contact a provider,
start a desktop window or validate installed builds. Unit suites separately
cover gateway authority, lifecycle teardown, callbacks and actor isolation.

### Upstream links

A server can ask the person to open a page with a URL-mode
`elicitation/create`, usually to sign in to a service behind it. Links use
the same routing as forms: exactly one tool call in flight on that session,
from a caller that can show links, or the request fails closed with
`-32601`. A caller that can show forms but not links also fails closed.

Before any person sees a link, the owner refuses it with `-32602` when:

- The request has no `message`, no `elicitationId`, or no `url`.
- The address does not parse, or carries a user name or password.
- The address is not `https`. A local command may also send `http` to this
  machine (`localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, the hosts the
  desktop card accepts). A remote server may not, because the link would
  point the person's browser at whatever else listens locally.
- `_meta` contains `codex_approval_kind` or `pwragent_approval_kind`.

The routes are:

- **Native bridge.** The bridge forwards the link to the agent's MCP client
  only when that client declared `elicitation.url`. A client that declared
  only forms is never sent a link.
- **Fixed gateway tools.** `call_mcp_tool` shows the link on the calling
  thread's card as a `mode: "url"` `mcpServer/elicitation/request`. The card
  shows the host and the full address as text. Nothing opens until the
  person chooses **Open in browser**, which hands the address to the system
  browser. Messaging surfaces show only the host and send the person to the
  desktop to open it.

An acceptance means only that the person chose to open the page. It goes
upstream as `{ action: "accept" }` with no content; the server learns
whether its flow finished on its own. Decline and cancel work as for forms,
and a pending link settles as `cancel` on every teardown path listed above.

`notifications/elicitation/complete` reaches a native bridge only for a link
that bridge's client opened, at most once, and only while the session that
sent the link is current. The bridge passes it on only to a client that
declared `elicitation.url`. Every other ID is ignored. A fixed gateway call
has no card left to update, so its completions are dropped.

A tool call can instead fail with `-32042` (URL elicitation required):

- **Native bridge.** The error passes through unchanged, with its data. When
  the bridge's client can show links, a later
  `notifications/elicitation/complete` for a listed link reaches it.
- **Fixed gateway tools.** The owner shows each listed link in turn, at most
  three, on the calling thread's card. It then returns the original error to
  the agent with a note saying whether the person opened the page. The call
  is never retried: the server may have done part of the work before it
  failed, so only the agent decides to call again.

A bridge request opts in to links with `urlElicitation: "open"` beside
`elicitation: "form"`. An owner sends a URL-mode `elicit` line only to a
request that sent both. An older owner ignores the field, and an older
bridge never receives a link.

### Upstream roots

A local command's server can ask `roots/list` for the directories it may
work in. Its thread session answers with the directories of the thread the
grant serves: each linked directory, with the thread's working directory
first. A worktree is given as its own checkout, not its repository. A thread
with no linked directory has no roots, even when its working directory falls
back to something else.

Each root is a `file://` URI. The label of a linked directory becomes the
root's `name`. Relative paths, repeats and directories that no longer exist
are dropped, and at most 64 roots are sent.

A grant's thread comes from its scope. A fixed gateway scope names the
backend and thread. A native bridge records the backend of its bare thread
ID when it is registered. A grant with no thread yet, or a bare thread ID
with no backend, answers an empty list. A Job Monitor's delegated scope gets
its own thread's directories. Headless automation runs are answered like any
other thread, because roots need no person.

Remote URL, PwrSnap, PwrGit and Sandboxer connections never declare roots.
A `file://` path means nothing to them, and it would expose the operator's
home directory, user name and repository names.

The instance that runs the thread reads its directories and reports them to
the owner broker, which may be another instance on the same profile. It
reports when a grant is registered or bound to a thread, at most once every
10 seconds per thread, and again whenever the thread's directories change
(`navigation/threadDirectories/updated`). Reports for one thread reach the
owner in order. The owner keeps the latest list in memory only; nothing is
written to SQLite. It holds at most 512 threads' lists and never drops one
that a live grant serves. When a session's list differs
from the one it last read, the owner sends it
`notifications/roots/list_changed` once. A session that never asked is not
told.

PwrAgent does not pass through or intersect a native host's own roots. The
host's working directory comes from the same thread directories, and fixed
gateway calls have no host roots. A peer-owned thread runs on the peer, whose
gateway answers from its own directories. Roots never cross federation.

Some servers, such as `@modelcontextprotocol/server-filesystem`, replace the
directories in their arguments with the roots a client gives them. In a
thread with directories, such a server works in those directories. In a
thread with none, the empty list leaves its arguments in effect.

### Upstream progress

A managed thread session asks the upstream server for progress on every tool
call. The SDK sends the server PwrAgent's own progress token, never the
caller's.

- Each report restarts the call's 12-minute timeout.
- A call that reports progress can run for up to 60 minutes in total.
- A call that reports nothing still fails after 12 minutes.

A native bridge passes each report on to the agent's MCP client, tied to the
call and under the token that client sent. If the client sent no token, the
reports only keep the call alive. A fixed `call_mcp_tool` call uses the
reports the same way, but it does not show them on the thread's card.

A bridge request opts in with `progress: "notify"`. The owner can then write
`{ "progress": { progress, total?, message? } }` lines on that socket before
the final `{ ok }` line. Each line also restarts the requester's own socket
timer. An owner never sends progress to a request that did not opt in. A
request from an older bridge keeps its old behavior: its token goes to the
server as sent, and the call has a fixed 12-minute limit.

Native Codex hosts get an absolute `tool_timeout_sec` of 61 minutes. Codex
does not reset that limit on progress, so the extra minute lets the gateway's
60-minute deadline return first. The gateway and bridge still stop a silent
call after 12 minutes. If the bridge wedges and cannot return a timeout,
Codex can wait up to 61 minutes.

### Automation MCP grants

An automation's saved MCP server and tool allowlists are advance approval for
those operations, including in Default and Auto access. The headless runner
forwards them to the registry. Each ephemeral Codex thread receives per-run
MCP configuration that disables servers outside the list, pre-approves the
allowed tools, and applies any tool restriction through `enabled_tools`. An
explicitly allowed server is required at startup so its tools are not silently
omitted. A blank server list inherits the Agent's servers and preserves their
enabled/optional settings. Shell access remains governed by the run's execution
mode; MCP authorization does not change the sandbox.

Managed connections receive fresh bridges bound to the execution thread. The
registry resolves the allowlist against connection IDs, the Agent's server
aliases, and unambiguous connection display names. It retains the allowed IDs
and tool restrictions in memory before `turn/start`, so early gateway calls can
use that grant. Every gateway operation rechecks the Agent's current selection.
Grants are revoked on failed startup, turn completion, and shutdown. Unknown or
ambiguous saved server names fail explicitly without creating a transport-less
Codex configuration entry.

This authorization also answers native Codex MCP tool consent when the request
identifies an approval, has an empty form, and matches the run's approved server
and tool. The registry rechecks the Agent's selection and the active run before
responding. It returns the advertised conversation scope (`persist: "session"`)
when available; otherwise it accepts that request once. An unattended run never
creates an `always` grant. Upstream MCP questions and URL/login flows still need
interaction and are cancelled in headless runs.

For interactive Codex threads, **Allow all tools** also accepts native MCP tool
approval requests for the exact managed bridge currently registered to the
active thread. The connection must still be enabled, configured and selected.
PwrAgent rechecks selection and bridge identity after reading policy and accepts
only that invocation, without creating a Codex conversation or permanent grant.
Input forms, upstream confirmations and OAuth URL requests remain interactive.

Arguments are validated before requesting approval. After approval, the owner
broker lists the tools again, compares the revision, validates the arguments and
calls the original upstream name. Revisions bind the tool definition to the
thread's bridge grant and connection authorization generation. Changes while
approval is pending require a new search and confirmation. JSON Schema drafts
7, 2019-09 and 2020-12 are supported; absent `$schema` uses 2020-12. Formats are
annotations. Validation never coerces arguments or resolves remote references.

MCP errors retain their code and data in the generic tool's error envelope.
Upstream tool errors retain `isError`; structured content, resources, images
and audio survive the adapters. Dynamic responses emit image/audio payloads
once as native content items, with the rest of the result and source identity
in text. MCP responses retain the original result and add `pwragent/source`
metadata.

## Lifetime and bounds

There is no persistent or shared search-result cache. Every search reads the
current selected catalogs with bounded concurrency and a total deadline. The
owner also invalidates revisions on tool-list notifications, authorization
changes, disabling and disconnecting. Duplicate names within one server and
repeated or incomplete pagination are rejected. Identical tool names on
different connections remain distinct.

Discovery has one 60-second allowance for registration, remote initialization
and all catalog pages. Settings uses the same allowance. The local RPC and
search safety timers allow one additional second to deliver the owner's phase
error; that second does not extend upstream work. Native Codex bridges set
`startup_timeout_sec` to 75 for process overhead and preserve the discovery
deadline from initialization through the initial catalog and its cursors.
Tool execution keeps its separate 12-minute allowance, which the server's
progress reports can extend (see "Upstream progress").
Gateway call RPCs carry the short discovery deadline for catalog validation
while their sockets retain the 12-minute call allowance. Completing discovery
stops its timer before tool execution. Native catalog continuations use opaque
bridge tokens that retain each read's upstream cursor and original deadline;
overlapping reads remain independent even when upstream cursors are identical.

Initialization and token refresh are shared only while they have waiters.
Cancelling one waiter leaves siblings running; losing the last waiter aborts
the unfinished start and removes it before a retry. Discovery POSTs receive the
request's abort signal even with SDK v1's session-wide transport signal.
Successful sessions remain available to sibling requests after a list timeout.

Phase logs include a discovery ID, elapsed time and catalog page number.
HTTP logs identify each physical request's method and origin/path before
sending it, then record status and elapsed time when response headers arrive.
Query strings, fragments, credential-like path segments and long opaque path
segments are omitted or redacted. Redirect hops are logged at their actual
destinations. A failure before headers has a separate event; these logs do not
record header contents or request/response bodies.
Initialization join events connect caller IDs to shared start IDs. RPCs carry
the caller discovery ID, and owner logs include the thread scope. Failures
distinguish local deadlines, cancellation, SDK timeouts, authorization, HTTP
status and network error codes. Upstream response bodies, messages, headers and
payloads are excluded. Connection status reports in-memory catalog health and
last successful/failed discovery separately from stored authorization. A newer
gateway failure overrides an older catalog retained in Settings. Healthy search
results survive another connection's discovery failure.

Each managed Settings row exposes **Test connection** without opening its tool
drawer. It bypasses the catalog cache and performs initialization and every
tool-list page under the discovery deadline. The row shows progress, tool count
and elapsed time on success, or the phase diagnostic on failure. The test reads
the catalog without invoking a tool or changing the connection's configuration.

Selection changes, turn termination and shutdown cancel outstanding gateway
work. MCP request cancellation propagates through the local socket to the
upstream SDK signal without closing healthy sibling calls. This covers tool
calls, resource listings, reads and subscriptions, and prompt listings and
reads. Disabling or
disconnecting a connection closes its sessions, including invalidating sessions
that are still opening. Cancellation cannot undo an already completed external
effect; the gateway never automatically retries side effects.

Search pages have a 24 KB schema budget and never truncate a schema. A single
oversized definition requires native invocation. Arguments are limited to
16 KB so the confirmation can display them completely. Catalog reads allow at
most 20 pages, 2,000 tools and 2 MB per connection. Search scans at most 64
selected connections, four at a time, with an 8 MB combined catalog budget.
Unsupported upstream callbacks such as
sampling remain unsupported by the existing connection bridge.

## Backend compatibility

Existing Codex threads receive the two fixed tools at an idle/next-turn
replacement boundary when their runtime advertises `dynamicToolsResumeField`.
Once registered, they can discover additions during a turn. Older runtimes
without this capability need a new thread or supported reload that actually
installs the entry tools. An ACP session that predates the entry tools needs
its next session load. Search descriptions cannot bootstrap missing contracts.

This does not change native MCP server refresh. Direct named tools and their
per-connection registrations remain available. Only PwrAgent-managed,
currently selected connections are accessible through the fixed entry tools.

## Token Miser and accounting

Search results use host-issued exact-delivery receipts on Codex. Code Mode
must emit the returned string unchanged. Direct results and mixed Code Mode
results use the existing authenticated receipt path; search fails explicitly
if protected delivery cannot be prepared. Outer output caps still apply.

The existing invocation and Token Miser member retain the requested original
connection/tool pair. The invocation result additionally carries the approved
source revision. No second invocation event or output charge is added. Catalogs,
approvals and receipts are in memory. The registry integration test measures
zero additional SQLite commits for search, approval and invocation: zero
commits/second × commit cost × 86,400 seconds = **0 MB/day**. Existing backend
event accounting and broker startup retain their existing budgets.

Tests cover live additions, selection isolation, schema changes, approval
denial and cancellation, cross-process owner dispatch, stale authorization
during connection, Token Miser exact delivery and the zero-write budget.
They use local fixtures and mock upstream clients; no live inference or
operator connections are required.
