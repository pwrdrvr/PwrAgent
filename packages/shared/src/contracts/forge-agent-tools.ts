import { parseCodexProviderModelId } from "../codex-model-providers";

/**
 * Operator policy for PwrAgent's own forge tools: the CI reads, the GitHub
 * pull request and issue reads, and the GitHub and GitLab writes. Stored in config.toml
 * `[git.agent_tools]` and enforced by the main process on every call, so a
 * change applies to the next call even in a turn that already holds a schema.
 */
export const FORGE_AGENT_TOOL_GROUPS = [
  "read",
  "pull_requests",
  "comments",
  "issues",
  "ci",
  "approve_merge",
] as const;

export type ForgeAgentToolGroup = (typeof FORGE_AGENT_TOOL_GROUPS)[number];

/**
 * `allow` runs without asking. `auto` runs in a Full Access turn and, except
 * for `approve_merge`, in a Codex Auto turn; otherwise it asks. `ask` always
 * asks. `off` removes the group's tools from threads.
 */
export const FORGE_AGENT_TOOL_ACCESS_LEVELS = ["allow", "auto", "ask", "off"] as const;

export type ForgeAgentToolAccess = (typeof FORGE_AGENT_TOOL_ACCESS_LEVELS)[number];

export type ForgeAgentToolPolicy = {
  enabled: boolean;
  /** The global level per group; project rules start from these. */
  access: Record<ForgeAgentToolGroup, ForgeAgentToolAccess>;
  /**
   * Per-repository, per-agent overrides of the write groups, from
   * `[[git.agent_tools.rules]]`. Absent means none. Resolve a call's level
   * with `resolveForgeAgentToolAccess`, never by reading `access` alone.
   */
  rules?: readonly ForgeAgentToolRule[];
};

export const DEFAULT_FORGE_AGENT_TOOL_POLICY: ForgeAgentToolPolicy = {
  enabled: true,
  access: {
    read: "allow",
    pull_requests: "auto",
    comments: "auto",
    issues: "auto",
    ci: "auto",
    approve_merge: "ask",
  },
  rules: [],
};

export const FORGE_AGENT_TOOL_GROUP_LABELS: Record<ForgeAgentToolGroup, string> = {
  read: "Read",
  pull_requests: "Pull requests",
  comments: "Comments and reviews",
  issues: "Issues",
  ci: "CI reruns",
  approve_merge: "Approve and merge",
};

export function isForgeAgentToolGroup(value: unknown): value is ForgeAgentToolGroup {
  return FORGE_AGENT_TOOL_GROUPS.some((group) => group === value);
}

/** Reads change nothing, so asking before one would only add a prompt. */
export function forgeAgentToolAccessLevels(group: ForgeAgentToolGroup): readonly ForgeAgentToolAccess[] {
  return group === "read" ? ["allow", "off"] : FORGE_AGENT_TOOL_ACCESS_LEVELS;
}

export function isForgeAgentToolAccess(
  group: ForgeAgentToolGroup,
  value: unknown,
): value is ForgeAgentToolAccess {
  return forgeAgentToolAccessLevels(group).some((level) => level === value);
}

/**
 * Every forge tool that changes provider state, with the group whose access
 * level governs it. Messaging RBAC and the main-process policy gate both read
 * this map, so a new write tool cannot ship ungated in either. A review that
 * approves or requests changes moves to `approve_merge` by its arguments.
 */
export const FORGE_AGENT_WRITE_TOOL_GROUPS = {
  create_pull_request: "pull_requests",
  update_pull_request: "pull_requests",
  add_issue_comment: "comments",
  reply_to_review_comment: "comments",
  submit_pull_request_review: "comments",
  resolve_review_thread: "comments",
  create_issue: "issues",
  update_issue: "issues",
  rerun_failed_ci_jobs: "ci",
  merge_pull_request: "approve_merge",
} as const satisfies Record<string, Exclude<ForgeAgentToolGroup, "read">>;

export type ForgeAgentWriteToolName = keyof typeof FORGE_AGENT_WRITE_TOOL_GROUPS;

export function isForgeWriteToolName(tool: string): tool is ForgeAgentWriteToolName {
  return Object.prototype.hasOwnProperty.call(FORGE_AGENT_WRITE_TOOL_GROUPS, tool);
}

// ---------------------------------------------------------------------------
// Project rules
// ---------------------------------------------------------------------------

/**
 * The groups a project rule may set. Reads stay global: they change nothing,
 * so a per-project read level would only add a way to hide tools.
 */
