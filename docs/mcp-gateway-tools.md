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

Default access requests once-only confirmation showing the original connection,
tool and complete arguments. Auto gateway calls use the profile's MCP reviewer
when enabled. Codex's native Auto reviewer handles its native tool decisions;
App Server has no API for submitting host-owned dynamic calls to that reviewer.
ACP harnesses without a native Auto mode can use the enabled profile reviewer
for host-owned MCP requests. With the reviewer disabled, ordinary Auto gateway
calls retain human confirmation.

### Automation MCP grants and review

Saved server and tool allowlists are hard limits. The headless runner forwards
them and `executionProfile.mcpApproval` to the registry. Each ephemeral Codex
thread gets per-run native MCP configuration and fresh managed connection
bridges. Explicitly selected servers are required at startup. Unknown or
ambiguous saved identities fail explicitly. An empty list inherits the Agent's
servers and preserves their enabled/optional settings.

`mcpApproval.tools` chooses `inherit`, `backend`, `auto`, `allow`, or `deny`.
`backend` uses the harness's native MCP approval mode. With the profile reviewer
enabled, an Auto run inherits native approval, a Full Access run inherits
pre-approval, and a Default run inherits PwrAgent review. Host-owned gateway
calls cannot be submitted to Codex's native reviewer and use the configured
PwrAgent reviewer instead. `auto` requires a reviewer decision for each call;
`allow` pre-approves allowed tools; `deny` disables native MCP tools and rejects
gateway invocations, even in Full Access. Disabling the profile reviewer retains
existing automation pre-approval unless a run explicitly chooses another policy.
Startup requires an inherited-server inventory when applying server/tool
restrictions or `backend`, `auto`, or `deny` approval policies. If the runtime
cannot report that inventory, startup fails before creating the execution thread
and releases any prepared bridges.

`mcpApproval.questions` chooses `inherit`, `auto`, or `reject`. Review is limited
to the allowed servers, and accepted content must validate against the original
MCP form schema. The registry rechecks the Agent's current managed selection
before and after review. URL/login flows are cancelled rather than followed.
Unknown answers, invalid schemas, provider failures, and review deadlines cannot
produce approval. Full Access does not answer a question automatically.

`mcpApproval.escalations` chooses `inherit`, `auto`, or `reject` for Default
Access command/file-change escalation requests. Opting into review uses
`on-request` approval policy with the same workspace-write sandbox. These
requests use a separate escalation prompt; MCP requests use the MCP prompt.
Codex Auto retains its native `on-request`/Auto reviewer path. Full Access
retains its native permission policy.

The applied grants are installed before `turn/start`. Current selection, actor
permissions, connection authorization, schema revision and arguments still apply
to gateway calls. Grants and pending reviews are cancelled on interruption,
completion, failed startup and shutdown. User steering invalidates in-flight
reviews and updates the shared task context used by subsequent invocation,
question, and escalation reviews. That context is initialized before
`turn/start` and cleared when the run finishes or fails. Accepted escalation
decisions are translated through the protocol response builder. No wrapper
approval is cached and no new SQLite writes are introduced by host review dispatch.

### Reviewer adapters and settings

`models.mcpAutoApproval` is an additive profile setting, written under
`[models.mcp_auto_approval]`. It stores enabled state, model type, provider,
model, reasoning effort, MCP prompt, escalation prompt and opt-in, endpoint,
API key environment-variable name, deadline, and future classifier confidence
threshold. API keys are read only in the main process and never stored here.

Harness review uses existing isolated Codex and Grok structured helpers with
execution and MCP tools removed. Direct adapters support Chat Completions,
Responses, and Claude Messages APIs. They make one bounded request, follow no
redirects, reject incomplete responses, and validate the resulting decision.
A helper that ignores cancellation may finish within its original deadline;
its late result cannot authorize a stopped request.

`system-one` settings and shared `noul`/`choice` response types are present for
future decision adapters. That adapter is intentionally not implemented here;
choosing it yields an explicit unavailable/reject decision. System One's
[typed primitives](https://docs.typesafe.ai/introduction) require a distinct
adapter rather than parsing generated text.

Automation MCP configuration currently requires the Codex backend. Reviewer
provider selection is independent of the execution backend. This is a
contributor contract; operator configuration documentation belongs in the docs
repository.

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
