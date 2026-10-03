import type { ThreadStartParams } from "@pwrdrvr/codex-app-server-protocol/v2";

export type AutomationMcpServer = {
  name: string;
  aliases?: string[];
  connectionId?: string;
  config?: Record<string, unknown>;
  tools?: string[];
};

export function automationMcpToolAllowed(
  toolAllowlist: readonly string[] | undefined,
  serverNames: readonly string[],
  toolName: string,
): boolean {
  return !toolAllowlist?.length || toolAllowlist.some((name) =>
    name === toolName
    || serverNames.some((server) => name === `mcp__${server}__${toolName}`),
  );
}

/** Per-run overrides only: the Agent's/global MCP configuration is untouched. */
export function buildAutomationMcpPolicy(params: {
  servers: AutomationMcpServer[];
  mcpAllowlist?: string[];
  toolAllowlist?: string[];
}): { config: ThreadStartParams["config"]; connectionIds: string[] } {
  const allowed = new Set(params.mcpAllowlist?.map((name) => name.trim()).filter(Boolean));
  const identities = (server: AutomationMcpServer) => [server.name, ...(server.aliases ?? [])];
  const unknown = [...allowed].filter((name) => !params.servers.some((server) => identities(server).includes(name)));
  if (unknown.length) {
    throw new Error(`Automation MCP servers are not configured for the Agent: ${unknown.join(", ")}. Check the Agent's MCP settings.`);
  }
  const ambiguous = [...allowed].filter((name) => params.servers.filter((server) => identities(server).includes(name)).length > 1);
  if (ambiguous.length) {
    throw new Error(`Automation MCP server names match multiple connections: ${ambiguous.join(", ")}. Select the exact server identity.`);
  }
  const connectionIds: string[] = [];
  const entries = params.servers.map((server) => {
    if (allowed.size && !identities(server).some((name) => allowed.has(name))) {
      return [server.name, { ...server.config, enabled: false }];
    }
    if (server.connectionId) connectionIds.push(server.connectionId);
    const tools = (server.tools ?? []).map((name) => {
      const prefix = identities(server).find((identity) => name.startsWith(`mcp__${identity}__`));
      return prefix ? name.slice(`mcp__${prefix}__`.length) : name;
    }).filter((name) => automationMcpToolAllowed(params.toolAllowlist, identities(server), name));
    const enabledTools = params.toolAllowlist?.length
      ? params.toolAllowlist.flatMap((name) => {
          const prefix = identities(server).find((identity) => name.startsWith(`mcp__${identity}__`));
          return prefix ? [name.slice(`mcp__${prefix}__`.length)] : name.startsWith("mcp__") ? [] : [name];
        })
      : undefined;
    return [server.name, {
      ...server.config,
      ...(allowed.size || server.connectionId ? { enabled: true } : {}),
      // Wait for this server rather than silently omitting it from the run.
      ...(allowed.size ? { required: true } : {}),
      default_tools_approval_mode: "approve",
      ...(enabledTools ? { enabled_tools: enabledTools } : {}),
      ...(tools.length ? { tools: Object.fromEntries(tools.map((name) => [name, { approval_mode: "approve" }])) } : {}),
    }];
  });
  return { config: { mcp_servers: Object.fromEntries(entries) } as ThreadStartParams["config"], connectionIds };
}