export const FORGE_AGENT_TOOL_RULE_GROUPS = [
  "pull_requests",
  "comments",
  "issues",
  "ci",
  "approve_merge",
] as const satisfies readonly Exclude<ForgeAgentToolGroup, "read">[];

export type ForgeAgentToolRuleGroup = (typeof FORGE_AGENT_TOOL_RULE_GROUPS)[number];

export function isForgeAgentToolRuleGroup(value: unknown): value is ForgeAgentToolRuleGroup {
  return FORGE_AGENT_TOOL_RULE_GROUPS.some((group) => group === value);
}

/** The `agent` of the "All agents" row. */
export const FORGE_AGENT_RULE_ALL_AGENTS = "*";

export type ForgeAgentRuleBackend = "*" | "claude" | "codex" | `acp:${string}`;

/**
 * Which threads a rule covers. `codexModelProvider` is valid only with
 * `codex`; Codex without one means Codex on its default OpenAI provider, never
 * a custom provider. `model` narrows a rule to threads whose current model is
 * exactly that id. The All agents row carries neither.
 */
export type ForgeAgentRuleAgent = {
  backend: ForgeAgentRuleBackend;
  codexModelProvider?: string;
  model?: string;
};

/**
 * One repository's rule for one agent. `repository` is the canonical
 * `host/owner/repo` key from `normalizeForgeRuleRepository`. A group the rule
 * does not set inherits from a less specific rule, then the global level.
 */
export type ForgeAgentToolRule = {
  repository: string;
  agent: ForgeAgentRuleAgent;
  access: Partial<Record<ForgeAgentToolRuleGroup, ForgeAgentToolAccess>>;
};

/**
 * Who is calling, derived by the main process from PwrAgent's own records,
 * never from tool arguments. `codexModelProvider` undefined means Codex's
 * default provider; `model` undefined means the model is unknown, and then
 * no model-specific rule matches.
 */
export type ForgeAgentIdentity = {
  backend: string;
  codexModelProvider?: string;
  model?: string;
};

export type ForgeRuleRepositoryProvider = "github" | "gitlab";

export type ForgeRuleRepositoryRef = {
  provider?: ForgeRuleRepositoryProvider;
  host: string;
  owner: string;
  repo: string;
};

/** 3 = agent and model, 2 = agent, 1 = All agents. */
export type ForgeAgentRuleSpecificity = 1 | 2 | 3;

export type ForgeAgentToolAccessResolution =
  | {
      level: ForgeAgentToolAccess;
      /** `disabled`: the master switch is off. `default`: the global level. */
      source: "disabled" | "default";
    }
  | {
      level: ForgeAgentToolAccess;
      source: "project_rule";
      rule: ForgeAgentToolRule;
      specificity: ForgeAgentRuleSpecificity;
    };

/** The `source` a tool result names when a project rule allowed the call. */
export const FORGE_AGENT_RULE_APPROVAL_SOURCE = "project_rule";

/** The small field a forge write result carries when a rule decided it. */
export type ForgeAgentToolRuleApprovalNote = {
  source: typeof FORGE_AGENT_RULE_APPROVAL_SOURCE;
  rule: string;
};

const FORGE_RULE_HOST_PATTERN = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/;
const FORGE_RULE_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const FORGE_RULE_ACP_REGISTRY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORGE_RULE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const FORGE_RULE_MODEL_MAX_LENGTH = 256;
/** Codex's built-in provider; a rule naming it means the default provider. */
const CODEX_DEFAULT_MODEL_PROVIDER_ID = "openai";

function isForgeRuleSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && FORGE_RULE_SEGMENT_PATTERN.test(value)
    && value !== "."
    && value !== "..";
}

function isGitHubRuleHost(host: string): boolean {
  return host === "github.com" || host.startsWith("github.");
}

/**
 * The canonical `host/owner/repo` key rules are stored under. The host is
 * lowercased. On GitHub owner and repo fold to lowercase, as forge
 * repository keys do; GitLab keeps case and allows nested groups in owner.
 * A string's provider is inferred from its host unless `provider` is given,
 * so pass the call's provider when it is known. A pasted URL, a trailing
 * `.git`, and stray slashes are accepted. Returns undefined when the value
 * names no repository.
 */
