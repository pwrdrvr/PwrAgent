export const MCP_REVIEWER_MODEL_TYPES = ["harness", "completions", "responses", "claude", "system-one"] as const;
export type McpReviewerModelType = (typeof MCP_REVIEWER_MODEL_TYPES)[number];
export type AutomationMcpApprovalPolicy = {
  /** Inherit uses the configured reviewer, or the existing pre-approval when disabled. */
  tools?: "inherit" | "backend" | "auto" | "allow" | "deny";
  /** Questions need answers, and are never covered by Full Access. */
  questions?: "inherit" | "auto" | "reject";
  escalations?: "inherit" | "auto" | "reject";
};

export type DesktopMcpAutoApprovalSettings = {
  enabled: boolean;
  modelType: McpReviewerModelType;
  provider: string;
  /** Empty on Codex follows Settings → Helper model. Direct APIs name one. */
  model: string;
  reasoningEffort: string;
  prompt: string;
  escalationPrompt: string;
  reviewEscalations: boolean;
  /** Full API endpoint, for direct APIs and the future decision-model adapter. */
  endpoint: string;
  /** Environment variable name only; never an API key. */
  apiKeyEnv: string;
  confidenceThreshold: number;
  timeoutMs: number;
};

export const DEFAULT_MCP_REVIEWER_PROMPT = "Approve requests necessary to carry out the user's stated task within the allowed MCP servers and tools. "
  + "Reject unrelated, destructive, privilege-expanding, credential-sharing, or externally communicating requests unless the user explicitly authorized them. "
  + "Answer questions only from the supplied task and context. If the answer is unknown, cancel instead of inventing it.";

export const DEFAULT_ESCALATION_REVIEWER_PROMPT = "Review a command or file-change permission escalation against the user task. "
  + "Approve only the exact disclosed operation needed for that task. Check affected paths, deletion, shell effects, network destinations, and credentials. "
  + "Reject destructive or unrelated operations without explicit authorization. Cancel when context is insufficient.";

export const DEFAULT_MCP_AUTO_APPROVAL_SETTINGS: DesktopMcpAutoApprovalSettings = {
  enabled: false, modelType: "harness", provider: "codex", model: "", reasoningEffort: "",
  prompt: DEFAULT_MCP_REVIEWER_PROMPT, escalationPrompt: DEFAULT_ESCALATION_REVIEWER_PROMPT, reviewEscalations: false, endpoint: "", apiKeyEnv: "", confidenceThreshold: 0.9, timeoutMs: 30000,
};

export function normalizeMcpAutoApprovalSettings(value: unknown): DesktopMcpAutoApprovalSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP reviewer settings must be an object.");
  const record = value as Record<string, unknown>;
  const result = { ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS };
  if (typeof record.enabled !== "boolean") throw new Error("MCP reviewer enabled must be a boolean.");
  result.enabled = record.enabled;
  if (record.reviewEscalations !== undefined && typeof record.reviewEscalations !== "boolean") throw new Error("Escalation review enabled must be a boolean.");
  if (typeof record.reviewEscalations === "boolean") result.reviewEscalations = record.reviewEscalations;
  if (!MCP_REVIEWER_MODEL_TYPES.includes(record.modelType as McpReviewerModelType)) throw new Error("Unknown MCP reviewer model type.");
  result.modelType = record.modelType as McpReviewerModelType;
  for (const key of ["provider", "model", "reasoningEffort", "prompt", "escalationPrompt", "endpoint", "apiKeyEnv"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") throw new Error(`MCP reviewer ${key} must be text.`);
    if (typeof record[key] === "string") result[key] = record[key].trim();
  }
  if (result.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.apiKeyEnv)) throw new Error("MCP reviewer API key must name an environment variable.");
  if (result.endpoint && !/^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/.test(result.endpoint)) {
    throw new Error("MCP reviewer endpoint must be an HTTP URL without credentials.");
  }
  for (const [key, min, max] of [["confidenceThreshold", 0.5, 1], ["timeoutMs", 1000, 120000]] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < min || record[key] > max) throw new Error(`Invalid MCP reviewer ${key}.`);
    result[key] = record[key];
  }
  // Only Codex follows the Helper model. Any other provider names its model.
  const needsModel = result.modelType !== "harness" || result.provider !== "codex";
  if (result.enabled && (needsModel && !result.model || !result.prompt || result.reviewEscalations && !result.escalationPrompt || (result.modelType === "harness" ? !result.provider : !result.endpoint))) {
    throw new Error("An enabled approval reviewer needs a model, a policy, and a provider or endpoint.");
  }
  return result;
}

export function normalizeAutomationMcpApprovalPolicy(value: unknown): AutomationMcpApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Automation MCP approval policy must be an object.");
  const record = value as Record<string, unknown>;
  if (record.tools !== undefined && (typeof record.tools !== "string" || !["inherit", "backend", "auto", "allow", "deny"].includes(record.tools))) throw new Error("Unknown automation MCP tool approval policy.");
  if (record.questions !== undefined && (typeof record.questions !== "string" || !["inherit", "auto", "reject"].includes(record.questions))) throw new Error("Unknown automation MCP question policy.");
  if (record.escalations !== undefined && (typeof record.escalations !== "string" || !["inherit", "auto", "reject"].includes(record.escalations))) throw new Error("Unknown automation escalation policy.");
  return { ...(record.escalations ? { escalations: record.escalations as AutomationMcpApprovalPolicy["escalations"] } : {}), ...(record.tools ? { tools: record.tools as AutomationMcpApprovalPolicy["tools"] } : {}), ...(record.questions ? { questions: record.questions as AutomationMcpApprovalPolicy["questions"] } : {}) };
}

export type AutomationMcpToolDecision = "allow" | "backend" | "auto" | "deny";

/**
 * The tool-call policy a run applies. The registry enforces it and the
 * automation editor labels Inherit with it, so the two cannot disagree.
 * `executionMode` is the run's effective access, its own or the Agent's.
 */
export function resolveAutomationMcpToolPolicy(
  policy: AutomationMcpApprovalPolicy | undefined,
  executionMode: string | undefined,
  reviewerEnabled: boolean,
): AutomationMcpToolDecision {
  if (policy?.tools && policy.tools !== "inherit") return policy.tools;
  if (executionMode === "auto" && reviewerEnabled) return "backend";
  if (executionMode === "full-access") return "allow";
  return reviewerEnabled ? "auto" : "allow";
}

/** Questions are reviewed or cancelled; Full Access never answers one. */
export function resolveAutomationMcpQuestionPolicy(
  policy: AutomationMcpApprovalPolicy | undefined,
  reviewerEnabled: boolean,
): "auto" | "reject" {
  if (policy?.questions && policy.questions !== "inherit") return policy.questions;
  return reviewerEnabled ? "auto" : "reject";
}

/**
 * Whether a Default Access run asks for escalations at all. Without a reviewer
 * nothing could answer them, so the run stays in its sandbox rather than
 * raising requests that would only be cancelled.
 */
export function resolveAutomationEscalationPolicy(
  policy: AutomationMcpApprovalPolicy | undefined,
  reviewer: Pick<DesktopMcpAutoApprovalSettings, "enabled" | "reviewEscalations">,
): "auto" | "reject" {
  if (!reviewer.enabled || policy?.escalations === "reject") return "reject";
  return policy?.escalations === "auto" || reviewer.reviewEscalations ? "auto" : "reject";
}

/** Future decision adapters normalize these values into an approval decision. */
export type SystemOneDecision =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type SystemOneDecisionResponse = SystemOneDecision & {
  latency_ms?: number;
  hardware?: unknown;
  device?: unknown;
};
