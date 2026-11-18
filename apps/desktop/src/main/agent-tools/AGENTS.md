# Agent Tool Contract Guidance

Dynamic tools are backwards-compatible API surfaces for existing Agent turns.
Never add a required input, remove or repurpose a response field, or reorder
ordinal parameters; keep `advertise: false` facades for renamed tools, and keep
envelope metadata out of required input. New tools go in the unified
`pwragent` namespace; deprecated namespaces, including
`pwragent_task_monitors`, stay frozen. `search_mcp_tools` and `call_mcp_tool`
are fixed contracts that resolve selection from the trusted calling thread.

Before adding or changing an agent tool, a namespace, or the MCP gateway tools,
read [agent-tool-contracts.md](../../../docs/agent-tool-contracts.md).
