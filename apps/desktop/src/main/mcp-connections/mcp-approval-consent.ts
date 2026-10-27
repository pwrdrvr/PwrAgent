import type { AppServerMcpElicitationResponse, AppServerPendingRequestNotification } from "@pwragent/shared";
import { automationMcpToolAllowed } from "../automations/automation-mcp-policy";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isMcpToolApproval(request: AppServerPendingRequestNotification): boolean {
  return request.method === "mcpServer/elicitation/request"
    && record(request.params._meta)?.codex_approval_kind === "mcp_tool_call";
}

/** Validate Codex's empty tool-approval envelope, never an input or URL form. */
export function buildMcpToolApprovalConsent(
  request: AppServerPendingRequestNotification,
): AppServerMcpElicitationResponse | undefined {
  if (!isMcpToolApproval(request) || request.params.mode !== "form") return undefined;
  const schema = record(request.params.requestedSchema);
  const properties = schema?.properties === undefined ? {} : record(schema.properties);
  if (schema?.type !== "object" || !properties || Object.keys(properties).length > 0
    || schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 0)) {
    return undefined;
  }
  const persist = record(request.params._meta)?.persist;
  const scopes = persist === undefined ? [] : Array.isArray(persist) ? persist : [persist];
  if (scopes.some((scope) => scope !== "session" && scope !== "always")) return undefined;
  return { action: "accept", content: {}, _meta: null };
}

/** The caller verifies the run and current server selection before using its grant. */
export function buildAutomationMcpConsent(params: {
  request: AppServerPendingRequestNotification;
  serverNames: string[];
  toolAllowlist?: string[];
}): AppServerMcpElicitationResponse | undefined {
  const { request } = params;
  const consent = buildMcpToolApprovalConsent(request);
  if (!consent) return undefined;
  const meta = record(request.params._meta)!;
  const toolName = typeof meta.tool_name === "string" ? meta.tool_name.trim() : "";
  if (params.toolAllowlist?.length && (!toolName
    || !automationMcpToolAllowed(params.toolAllowlist, params.serverNames, toolName))) {
    return undefined;
  }
  const scopes = meta.persist === undefined ? [] : Array.isArray(meta.persist) ? meta.persist : [meta.persist];
  // Creation-time authorization belongs to this run. Never mint a permanent
  // app/site grant on behalf of an unattended automation.
  return { ...consent, _meta: scopes.includes("session") ? { persist: "session" } : null };
}
