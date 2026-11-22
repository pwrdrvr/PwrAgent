import type { AppServerBackendKind, ThreadExecutionMode } from "./normalized-app-server";

// Shared compiles without DOM or Node types. Its hosts provide the WHATWG URL global.
declare const URL: new (input: string) => { protocol: string; origin: string };

export type AgentCapabilityApproval = "prompt" | "auto-approve";

export type AgentCapabilityWorkspace = {
  path: string;
  access: "read" | "write";
};

export type AgentCapabilityExecutable = {
  path: string;
  approval: AgentCapabilityApproval;
};

export type AgentCapabilityMcpServer = {
  source: "connection" | "provider";
  id: string;
  tools: { name: string; approval: AgentCapabilityApproval }[];
};

/** Empty grant lists grant nothing. An operation without a matching grant is rejected before approval. */
export type RestrictedAgentCapabilityPolicy = {
  version: 1;
  mode: "restricted";
  /** A null ceiling permits no execution mode. */
  executionModeCeiling: ThreadExecutionMode | null;
  /** Owner-local absolute paths. Portable definitions must bind these on the destination. */
  workspaceRoots: AgentCapabilityWorkspace[];
  executables: AgentCapabilityExecutable[];
  /** Exact server identities and exact tool names, with no implicit grant for the server's other tools. */
  mcpServers: AgentCapabilityMcpServer[];
  /** Exact bound skill identities. Loading a skill grants none of its requested capabilities. */
  skills: string[];
  /** Exact HTTP(S) origins. Each destination, including any redirect, needs its own grant. */
  networkOrigins: string[];
};

export type AgentCapabilityPolicy =
  | { version: 1; mode: "legacy" }
  | RestrictedAgentCapabilityPolicy;

export type AgentCapabilityPolicyValidation =
  | { ok: true; policy: AgentCapabilityPolicy }
  | { ok: false; field: string; code: "invalid" | "unsupported-version" };

export type AgentCapabilityExecutionPath =
  | "interactive"
  | "automation"
  | "child";

export type AgentCapabilityRuntimeSupport =
  | { status: "legacy" }
  | { status: "invalid"; field: string; code: "invalid" | "unsupported-version" }
  | { status: "unsupported"; backend: AppServerBackendKind; path: AgentCapabilityExecutionPath };

const LEGACY_POLICY: AgentCapabilityPolicy = { version: 1, mode: "legacy" };
const MAX_GRANTS = 128;
const CONTROL_OR_WILDCARD = /[\x00-\x1f\x7f*]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectWithFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function exactName(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !CONTROL_OR_WILDCARD.test(value);
}

function absolutePath(value: unknown): value is string {
  return exactName(value, 4096) && (/^\/(?!\/)/.test(value) || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+\\[^\\/]+/.test(value));
}

function isOrigin(value: unknown): value is string {
  if (!exactName(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

function isApproval(value: unknown): value is AgentCapabilityApproval {
  return value === "prompt" || value === "auto-approve";
}

function isUniqueList(
  value: unknown,
  identity: (entry: unknown) => string | undefined,
): boolean {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    const key = identity(entry);
    if (key === undefined || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Validates explicit definitions, including imports. Absence is handled only by the legacy runtime adapter. */
export function validateAgentCapabilityPolicy(value: unknown): AgentCapabilityPolicyValidation {
  const invalid = (field: string) => ({ ok: false, field, code: "invalid" } as const);
  if (!isRecord(value) || !Object.hasOwn(value, "version")) return invalid("version");
  if (value.version !== 1) return { ok: false, field: "version", code: "unsupported-version" };

  if (value.mode === "legacy") {
    return objectWithFields(value, ["version", "mode"])
      ? { ok: true, policy: { ...LEGACY_POLICY } }
      : invalid("legacy");
  }

  if (!objectWithFields(value, [
    "version", "mode", "executionModeCeiling", "workspaceRoots", "executables",
    "mcpServers", "skills", "networkOrigins",
  ]) || value.mode !== "restricted") return invalid("restricted");

  if (value.executionModeCeiling !== null && value.executionModeCeiling !== "default"
    && value.executionModeCeiling !== "auto" && value.executionModeCeiling !== "full-access") {
    return invalid("executionModeCeiling");
  }
  if (!isUniqueList(value.workspaceRoots, (entry) => objectWithFields(entry, ["path", "access"])
    && absolutePath(entry.path) && (entry.access === "read" || entry.access === "write")
    ? entry.path : undefined)) return invalid("workspaceRoots");
  if (!isUniqueList(value.executables, (entry) => objectWithFields(entry, ["path", "approval"])
    && absolutePath(entry.path) && isApproval(entry.approval)
    ? entry.path : undefined)) return invalid("executables");
  if (!isUniqueList(value.mcpServers, (entry) => objectWithFields(entry, ["source", "id", "tools"])
    && (entry.source === "connection" || entry.source === "provider")
    && exactName(entry.id)
    && isUniqueList(entry.tools, (tool) => objectWithFields(tool, ["name", "approval"])
      && exactName(tool.name) && isApproval(tool.approval) ? tool.name : undefined)
    ? `${entry.source}:${entry.id}` : undefined)) return invalid("mcpServers");
  if (!isUniqueList(value.skills, (entry) => exactName(entry) ? entry : undefined)) return invalid("skills");
  if (!isUniqueList(value.networkOrigins, (entry) => isOrigin(entry) ? entry : undefined)) return invalid("networkOrigins");

  return { ok: true, policy: value as RestrictedAgentCapabilityPolicy };
}

/**
 * No current provider has a verified complete ceiling on these paths. A provider
 * must enforce every default denial as well as each requested grant before this
 * function can admit a restricted policy. Approval is downstream of admission.
 */
export function agentCapabilityRuntimeSupport(
  value: unknown,
  backend: AppServerBackendKind,
  path: AgentCapabilityExecutionPath,
): AgentCapabilityRuntimeSupport {
  if (value === undefined) return { status: "legacy" };
  const validation = validateAgentCapabilityPolicy(value);
  if (!validation.ok) return { status: "invalid", field: validation.field, code: validation.code };
  return validation.policy.mode === "legacy"
    ? { status: "legacy" }
    : { status: "unsupported", backend, path };
}
