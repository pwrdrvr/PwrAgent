# Agent Tool Contract Guidance

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

## Frozen Legacy Dynamic Namespaces

Codex persists dynamic tool definitions when a thread is created. PwrAgent does
not resend or refresh those definitions when starting later turns on an existing
thread.

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
