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
  "approve_merge",
] as const;

export type ForgeAgentToolGroup = (typeof FORGE_AGENT_TOOL_GROUPS)[number];

/**
 * `allow` runs without asking. `auto` asks unless the thread has Full Access,
 * the same rule as an MCP connection's Auto tool approval. `ask` always asks.
 * `off` removes the group's tools from threads.
 */
export const FORGE_AGENT_TOOL_ACCESS_LEVELS = ["allow", "auto", "ask", "off"] as const;

export type ForgeAgentToolAccess = (typeof FORGE_AGENT_TOOL_ACCESS_LEVELS)[number];

export type ForgeAgentToolPolicy = {
  enabled: boolean;
  access: Record<ForgeAgentToolGroup, ForgeAgentToolAccess>;
};

export const DEFAULT_FORGE_AGENT_TOOL_POLICY: ForgeAgentToolPolicy = {
  enabled: true,
  access: {
    read: "allow",
    pull_requests: "auto",
    comments: "auto",
    issues: "auto",
    approve_merge: "ask",
  },
};

export const FORGE_AGENT_TOOL_GROUP_LABELS: Record<ForgeAgentToolGroup, string> = {
  read: "Read",
  pull_requests: "Pull requests",
  comments: "Comments and reviews",
  issues: "Issues",
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
  merge_pull_request: "approve_merge",
} as const satisfies Record<string, Exclude<ForgeAgentToolGroup, "read">>;

export type ForgeAgentWriteToolName = keyof typeof FORGE_AGENT_WRITE_TOOL_GROUPS;

export function isForgeWriteToolName(tool: string): tool is ForgeAgentWriteToolName {
  return Object.prototype.hasOwnProperty.call(FORGE_AGENT_WRITE_TOOL_GROUPS, tool);
}
