// PwrSnap's blocking image-edit tool can wait inside PwrSnap for up to ten
// minutes, then render the requested composite. Keep every local bridge layer
// above that ceiling so callers do not have to fall back to model-turn polling.
export const MCP_CONNECTION_TOOL_TIMEOUT_MS = 12 * 60_000;
export const MCP_CONNECTION_TOOL_TIMEOUT_SECONDS =
  MCP_CONNECTION_TOOL_TIMEOUT_MS / 1_000;
