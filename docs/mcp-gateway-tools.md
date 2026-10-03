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

Default and Auto access request once-only confirmation showing the original
connection, tool and complete arguments. Codex's App Server does not expose an
API for submitting host-owned dynamic calls to its Auto reviewer. Until that
integration exists, Auto gateway calls still require human confirmation.
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
scopes. The server owns the grant's scope and storage; PwrAgent does not cache
an allowance for every tool on that server. Questions and login requests do not
receive persistent grants. Gateway invocation confirmations do not advertise
persistence and remain governed by the policy above.

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

This authorization applies to invocation approvals. Upstream MCP questions and
URL/login flows still need interaction and are cancelled in headless runs.

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
