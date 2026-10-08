import { createHash } from "node:crypto";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type McpGatewaySource = {
  connectionId: string;
  serverName: string;
  toolName: string;
  schemaRevision: string;
};

export type McpGatewayTool = McpGatewaySource & {
  definition: Tool;
};

export type McpGatewayInvocation = McpGatewaySource & {
  arguments: Record<string, unknown>;
};

/** Codex's MCP tool approval modes (`AppToolApproval`), same names. */
export type McpGatewayToolApprovalMode = "auto" | "prompt" | "writes" | "approve";

/**
 * Codex's `requires_mcp_tool_approval_for_mode`, so a tool asks for approval
 * through the gateway exactly when it would through Codex. The annotations are
 * the server's own hints; an unannotated tool counts as destructive and open
 * world, so it still asks.
 */
export function gatewayToolRequiresApproval(
  annotations: Tool["annotations"],
  mode: McpGatewayToolApprovalMode = "auto",
): boolean {
  switch (mode) {
    case "prompt":
      return true;
    case "approve":
      return false;
    case "writes":
      return annotations?.readOnlyHint !== true;
    case "auto":
      if (annotations?.destructiveHint === true) return true;
      if (annotations?.readOnlyHint === true) return false;
      return (annotations?.destructiveHint ?? true) || (annotations?.openWorldHint ?? true);
  }
}

export function gatewayToolRevision(identity: string, generation: number, tool: Tool): string {
  return createHash("sha256").update(JSON.stringify([identity, generation, tool])).digest("hex");
}

export function validateGatewayArguments(tool: Tool, args: Record<string, unknown>): void {
  try {
    // Never share an AJV $id cache across servers or schema revisions.
    // Compilation is local only; unresolved remote references fail closed.
    const draft = tool.inputSchema.$schema;
    const Validator = typeof draft === "string" && draft.includes("draft-07") ? Ajv
      : typeof draft === "string" && draft.includes("2019-09") ? Ajv2019 : Ajv2020;
    // JSON Schema formats are annotations. Never coerce, default or remove input.
    const validator = new Validator({ strict: false, validateFormats: false, allErrors: false });
    const validate = validator.compile(tool.inputSchema);
    if ("$async" in validate && validate.$async) throw new Error("Asynchronous schemas are not supported.");
    if (!validate(args)) throw new Error(validator.errorsText(validate.errors));
  } catch (error) {
    throw new McpError(ErrorCode.InvalidParams,
      `Arguments could not be validated against ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
