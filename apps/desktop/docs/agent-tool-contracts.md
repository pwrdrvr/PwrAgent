# Agent Tool Contract Guidance

Moved from [apps/desktop/src/main/agent-tools/AGENTS.md](../src/main/agent-tools/AGENTS.md),
which keeps a summary and says when to read this document. Relative links
were updated for this location.

PwrAgent dynamic tools are service contracts for existing Agent turns. Treat
the advertised namespace, name, input schema, argument semantics, and response
shape as backwards-compatible API surfaces.

- Do not add a new required input field to an existing dynamic tool. Existing
  threads may call the tool using the schema they were given before the update.
- Do not remove a response field that an existing Agent turn may read. Additive
  response fields are preferred when exposing new state.
- Do not change the meaning of an existing field. Introduce a new field or a
  new tool when semantics need to diverge.
- Do not reorder ordinal parameters if a tool accepts array or tuple-like input.
- Keep compatibility facades for renamed tools or namespaces. Mark them
  `advertise: false` when they should remain callable for old turns but should
  not be shown to new turns.
- Envelope metadata such as `threadId`, `turnId`, and `callId` may be forwarded
  through `AgentToolCallContext`, but must not become required tool input.

The desktop MCP server requires a negotiated `Mcp-Session-Id` for mutations
that use the call ID for admission or receipts: `handoff_task`,
`move_thread_workspace`, `research_assign`, `research_start`, `research_update`,
and `start_review`. Within the same turn, retransmit with the original session
and JSON-RPC ID to preserve the call identity. Codex dynamic tools supply their
own call IDs.

## Frozen Legacy Dynamic Namespaces

Codex persists dynamic tool definitions when a thread is created. PwrAgent
replaces the parent catalog before later turns only when the runtime advertises
the negotiated `dynamicToolsResumeField` capability. Older clients retain their
persisted definitions. Returning a new schema from search does not register an
unknown native tool on those clients.

- New threads receive only the unified `pwragent` dynamic namespace. Add new
  tools there through the agent-tool catalog so both dynamic-tool and MCP
  dispatch expose the same contract.
- Deprecated namespaces are compatibility-only for threads that already have
  their definitions persisted. They are never advertised to new threads and
  cannot discover additive tool changes.
- Keep the deprecated `pwragent_task_monitors` namespace frozen at its historical
  operations: `create_monitor_delegation`, `inject_progress`, and
  `complete_monitoring`. Do not add new operations or schemas to it; retain only
  the dispatch needed for those existing threads.

## Live MCP Gateway Tools

- `search_mcp_tools` and `call_mcp_tool` are fixed contracts. External tool names
  are arguments to the invocation tool, never dynamically invented host names.
- Resolve selection from the trusted calling thread on every operation. Never
  accept a thread, profile, endpoint URL, or credential from tool arguments.
- Keep source-specific approval, current-schema validation and cancellation in
  the shared gateway service. Do not cache approval for the generic wrapper.
- Preserve exact search schemas with authenticated Token Miser delivery. Do not
  exempt arbitrary upstream output by tool name or marker text alone.
- Attribute the existing invocation to its original connection and tool. Do not
  emit a duplicate tool event or add per-call persistence for discovery.

## Turn input source

`get_current_turn_input_source` takes no arguments and returns one `source`
value for the calling turn. The owner assigns `desktop` or `federation` at
composer admission and recognizes `messaging` from the inbound route.
`automation` and `agent` describe continuations and other non-operator work.
Combined inputs with different known sources return `mixed`. Missing evidence
returns `unknown`, including a combined input with an unattributed member.
Federated agent and automation claims require a sender thread attributed to the
authenticated peer. Federated messaging claims use the authorized messaging route.
Steering an active turn leaves its starting source intact.

The tool describes the sending surface and conveys no physical presence or
permission. It returns no peer, actor, or conversation identifiers. The owner
tracks the source in memory for a running turn. Queued prompts keep admission
source in their queue entry and any existing restart checkpoint.
Codex threads with a fixed older catalog receive the tool when the runtime can
refresh their catalog or when a new thread receives the current catalog.
