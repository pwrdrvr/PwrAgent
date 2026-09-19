import type {
  CodexMcpServerSummary,
  McpConnectionSetupSummary,
} from "@pwragent/shared";

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
export type McpServerHealth =
  | "ready"
  | "starting"
  | "needsSignIn"
  | "failed"
  | "unknown";

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
  // Mid-start is its own state. Folding it into `unknown` made the pane say
  // "not started yet" about a server that is starting right now.
  if (server.startupStatus === "starting") return "starting";
  // No startup report at all. Published tools are the only proof left that the
  // server answered; without them the pane does not know.
  return server.tools.length > 0 ? "ready" : "unknown";
}

export type McpServerHealthCounts = {
  total: number;
  tools: number;
  ready: number;
  starting: number;
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
    starting: 0,
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
  if (server.tools.length > 0) return formatMcpToolCount(server.tools.length);
  if (health === "starting") return "starting…";
  if (health === "needsSignIn") return NO_TOOLS_SIGN_IN_REQUIRED;
  if (health === "failed") return "no tools — failed to start";
  if (health === "ready") return READY_NO_TOOLS;
  return "no tools reported — not started yet";
}

function formatMcpToolCount(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

const NO_TOOLS_SIGN_IN_REQUIRED = "no tools — sign-in required";
const READY_NO_TOOLS = "ready — no tools published";

/**
 * Where a managed connection's tool list stands in Settings.
 *
 * Unlike a Codex server's, it is not part of the row's payload: the gateway
 * opens a session of its own to read it, so it can still be on its way, or
 * have failed on its own while the connection itself looks healthy.
 */
export type ManagedMcpToolInventory =
  | { status: "loading" }
  | { status: "loaded"; tools: string[]; fetchedAt: number }
  | { status: "failed"; error: string }
  /** This build cannot ask. Saying "reading tools" would never end. */
  | { status: "unavailable" };

/**
 * A managed connection's health, in the Codex list's vocabulary.
 *
 * The two lists sit one above the other, so the dot and the tool line mean
 * the same thing in both: green is a server that answered, amber is one that
 * needs a sign-in, red is one that did not answer. The setup state outranks
 * the tool list, because it explains why there is no list -- a probe that
 * failed while PwrSnap was still starting is not a broken server once the
 * row knows PwrSnap is not running.
 */
export function readManagedMcpConnectionHealth(
  setup: McpConnectionSetupSummary,
  inventory: ManagedMcpToolInventory | undefined,
): McpServerHealth {
  if (setup.state === "not_authorized" || setup.state === "login_required") {
    return "needsSignIn";
  }
  if (setup.state === "unavailable") return "failed";
  if (setup.state === "connecting") return "starting";
  if (setup.state !== "ready" && setup.state !== "parked") return "unknown";
  if (inventory?.status === "failed") return "failed";
  if (inventory?.status === "loaded") return "ready";
  return "unknown";
}

/**
 * The tool line for a managed connection, worded as `describeMcpServerTools`
 * words the same situation for a Codex server.
 */
export function describeManagedMcpConnectionTools(
  setup: McpConnectionSetupSummary,
  inventory: ManagedMcpToolInventory | undefined,
): string {
  switch (setup.state) {
    case "gateway_off":
      return "no tools — gateway off";
    case "app_not_installed":
      return "no tools — not installed";
    case "app_not_running":
      return "no tools — not running";
    case "not_authorized":
    case "login_required":
      return NO_TOOLS_SIGN_IN_REQUIRED;
    case "unavailable":
      return "no tools — unreachable";
    case "connecting":
      return "connecting…";
    default:
      break;
  }
  if (!inventory || inventory.status === "loading") return "reading tools…";
  if (inventory.status === "unavailable") return "no tools reported";
  if (inventory.status === "failed") return "no tools — could not list them";
  return inventory.tools.length > 0
    ? formatMcpToolCount(inventory.tools.length)
    : READY_NO_TOOLS;
}
