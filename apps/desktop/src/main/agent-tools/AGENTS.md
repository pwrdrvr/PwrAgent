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

