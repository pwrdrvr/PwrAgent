import type { McpConnectionStatus } from "@pwragent/shared";

/**
 * The PwrAgent-managed connection list in the order Settings draws it.
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
