import type { CodexMcpServerSummary } from "@pwragent/shared";

/**
 * What the pane can honestly say about one MCP server.
 *
 * Sign-in state and startup state are separate axes and the pane must not let
 * one impersonate the other: `authStatus` reports a *stored credential*, not a
 * live probe, so an expired refresh token still reads as `oAuth` until a start
 * attempt fails. `startupStatus` is the proof.
 *
 * `unknown` exists because `startupStatus` is populated from
 * `mcpServer/startupStatus/updated` notifications, and a pane opened after
 * startup has simply never seen one. Reporting that as "ready" would make a
 * dead server and a healthy one identical — which is the defect this replaces.
 */
export type McpServerHealth = "ready" | "needsSignIn" | "failed" | "unknown";

export function readMcpServerHealth(
  server: CodexMcpServerSummary,
): McpServerHealth {
  // Sign-in outranks a failed start: when a server needs credentials the
  // failure is explained, and signing in is the action either way.
  if (server.authStatus === "notLoggedIn") return "needsSignIn";
  if (server.startupStatus === "failed" || server.startupStatus === "cancelled") {
    return "failed";
  }
  if (server.startupStatus === "ready") return "ready";
  if (server.startupStatus === "starting") return "unknown";
  // No startup report at all. Published tools are the only proof left that the
  // server answered; without them the pane does not know.
  return server.tools.length > 0 ? "ready" : "unknown";
}

export type McpServerHealthCounts = {
  total: number;
  tools: number;
  ready: number;
  needsSignIn: number;
  failed: number;
  unknown: number;
};

export function countMcpServerHealth(
  servers: readonly CodexMcpServerSummary[],
): McpServerHealthCounts {
  const counts: McpServerHealthCounts = {
    total: servers.length,
    tools: 0,
    ready: 0,
    needsSignIn: 0,
    failed: 0,
    unknown: 0,
  };
  for (const server of servers) {
    counts.tools += server.tools.length;
    counts[readMcpServerHealth(server)] += 1;
  }
  return counts;
}

/**
 * The line that replaces a bare "0 tools" — the count alone made a server that
 * failed to start and one that simply publishes nothing look the same.
 */
export function describeMcpServerTools(
  server: CodexMcpServerSummary,
  health: McpServerHealth,
): string {
  if (server.tools.length > 0) {
    return `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
  }
  if (health === "needsSignIn") return "no tools — sign-in required";
  if (health === "failed") return "no tools — failed to start";
  if (health === "ready") return "ready — no tools published";
  return "no tools reported — not started yet";
}
