import { createHash } from "node:crypto";
import type { Tool, Implementation, InitializeResult } from "@modelcontextprotocol/sdk/types.js";
import { lazyModule } from "../lazy-module";
import { mcpTypes } from "./mcp-sdk";
import type { McpConnectionToolApproval } from "@pwragent/shared";
import type { McpSkillSummary } from "./mcp-skills-relay";

export type McpGatewaySource = {
  connectionId: string;
  serverName: string;
  toolName: string;
  schemaRevision: string;
};

export type McpGatewayIdentity = { serverInfo?: Implementation; metadata?: InitializeResult["_meta"] };

export type McpGatewayTool = McpGatewaySource & {
  serverIdentity?: McpGatewayIdentity;
  /** Owner-issued schema/authorization identity, stable across worker scopes. */
  consentRevision?: string;
  definition: Tool;
  /**
   * The server's `initialize` instructions, on the catalog's first entry only
   * so a large catalog does not repeat them. Search lifts them out per server.
   */
  serverInstructions?: string;
  /**
   * The workflow skills the server publishes, cleaned by `listedMcpSkills`,
   * on the catalog's first entry only. Present only when a search asked for
   * them and the server offers skills and resources.
   */
  serverSkills?: { skills: McpSkillSummary[]; complete: boolean };
};

export type McpGatewayInvocation = McpGatewaySource & {
  arguments: Record<string, unknown>;
};

/**
 * Codex's `requires_mcp_tool_approval_for_mode`, so a tool asks for approval
 * through the gateway exactly when it would through Codex. The modes are
 * Codex's own names; its `writes` mode is left out because it differs from
 * `auto` only for a tool marked non-destructive and closed-world. The
 * annotations are the server's own hints; an unannotated tool counts as
 * destructive and open world, so it still asks.
 */
export function gatewayToolRequiresApproval(
  annotations: Tool["annotations"],
  mode: McpConnectionToolApproval = "auto",
): boolean {
  switch (mode) {
    case "prompt":
      return true;
    case "approve":
      return false;
    case "auto":
      if (annotations?.destructiveHint === true) return true;
      if (annotations?.readOnlyHint === true) return false;
      return (annotations?.destructiveHint ?? true) || (annotations?.openWorldHint ?? true);
  }
}

// AJV and its draft builds cost ~25 ms of cold loading. Only a tool call or
// a form answer validates, so load them then.
const ajv = lazyModule(async () => {
  const [draft07, draft2019, draft2020] = await Promise.all([
    import("ajv"), import("ajv/dist/2019.js"), import("ajv/dist/2020.js"),
  ]);
  return { Ajv: draft07.default, Ajv2019: draft2019.default, Ajv2020: draft2020.default };
});

export function gatewayToolRevision(identity: string, generation: number, tool: Tool): string {
  return createHash("sha256").update(JSON.stringify([identity, generation, tool])).digest("hex");
}

/** Bind connection-wide consent to the owner's exact tools and authorization. */
export function gatewayCatalogRevision(tools: McpGatewayTool[]): string {
  const revisions = tools.map((tool) => [tool.toolName, tool.consentRevision ?? tool.schemaRevision] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(revisions)).digest("hex");
}

export async function validateGatewayArguments(tool: Tool, args: Record<string, unknown>): Promise<void> {
  try {
    await validateJsonSchemaValue(tool.inputSchema, args);
  } catch (error) {
    const { ErrorCode, McpError } = await mcpTypes.load();
    throw new McpError(ErrorCode.InvalidParams,
      `Arguments could not be validated against ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate a value against a server-supplied JSON Schema, or throw.
 * Shared by tool arguments and upstream form answers.
 */
export async function validateJsonSchemaValue(schema: Record<string, unknown>, value: unknown): Promise<void> {
  const { Ajv, Ajv2019, Ajv2020 } = await ajv.load();
  // Never share an AJV $id cache across servers or schema revisions.
  // Compilation is local only; unresolved remote references fail closed.
  const draft = schema.$schema;
  const Validator = typeof draft === "string" && draft.includes("draft-07") ? Ajv
    : typeof draft === "string" && draft.includes("2019-09") ? Ajv2019 : Ajv2020;
  // JSON Schema formats are annotations. Never coerce, default or remove input.
  const validator = new Validator({ strict: false, validateFormats: false, allErrors: false });
  const validate = validator.compile(schema);
  if ("$async" in validate && validate.$async) throw new Error("Asynchronous schemas are not supported.");
  if (!validate(value)) throw new Error(validator.errorsText(validate.errors));
}
