import type { McpConnectionStatus } from "./contracts/mcp-connections";

/**
 * The PwrAgent-managed connection list in the order every surface draws it:
 * Settings → Plugins and a thread's MCP access panel.
 *
 * PwrSnap and PwrGit, PwrAgent's own apps, come first. GitHub's connections
 * follow as one group, because GitHub is a known server set up from its own
 * row, not a server type in the add form. Everything else keeps the order
 * the registry listed it in. Each group keeps its input order.
 */
export type ManagedMcpConnectionGroups = {
  pwrSuite: McpConnectionStatus[];
  github: McpConnectionStatus[];
  rest: McpConnectionStatus[];
};

export function groupManagedMcpConnections(
  connections: readonly McpConnectionStatus[],
): ManagedMcpConnectionGroups {
  const groups: ManagedMcpConnectionGroups = { pwrSuite: [], github: [], rest: [] };
  for (const connection of connections) {
    if (connection.kind === "pwrsnap" || connection.kind === "pwrgit") {
      groups.pwrSuite.push(connection);
    } else if (connection.kind === "github") {
      groups.github.push(connection);
    } else {
      groups.rest.push(connection);
    }
  }
  return groups;
}

/** The connections in that order, as one list. */
export function orderManagedMcpConnections<T extends McpConnectionStatus>(
  connections: readonly T[],
): T[] {
  const groups = groupManagedMcpConnections(connections);
  return [...groups.pwrSuite, ...groups.github, ...groups.rest] as T[];
}

/**
 * A built-in that Settings lists under Suggested, with its next step, until
 * it works: PwrSnap or PwrGit before their app's relay is found, Sandboxer
 * and Boat before they are signed in. GitHub is suggested by the window while no GitHub
 * connection exists, since it has no record until one is added. Every other
 * connection is one the operator added, so it is always listed as installed.
 */
export function isSuggestedMcpConnection(connection: McpConnectionStatus): boolean {
  return (
    connection.kind === "pwrsnap"
    || connection.kind === "pwrgit"
    || connection.kind === "sandboxer"
    || connection.kind === "boat"
  ) && !connection.configured;
}