export function normalizeForgeRuleRepository(
  value: string | ForgeRuleRepositoryRef,
  provider?: ForgeRuleRepositoryProvider,
): string | undefined {
  let host: string;
  let pathSegments: string[];
  let resolvedProvider = provider;
  if (typeof value === "string") {
    const trimmed = value
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 3) return undefined;
    host = segments[0];
    pathSegments = segments.slice(1);
  } else {
    if (!value || typeof value.host !== "string" || typeof value.owner !== "string" || typeof value.repo !== "string") {
      return undefined;
    }
    host = value.host.trim();
    pathSegments = [...value.owner.trim().split("/"), value.repo.trim()];
    resolvedProvider = provider ?? value.provider;
  }
  host = host.toLowerCase();
  if (host.length > 253 || !FORGE_RULE_HOST_PATTERN.test(host)) return undefined;
  if (!pathSegments.every(isForgeRuleSegment)) return undefined;
  const github = resolvedProvider === "github"
    || (resolvedProvider === undefined && isGitHubRuleHost(host));
  if (github && pathSegments.length !== 2) return undefined;
  const path = pathSegments.join("/");
  return `${host}/${github ? path.toLowerCase() : path}`;
}

/** `owner/repo` (or `group/subgroup/repo`) without the host. */
export function forgeRuleRepositoryLabel(repository: string): string {
  const slash = repository.indexOf("/");
  return slash >= 0 ? repository.slice(slash + 1) : repository;
}

export function isForgeAgentRuleBackend(value: unknown): value is ForgeAgentRuleBackend {
  if (typeof value !== "string") return false;
  if (value === FORGE_AGENT_RULE_ALL_AGENTS || value === "claude" || value === "codex") {
    return true;
  }
  return value.startsWith("acp:")
    && FORGE_RULE_ACP_REGISTRY_ID_PATTERN.test(value.slice("acp:".length));
}

