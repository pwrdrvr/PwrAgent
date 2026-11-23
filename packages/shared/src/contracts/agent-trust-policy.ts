import type { MessagingChannelKind, MessagingConversationKind } from "./messaging";

export const AGENT_TRUST_PROVIDERS = ["discord", "feishu", "line", "mattermost", "slack", "telegram"] as const satisfies readonly MessagingChannelKind[];
export type AgentTrustProvider = (typeof AGENT_TRUST_PROVIDERS)[number];

export type AgentTrustConversation = {
  kind: MessagingConversationKind;
  id: string;
  parentId?: string;
  workspaceId?: string;
};

export type AgentTrustActorRequirement =
  | { kind: "actor-id"; actorId: string }
  | { kind: "rbac-role"; roleId: string }
  | { kind: "provider-property"; key: "slack.workspace-admin"; value: true };

export type AgentTrustRule = {
  provider: AgentTrustProvider;
  /** A profile-local connection. Absence matches only the legacy namespace. */
  connectionId?: string;
  conversation?: AgentTrustConversation;
  allOf: readonly AgentTrustActorRequirement[];
};

/** Omit the policy to inherit provider admission and messaging RBAC. */
export type AgentTrustPolicy = {
  version: 1;
  denialResponse: "silent" | "generic";
  /** Any complete rule may grant admission. An empty array grants nothing. */
  rules: readonly AgentTrustRule[];
};

export const MAX_AGENT_TRUST_RULES = 32;
export const MAX_AGENT_TRUST_ACTOR_REQUIREMENTS = 8;
const MAX_REFERENCE_LENGTH = 512;

function hasOnlyFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
}

function isReference(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REFERENCE_LENGTH || value !== value.trim()) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isConversation(value: unknown): value is AgentTrustConversation {
  return hasOnlyFields(value, ["kind", "id", "parentId", "workspaceId"])
    && (value.kind === "dm" || value.kind === "channel" || value.kind === "thread" || value.kind === "topic")
    && isReference(value.id)
    && (value.parentId === undefined || isReference(value.parentId))
    && (value.workspaceId === undefined || isReference(value.workspaceId));
}

function isRequirement(value: unknown, provider: AgentTrustProvider): value is AgentTrustActorRequirement {
  if (!hasOnlyFields(value, ["kind", "actorId", "roleId", "key", "value"])) return false;
  switch (value.kind) {
    case "actor-id":
      return hasOnlyFields(value, ["kind", "actorId"]) && isReference(value.actorId);
    case "rbac-role":
      // RBAC persists role IDs as opaque nonempty strings.
      return hasOnlyFields(value, ["kind", "roleId"]) && typeof value.roleId === "string" && value.roleId.length > 0;
    case "provider-property":
      return provider === "slack" && hasOnlyFields(value, ["kind", "key", "value"])
        && value.key === "slack.workspace-admin" && value.value === true;
    default:
      return false;
  }
}

function isRule(value: unknown): value is AgentTrustRule {
  if (!hasOnlyFields(value, ["provider", "connectionId", "conversation", "allOf"])) return false;
  const provider = AGENT_TRUST_PROVIDERS.find((candidate) => candidate === value.provider);
  return provider !== undefined
    && (value.connectionId === undefined || isReference(value.connectionId))
    && (value.conversation === undefined || isConversation(value.conversation))
    && Array.isArray(value.allOf) && value.allOf.length > 0 && value.allOf.length <= MAX_AGENT_TRUST_ACTOR_REQUIREMENTS
    && Array.from(value.allOf).every((requirement) => isRequirement(requirement, provider));
}

/** Validate without repairing, coercing, or dropping potentially restrictive clauses. */
export function isAgentTrustPolicy(value: unknown): value is AgentTrustPolicy {
  return hasOnlyFields(value, ["version", "denialResponse", "rules"])
    && value.version === 1 && (value.denialResponse === "silent" || value.denialResponse === "generic")
    && Array.isArray(value.rules) && value.rules.length <= MAX_AGENT_TRUST_RULES
    && Array.from(value.rules).every(isRule);
}

export const AGENT_TRUST_PROPERTY_MAX_AGE_MS = 5_000;

export type AgentTrustEvidence = {
  provider: MessagingChannelKind;
  connectionId?: string;
  conversation: AgentTrustConversation;
  actorId: string;
  /** Only explicit roles resolved for this actor on this admission path. */
  roleIds?: readonly string[];
  /** Supplied by the authenticated provider adapter for this decision only. */
  workspaceAdmin?: { actorId: string; workspaceId: string; observedAt: number };
};

export type AgentTrustRejection = "invalid-policy" | "platform" | "connection" | "conversation" | "actor" | "actor-property" | "no-rules";

export type AgentTrustDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentTrustRejection; respond: boolean };

export function evaluateAgentTrustPolicy(policy: unknown, evidence: AgentTrustEvidence, now: number): AgentTrustDecision {
  if (policy === undefined) return { allowed: true };
  if (!isAgentTrustPolicy(policy)) return { allowed: false, reason: "invalid-policy", respond: false };

  const reject = (reason: AgentTrustRejection): AgentTrustDecision => ({
    allowed: false, reason, respond: policy.denialResponse === "generic",
  });
  if (policy.rules.length === 0) return reject("no-rules");
  const onProvider = policy.rules.filter((rule) => rule.provider === evidence.provider);
  if (onProvider.length === 0) return reject("platform");
  const onConnection = onProvider.filter((rule) => rule.connectionId === evidence.connectionId);
  if (onConnection.length === 0) return reject("connection");
  const inConversation = onConnection.filter((rule) => !rule.conversation || (
    rule.conversation.id === evidence.conversation.id
    && rule.conversation.kind === evidence.conversation.kind
    && rule.conversation.parentId === evidence.conversation.parentId
    && rule.conversation.workspaceId === evidence.conversation.workspaceId
  ));
  if (inConversation.length === 0) return reject("conversation");
  const forActor = inConversation.filter((rule) => rule.allOf.every((requirement) => {
    switch (requirement.kind) {
      case "actor-id": return requirement.actorId === evidence.actorId;
      case "rbac-role": return evidence.roleIds?.includes(requirement.roleId) === true;
      case "provider-property": return true;
    }
  }));
  if (forActor.length === 0) return reject("actor");
  const admin = evidence.workspaceAdmin;
  const freshAdmin = admin !== undefined && admin.actorId === evidence.actorId
    && isReference(evidence.conversation.workspaceId) && admin.workspaceId === evidence.conversation.workspaceId
    && Number.isFinite(now) && Number.isFinite(admin.observedAt)
    && now >= admin.observedAt && now - admin.observedAt <= AGENT_TRUST_PROPERTY_MAX_AGE_MS;
  return forActor.some((rule) => freshAdmin || rule.allOf.every((requirement) => requirement.kind !== "provider-property"))
    ? { allowed: true }
    : reject("actor-property");
}
