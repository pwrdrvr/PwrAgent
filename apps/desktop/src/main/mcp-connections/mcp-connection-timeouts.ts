// PwrSnap's blocking image-edit tool can wait inside PwrSnap for up to ten
// minutes, then render the requested composite. Keep every local bridge layer
// above that ceiling so callers do not have to fall back to model-turn polling.
export const MCP_CONNECTION_TOOL_TIMEOUT_MS = 12 * 60_000;
export const MCP_CONNECTION_TOOL_TIMEOUT_SECONDS =
  MCP_CONNECTION_TOOL_TIMEOUT_MS / 1_000;

/**
 * How long the Add-a-connection probe waits for an endpoint to answer.
 *
 * This one runs while an operator watches a button, so it is bounded by
 * patience rather than by what a tool call might legitimately need.
 */
export const MCP_CONNECTION_PROBE_TIMEOUT_MS = 8_000;

/**
 * How long Settings waits for a managed connection to list its tools.
 *
 * Longer than the probe, because this one has to finish an initialize and
 * possibly page through a large inventory, but still bounded by someone
 * looking at a row that says "reading tools".
 */
export const MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS = 20_000;
