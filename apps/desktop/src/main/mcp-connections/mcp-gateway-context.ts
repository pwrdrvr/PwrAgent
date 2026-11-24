import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SKILLS_METHODS, offersMcpSkills } from "./mcp-skills-relay";

const RESOURCE_METHODS = ["resources/list", "resources/templates/list", "resources/read"] as const;
const PROMPT_METHODS = ["prompts/list", "prompts/get"] as const;
export const MCP_CONTEXT_METHODS = [...RESOURCE_METHODS, ...MCP_SKILLS_METHODS, ...PROMPT_METHODS] as const;
export type McpContextMethod = typeof MCP_CONTEXT_METHODS[number];
export const READ_MCP_CONTEXT = "read_mcp_context";
export const MAX_MCP_CONTEXT_RESULT_BYTES = 256 * 1024;

export function mcpContextMethods(capabilities: ServerCapabilities | undefined): McpContextMethod[] {
  return [
    ...(capabilities?.resources ? RESOURCE_METHODS : []),
    ...(offersMcpSkills(capabilities) ? MCP_SKILLS_METHODS : []),
    ...(capabilities?.prompts ? PROMPT_METHODS : []),
  ];
}

export type McpContextRequest = {
  method: McpContextMethod;
  params: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate at both the agent-tool and owner-broker boundaries. */
export function parseMcpContextRequest(value: unknown): McpContextRequest {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "method" && key !== "params")
    || typeof value.method !== "string" || !MCP_CONTEXT_METHODS.some((method) => method === value.method)
    || !isRecord(value.params) || Buffer.byteLength(JSON.stringify(value.params)) > 16_000) {
    throw new Error("Provide a supported MCP context method and a params object of at most 16 KB.");
  }
  const method = value.method as McpContextMethod;
  const params = value.params;
  const validString = (key: string) => typeof params[key] === "string" && params[key].length > 0;
  const hasOnly = (...keys: string[]) => Object.keys(params).every((key) => keys.includes(key));
  const validCursor = () => !Object.hasOwn(params, "cursor") || typeof params.cursor === "string";
  switch (method) {
    case "resources/list":
    case "resources/templates/list":
    case "skills/list":
    case "prompts/list":
      if (hasOnly("cursor") && validCursor()) return { method, params };
      break;
    case "resources/read":
    case "skills/get":
      if (hasOnly("uri") && validString("uri")) return { method, params };
      break;
    case "resources/directory/read":
      if (hasOnly("uri", "cursor") && validString("uri") && validCursor()) return { method, params };
      break;
    case "prompts/get":
      if (hasOnly("name", "arguments") && validString("name")
        && (!Object.hasOwn(params, "arguments") || (isRecord(params.arguments)
          && Object.values(params.arguments).every((argument) => typeof argument === "string")))) {
        return { method, params };
      }
      break;
  }
  throw new Error(`Invalid params for ${method}.`);
}
