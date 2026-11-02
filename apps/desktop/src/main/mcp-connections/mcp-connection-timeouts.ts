// PwrSnap's blocking image-edit tool can wait inside PwrSnap for up to ten
// minutes, then render the requested composite. Keep every local bridge layer
// above that ceiling so callers do not have to fall back to model-turn polling.
export const MCP_CONNECTION_TOOL_TIMEOUT_MS = 12 * 60_000;
export const MCP_CONNECTION_TOOL_TIMEOUT_SECONDS =
  MCP_CONNECTION_TOOL_TIMEOUT_MS / 1_000;
// A call whose server reports progress gets the timeout above again after
// each report, up to this much in total. A call that stops reporting still
// fails after the timeout above.
export const MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS = 60 * 60_000;

/**
 * A deadline that progress pushes back. It fires `idleMs` after it was made
 * or last extended, and never later than `maxTotalMs` after it was made.
 */
export function progressExtendedTimeout(
  idleMs: number,
  maxTotalMs: number = idleMs,
): { signal: AbortSignal; extend: () => void; clear: () => void } {
  const controller = new AbortController();
  const totalDeadlineAt = Date.now() + Math.max(idleMs, maxTotalMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException("The MCP request timed out.", "TimeoutError")),
      Math.max(1, Math.min(idleMs, totalDeadlineAt - Date.now())),
    );
  };
  arm();
  return {
    signal: controller.signal,
    extend: () => {
      if (!controller.signal.aborted) arm();
    },
    clear: () => clearTimeout(timer),
  };
}

/**
 * How long the Add-a-connection probe waits for an endpoint to answer.
 *
 * This one runs while an operator watches a button, so it is bounded by
 * patience rather than by what a tool call might legitimately need.
 */
export const MCP_CONNECTION_PROBE_TIMEOUT_MS = 8_000;

// One end-to-end discovery budget: registration, initialize, and every page.
export const MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS = 60_000;
export const MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS = MCP_GATEWAY_TOOL_SEARCH_TIMEOUT_MS;
// The owner enforces the deadline. Leave time to return its phase diagnostic
// before the local RPC/search safety timer replaces it with a generic timeout.
export const MCP_DISCOVERY_RESPONSE_GRACE_MS = 1_000;
// Remote capabilities are needed before the stdio server can initialize.
// Allow discovery plus local process/RPC overhead; tool execution is separate.
export const MCP_CONNECTION_STARTUP_TIMEOUT_SECONDS = 75;