function trimmedOptional(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Codex's default provider normalizes to undefined. */
function normalizeCodexModelProvider(value: string | undefined): string | undefined {
  return value === undefined || value === CODEX_DEFAULT_MODEL_PROVIDER_ID ? undefined : value;
}

export type ForgeAgentRuleAgentValidation =
  | { ok: true; agent: ForgeAgentRuleAgent }
  | { ok: false; reason: string };

/**
 * Check an agent's shape: a known backend, a provider only on Codex, and
 * neither a provider nor a model on the All agents row.
 */
export function validateForgeAgentRuleAgent(value: {
  backend?: unknown;
  codexModelProvider?: unknown;
  model?: unknown;
}): ForgeAgentRuleAgentValidation {
  const backend = typeof value.backend === "string" ? value.backend.trim() : value.backend;
  if (!isForgeAgentRuleBackend(backend)) {
    return { ok: false, reason: `unknown agent ${JSON.stringify(value.backend ?? null)}` };
  }
  const provider = trimmedOptional(value.codexModelProvider);
  const model = trimmedOptional(value.model);
  if (provider === null) return { ok: false, reason: "codex_model_provider must be a string" };
  if (model === null) return { ok: false, reason: "model must be a string" };
  if (backend === FORGE_AGENT_RULE_ALL_AGENTS && (provider !== undefined || model !== undefined)) {
    return { ok: false, reason: "the All agents rule cannot name a provider or model" };
  }
  if (provider !== undefined && backend !== "codex") {
    return { ok: false, reason: "codex_model_provider is only valid with agent \"codex\"" };
  }
  if (provider !== undefined && !FORGE_RULE_PROVIDER_ID_PATTERN.test(provider)) {
    return { ok: false, reason: `invalid codex_model_provider ${JSON.stringify(provider)}` };
  }
  if (model !== undefined && model.length > FORGE_RULE_MODEL_MAX_LENGTH) {
    return { ok: false, reason: "model is too long" };
  }
  const codexModelProvider = backend === "codex" ? normalizeCodexModelProvider(provider) : undefined;
  return {
    ok: true,
    agent: {
      backend,
      ...(codexModelProvider ? { codexModelProvider } : {}),
      ...(model ? { model } : {}),
    },
  };
}

/** A stable key for an agent row: two rules with the same key are one row. */
export function forgeAgentRuleAgentKey(agent: ForgeAgentRuleAgent): string {
  return JSON.stringify([agent.backend, agent.codexModelProvider ?? "", agent.model ?? ""]);
}

export function sameForgeAgentRuleAgent(left: ForgeAgentRuleAgent, right: ForgeAgentRuleAgent): boolean {
  return forgeAgentRuleAgentKey(left) === forgeAgentRuleAgentKey(right);
}

export function forgeAgentRuleSpecificity(agent: ForgeAgentRuleAgent): ForgeAgentRuleSpecificity {
  if (agent.backend === FORGE_AGENT_RULE_ALL_AGENTS) return 1;
  return agent.model ? 3 : 2;
}

export type ForgeAgentToolRuleValidation =
  | { ok: true; rule: ForgeAgentToolRule; problems: string[] }
  | { ok: false; reason: string };

/**
 * Validate one rule. A rule with no repository or a bad agent is rejected.
 * A group set to an unknown level is kept as Ask rather than dropped, since
 * dropping it would let a broader rule or the global level apply: a typo must
 * never give an agent more than the operator meant. `problems` names each such
 * repair for the caller to log.
 */
export function validateForgeAgentToolRule(value: {
  repository?: unknown;
  agent?: { backend?: unknown; codexModelProvider?: unknown; model?: unknown };
  access?: Record<string, unknown>;
}): ForgeAgentToolRuleValidation {
  const repository = typeof value.repository === "string"
    ? normalizeForgeRuleRepository(value.repository)
    : undefined;
  if (!repository) {
    return {
      ok: false,
      reason: value.repository === undefined
        ? "missing repository"
        : `invalid repository ${JSON.stringify(value.repository)}`,
    };
  }
  const agent = validateForgeAgentRuleAgent(value.agent ?? {});
  if (!agent.ok) return agent;
  const problems: string[] = [];
  const access: ForgeAgentToolRule["access"] = {};
  for (const group of FORGE_AGENT_TOOL_RULE_GROUPS) {
    const level = value.access?.[group];
    if (level === undefined) continue;
    if (isForgeAgentToolAccess(group, level)) {
      access[group] = level;
    } else {
      access[group] = "ask";
      problems.push(`${group} has unknown level ${JSON.stringify(level)}; using "ask"`);
    }
  }
  return { ok: true, rule: { repository, agent: agent.agent, access }, problems };
}

/**
 * Validate and de-duplicate a rules list. Invalid rules are skipped and
 * reported through `onProblem`; rules for the same repository and agent merge,
 * a later rule winning per group, at the position of the first.
 */
export function normalizeForgeAgentToolRules(
  rules: readonly unknown[] | undefined,
  onProblem?: (problem: string, index: number) => void,
): ForgeAgentToolRule[] {
  const merged: ForgeAgentToolRule[] = [];
  const byKey = new Map<string, ForgeAgentToolRule>();
  (rules ?? []).forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      onProblem?.("rule is not a table", index);
      return;
    }
    const result = validateForgeAgentToolRule(candidate as Parameters<typeof validateForgeAgentToolRule>[0]);
    if (!result.ok) {
      onProblem?.(result.reason, index);
      return;
    }
    for (const problem of result.problems) onProblem?.(problem, index);
    const key = `${result.rule.repository}\n${forgeAgentRuleAgentKey(result.rule.agent)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.access = { ...existing.access, ...result.rule.access };
      return;
    }
    const rule = { ...result.rule, access: { ...result.rule.access } };
    byKey.set(key, rule);
    merged.push(rule);
  });
  return merged;
}

function sameRuleModel(ruleModel: string, identityModel: string, backend: string): boolean {
  if (backend !== "codex") return ruleModel === identityModel;
  return parseCodexProviderModelId(ruleModel).model === parseCodexProviderModelId(identityModel).model;
}

/**
 * Does a rule's agent cover this caller? The All agents row covers everyone.
 * Codex rules compare the model provider, where none means the default
 * provider, so a Codex rule never covers a thread on a custom provider. A
 * model rule needs the caller's model to be known and identical.
 */
export function forgeAgentRuleMatches(agent: ForgeAgentRuleAgent, identity: ForgeAgentIdentity): boolean {
  if (agent.backend === FORGE_AGENT_RULE_ALL_AGENTS) return true;
  if (agent.backend !== identity.backend) return false;
  if (agent.backend === "codex") {
    const identityProvider = normalizeCodexModelProvider(
      identity.codexModelProvider
        ?? (identity.model ? parseCodexProviderModelId(identity.model).providerId : undefined),
    );
    if (normalizeCodexModelProvider(agent.codexModelProvider) !== identityProvider) return false;
  }
  if (agent.model === undefined) return true;
  return identity.model !== undefined && sameRuleModel(agent.model, identity.model, agent.backend);
}

const FORGE_AGENT_TOOL_ACCESS_RANK: Record<ForgeAgentToolAccess, number> = {
  off: 0,
  ask: 1,
  auto: 2,
  allow: 3,
};

function ruleLevel(rule: ForgeAgentToolRule, group: ForgeAgentToolRuleGroup): ForgeAgentToolAccess | undefined {
  const level = rule.access[group];
  if (level === undefined) return undefined;
  // A policy built outside the loader can hold anything; never fail open.
  return isForgeAgentToolAccess(group, level) ? level : "ask";
}

function pickMostSpecificRule(
  rules: readonly ForgeAgentToolRule[],
  group: ForgeAgentToolRuleGroup,
  covers: (rule: ForgeAgentToolRule) => boolean,
): { rule: ForgeAgentToolRule; level: ForgeAgentToolAccess; specificity: ForgeAgentRuleSpecificity } | undefined {
  let best: { rule: ForgeAgentToolRule; level: ForgeAgentToolAccess; specificity: ForgeAgentRuleSpecificity } | undefined;
  for (const rule of rules) {
    const level = ruleLevel(rule, group);
    if (level === undefined || !covers(rule)) continue;
    const specificity = forgeAgentRuleSpecificity(rule.agent);
    if (
      !best
      || specificity > best.specificity
      // Two equally specific rules disagree only when the list was built
      // outside the loader; the more restrictive one wins.
      || (specificity === best.specificity
        && FORGE_AGENT_TOOL_ACCESS_RANK[level] < FORGE_AGENT_TOOL_ACCESS_RANK[best.level])
    ) {
      best = { rule, level, specificity };
    }
  }
  return best;
}

function repositoryProviderOf(
  repository: string | ForgeRuleRepositoryRef,
): ForgeRuleRepositoryProvider | undefined {
  return typeof repository === "string" ? undefined : repository.provider;
}

/**
 * The access a forge tool call gets. The master switch and a globally Off
 * group win outright: project rules cannot re-enable a group whose tools are
 * hidden from every schema. Otherwise the most specific rule for this
 * repository that covers the caller and sets the group decides, and with
 * none the global level does. `read` always uses the global level.
 */
export function resolveForgeAgentToolAccess(
  policy: ForgeAgentToolPolicy,
  group: ForgeAgentToolGroup,
  repository: string | ForgeRuleRepositoryRef | undefined,
  identity: ForgeAgentIdentity | undefined,
): ForgeAgentToolAccessResolution {
  if (!policy.enabled) return { level: "off", source: "disabled" };
  const globalLevel = policy.access[group];
  if (globalLevel === "off" || !isForgeAgentToolRuleGroup(group) || !repository || !identity) {
    return { level: globalLevel, source: "default" };
  }
  const provider = repositoryProviderOf(repository);
  const key = normalizeForgeRuleRepository(repository, provider);
  if (!key) return { level: globalLevel, source: "default" };
  const best = pickMostSpecificRule(policy.rules ?? [], group, (rule) =>
    normalizeForgeRuleRepository(rule.repository, provider) === key
    && forgeAgentRuleMatches(rule.agent, identity));
  return best
    ? { level: best.level, source: "project_rule", rule: best.rule, specificity: best.specificity }
    : { level: globalLevel, source: "default" };
}

/**
 * What an agent row's unset cell inherits: the closest less specific rule
 * for the same repository (a model row inherits its agent row, then All
 * agents), else the global level. Settings shows this as "Inherit (…)".
 */
export function resolveForgeAgentToolInheritedAccess(
  policy: ForgeAgentToolPolicy,
  group: ForgeAgentToolRuleGroup,
  repository: string,
  agent: ForgeAgentRuleAgent,
): ForgeAgentToolAccessResolution {
  if (!policy.enabled) return { level: "off", source: "disabled" };
  const globalLevel = policy.access[group];
  if (globalLevel === "off") return { level: globalLevel, source: "default" };
  const key = normalizeForgeRuleRepository(repository);
  const rowSpecificity = forgeAgentRuleSpecificity(agent);
  const best = key
    ? pickMostSpecificRule(policy.rules ?? [], group, (rule) => {
      if (normalizeForgeRuleRepository(rule.repository) !== key) return false;
      if (forgeAgentRuleSpecificity(rule.agent) >= rowSpecificity) return false;
      return rule.agent.backend === FORGE_AGENT_RULE_ALL_AGENTS
        || (rule.agent.backend === agent.backend
          && normalizeCodexModelProvider(rule.agent.codexModelProvider)
            === normalizeCodexModelProvider(agent.codexModelProvider));
    })
    : undefined;
  return best
    ? { level: best.level, source: "project_rule", rule: best.rule, specificity: best.specificity }
    : { level: globalLevel, source: "default" };
}

/**
 * Set or clear one group of one (repository, agent) rule and return the new
 * list; the input is not changed. `level` undefined clears the group, which
 * then inherits. A rule that does not exist yet is appended. A rule left
 * with no groups is kept, because Settings shows an agent row until the
 * operator removes it.
 */
export function upsertForgeAgentToolRule(
  rules: readonly ForgeAgentToolRule[],
  update: {
    repository: string;
    agent: ForgeAgentRuleAgent;
    group: ForgeAgentToolRuleGroup;
    level: ForgeAgentToolAccess | undefined;
  },
): ForgeAgentToolRule[] {
  const repository = normalizeForgeRuleRepository(update.repository);
  if (!repository) throw new Error(`Invalid forge rule repository: ${update.repository}`);
  const agent = validateForgeAgentRuleAgent(update.agent);
  if (!agent.ok) throw new Error(`Invalid forge rule agent: ${agent.reason}`);
  if (update.level !== undefined && !isForgeAgentToolAccess(update.group, update.level)) {
    throw new Error(`Invalid forge rule level: ${String(update.level)}`);
  }
  const agentKey = forgeAgentRuleAgentKey(agent.agent);
  let found = false;
  const next = rules.map((rule) => {
    if (
      normalizeForgeRuleRepository(rule.repository) !== repository
      || forgeAgentRuleAgentKey(rule.agent) !== agentKey
    ) {
      return rule;
    }
    found = true;
    const access = { ...rule.access };
    if (update.level === undefined) delete access[update.group];
    else access[update.group] = update.level;
    return { ...rule, access };
  });
  if (!found) {
    next.push({
      repository,
      agent: agent.agent,
      access: update.level === undefined ? {} : { [update.group]: update.level },
    });
  }
  return next;
}

/** Drop one (repository, agent) rule; the input is not changed. */
export function removeForgeAgentToolRule(
  rules: readonly ForgeAgentToolRule[],
  repository: string,
  agent: ForgeAgentRuleAgent,
): ForgeAgentToolRule[] {
  const key = normalizeForgeRuleRepository(repository);
  const agentKey = forgeAgentRuleAgentKey(agent);
  return rules.filter((rule) =>
    normalizeForgeRuleRepository(rule.repository) !== key
    || forgeAgentRuleAgentKey(rule.agent) !== agentKey);
}

// ---------------------------------------------------------------------------
// Rule wording, shared by Settings, approval cards, and tool results
// ---------------------------------------------------------------------------

/** Display names the caller knows; ids are shown when a name is missing. */
export type ForgeAgentRuleNames = {
  acpAgent?: (registryId: string) => string | undefined;
  codexModelProvider?: (providerId: string) => string | undefined;
};

/** What each group lets an agent do, as a verb phrase and its -ing form. */
export const FORGE_AGENT_TOOL_GROUP_ACTIONS: Record<ForgeAgentToolGroup, { base: string; gerund: string }> = {
  read: { base: "read forge data", gerund: "reading forge data" },
  pull_requests: { base: "open or update pull requests", gerund: "opening or updating pull requests" },
  comments: { base: "post comments and reviews", gerund: "posting comments and reviews" },
  issues: { base: "open or update issues", gerund: "opening or updating issues" },
  ci: { base: "rerun failed CI jobs", gerund: "rerunning failed CI jobs" },
  approve_merge: { base: "approve or merge pull requests", gerund: "approving or merging pull requests" },
};

/** "Claude", "Codex", "Codex · llamacpp · qwen3", "Grok", or "All agents". */
export function forgeAgentRuleAgentLabel(agent: ForgeAgentRuleAgent, names?: ForgeAgentRuleNames): string {
  if (agent.backend === FORGE_AGENT_RULE_ALL_AGENTS) return "All agents";
  const parts: string[] = [];
  if (agent.backend === "claude") {
    parts.push("Claude");
  } else if (agent.backend === "codex") {
    parts.push("Codex");
    if (agent.codexModelProvider) {
      parts.push(names?.codexModelProvider?.(agent.codexModelProvider) ?? agent.codexModelProvider);
    }
  } else {
    const registryId = agent.backend.slice("acp:".length);
    parts.push(names?.acpAgent?.(registryId) ?? registryId);
  }
  if (agent.model) parts.push(agent.model);
  return parts.join(" · ");
}

/** The rule agent that matches a caller exactly, with or without its model. */
export function forgeAgentRuleAgentForIdentity(
  identity: ForgeAgentIdentity,
  options: { includeModel: boolean },
): ForgeAgentRuleAgent | undefined {
  const codexModelProvider = identity.backend === "codex"
    ? normalizeCodexModelProvider(
      identity.codexModelProvider
        ?? (identity.model ? parseCodexProviderModelId(identity.model).providerId : undefined),
    )
    : undefined;
  const model = options.includeModel && identity.model
    ? identity.backend === "codex" ? parseCodexProviderModelId(identity.model).model : identity.model
    : undefined;
  if (options.includeModel && !model) return undefined;
  const result = validateForgeAgentRuleAgent({ backend: identity.backend, codexModelProvider, model });
  return result.ok && result.agent.backend !== FORGE_AGENT_RULE_ALL_AGENTS ? result.agent : undefined;
}

/** "pwrdrvr/PwrAgent rule for Codex · llamacpp · qwen3-abliterated". */
export function forgeAgentToolRuleDescription(
  rule: Pick<ForgeAgentToolRule, "repository" | "agent">,
  options?: { projectLabel?: string; names?: ForgeAgentRuleNames },
): string {
  const project = options?.projectLabel?.trim() || forgeRuleRepositoryLabel(rule.repository);
  const agent = rule.agent.backend === FORGE_AGENT_RULE_ALL_AGENTS
    ? "all agents"
    : forgeAgentRuleAgentLabel(rule.agent, options?.names);
  return `${project} rule for ${agent}`;
}

function forgeAgentToolLevelPhrase(group: ForgeAgentToolGroup, level: ForgeAgentToolAccess): string {
  const action = FORGE_AGENT_TOOL_GROUP_ACTIONS[group].gerund;
  switch (level) {
    case "allow":
      return `allows ${action} without asking`;
    case "auto":
      return group === "approve_merge"
        ? `asks before ${action} unless the turn has Full Access`
        : `asks before ${action} unless the turn runs in Auto or Full Access`;
    case "ask":
      return `asks before ${action}`;
    case "off":
      return `turns off ${action}`;
  }
}

/**
 * One sentence naming the rule and what it does, for an approval card's
 * subtitle or a log line: "The pwrdrvr/PwrAgent rule for Claude asks before
 * opening or updating pull requests."
 */
export function forgeAgentToolRuleSentence(
  rule: Pick<ForgeAgentToolRule, "repository" | "agent">,
  group: ForgeAgentToolGroup,
  level: ForgeAgentToolAccess,
  options?: { projectLabel?: string; names?: ForgeAgentRuleNames },
): string {
  return `The ${forgeAgentToolRuleDescription(rule, options)} ${forgeAgentToolLevelPhrase(group, level)}.`;
}

/** The refusal when a rule set to Off decided the call. */
export function forgeAgentToolRuleOffMessage(
  rule: Pick<ForgeAgentToolRule, "repository" | "agent">,
  group: ForgeAgentToolGroup,
  options?: { projectLabel?: string; names?: ForgeAgentRuleNames },
): string {
  return `${forgeAgentToolRuleSentence(rule, group, "off", options)} `
    + "The operator can change it in Settings → Git → Agent forge tools.";
}

// ---------------------------------------------------------------------------
// Approval card remember menu
// ---------------------------------------------------------------------------

/**
 * Elicitation request `_meta` key: the list of remember options main offers
 * for this card (`ForgeApprovalRememberOption[]`). Absent when none apply.
 */
export const FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY = "pwragent_forge_remember_options";

/**
 * Elicitation response `_meta` key: the option id the operator chose with
 * Allow. Main honors it only if it offered that option for that request.
 */
export const FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY = "pwragent_forge_remember_choice";

export const FORGE_APPROVAL_REMEMBER_OPTION_AGENT = "agent";
export const FORGE_APPROVAL_REMEMBER_OPTION_AGENT_MODEL = "agent_model";
export const FORGE_APPROVAL_REMEMBER_OPTION_IDS = [
  FORGE_APPROVAL_REMEMBER_OPTION_AGENT,
  FORGE_APPROVAL_REMEMBER_OPTION_AGENT_MODEL,
] as const;

export type ForgeApprovalRememberOptionId = (typeof FORGE_APPROVAL_REMEMBER_OPTION_IDS)[number];

export type ForgeApprovalRememberOption = {
  id: ForgeApprovalRememberOptionId;
  label: string;
  description: string;
};

/** Approve and merge is never remembered from a card. */
export const FORGE_APPROVAL_REMEMBER_GROUPS = [
  "pull_requests",
  "comments",
  "issues",
  "ci",
] as const satisfies readonly ForgeAgentToolRuleGroup[];

export function isForgeApprovalRememberGroup(
  value: unknown,
): value is (typeof FORGE_APPROVAL_REMEMBER_GROUPS)[number] {
  return FORGE_APPROVAL_REMEMBER_GROUPS.some((group) => group === value);
}

export function isForgeApprovalRememberOptionId(value: unknown): value is ForgeApprovalRememberOptionId {
  return FORGE_APPROVAL_REMEMBER_OPTION_IDS.some((id) => id === value);
}

/**
 * The remember options for a card, or none. A card offers them only for
 * pull requests, comments, issues, and CI; never in an automation; and never
 * when a rule set to Ask is why the card is showing, since the operator
 * already chose to be asked there.
 */
export function buildForgeApprovalRememberOptions(input: {
  group: ForgeAgentToolGroup;
  repository: string;
  identity: ForgeAgentIdentity;
  resolution: ForgeAgentToolAccessResolution;
  automation: boolean;
  projectLabel?: string;
  names?: ForgeAgentRuleNames;
}): ForgeApprovalRememberOption[] {
  if (!isForgeApprovalRememberGroup(input.group) || input.automation) return [];
  if (input.resolution.level === "off" || input.resolution.level === "allow") return [];
  if (input.resolution.source === "project_rule" && input.resolution.level === "ask") return [];
  const repository = normalizeForgeRuleRepository(input.repository);
  const agent = forgeAgentRuleAgentForIdentity(input.identity, { includeModel: false });
  if (!repository || !agent) return [];
  const project = input.projectLabel?.trim() || forgeRuleRepositoryLabel(repository);
  const action = FORGE_AGENT_TOOL_GROUP_ACTIONS[input.group].base;
  const agentLabel = forgeAgentRuleAgentLabel(agent, input.names);
  const options: ForgeApprovalRememberOption[] = [];
  // A model rule already decides this group, so an agent-wide Allow would sit
  // under it and change nothing.
  const shadowedByModelRule =
    input.resolution.source === "project_rule" && input.resolution.specificity === 3;
  if (!shadowedByModelRule) {
    options.push({
      id: FORGE_APPROVAL_REMEMBER_OPTION_AGENT,
      label: `Always allow ${agentLabel} in ${project}`,
      description: `${agentLabel} can ${action} in ${project} without asking, with any model. `
        + "Change it in Settings → Git → Agent forge tools.",
    });
  }
  const modelAgent = forgeAgentRuleAgentForIdentity(input.identity, { includeModel: true });
  if (modelAgent?.model) {
    options.push({
      id: FORGE_APPROVAL_REMEMBER_OPTION_AGENT_MODEL,
      label: `Always allow ${modelAgent.model} in ${project}`,
      description: `${forgeAgentRuleAgentLabel(modelAgent, input.names)} can ${action} in ${project} `
        + "without asking. Other models still ask. Change it in Settings → Git → Agent forge tools.",
    });
  }
  return options;
}

/** The rule agent an accepted remember option writes. */
export function forgeApprovalRememberRuleAgent(
  optionId: ForgeApprovalRememberOptionId,
  identity: ForgeAgentIdentity,
): ForgeAgentRuleAgent | undefined {
  return forgeAgentRuleAgentForIdentity(identity, {
    includeModel: optionId === FORGE_APPROVAL_REMEMBER_OPTION_AGENT_MODEL,
  });
}

/** Read the offered options from an elicitation request's `_meta`. */
export function readForgeApprovalRememberOptions(
  meta: Record<string, unknown> | null | undefined,
): ForgeApprovalRememberOption[] {
  const value = meta?.[FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ForgeApprovalRememberOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, label, description } = item as Record<string, unknown>;
    if (!isForgeApprovalRememberOptionId(id) || seen.has(id)) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    seen.add(id);
    options.push({ id, label, description: typeof description === "string" ? description : "" });
  }
  return options;
}

/** Read the chosen option id from an elicitation response's `_meta`. */
export function readForgeApprovalRememberChoice(
  meta: Record<string, unknown> | null | undefined,
): ForgeApprovalRememberOptionId | undefined {
  const value = meta?.[FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY];
  return isForgeApprovalRememberOptionId(value) ? value : undefined;
}
