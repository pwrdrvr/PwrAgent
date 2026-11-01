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
automation mode or saved thread mode when no active mode is recorded. ACP uses
its runtime mode selector when present, otherwise its session execution mode.
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
connections, declare `elicitation: { form: {} }`. Settings listings and
connection tests declare no capabilities. URL mode stays unsupported, so the
SDK refuses it.

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
Tool execution keeps its separate 12-minute allowance.
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
upstream SDK signal without closing healthy sibling calls. Disabling or
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
