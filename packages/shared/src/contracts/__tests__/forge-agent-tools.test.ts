import { describe, expect, it } from "vitest";

import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY,
  FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY,
  buildForgeApprovalRememberOptions,
  forgeAgentRuleAgentLabel,
  forgeAgentRuleMatches,
  forgeAgentToolRuleOffMessage,
  forgeAgentToolRuleSentence,
  forgeApprovalRememberRuleAgent,
  forgeRuleProjectLabel,
  normalizeForgeAgentToolRules,
  normalizeForgeRuleRepository,
  readForgeApprovalRememberChoice,
  readForgeApprovalRememberOptions,
  removeForgeAgentToolRule,
  resolveForgeAgentToolAccess,
  resolveForgeAgentToolInheritedAccess,
  upsertForgeAgentToolRule,
  validateForgeAgentRuleAgent,
  type ForgeAgentIdentity,
  type ForgeAgentToolPolicy,
  type ForgeAgentToolRule,
} from "../forge-agent-tools";

const REPO = "github.com/pwrdrvr/pwragent";
const REPO_REF = { provider: "github" as const, host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" };

const CLAUDE: ForgeAgentIdentity = { backend: "claude", model: "claude-opus-5" };
const CODEX_OPENAI: ForgeAgentIdentity = { backend: "codex", model: "gpt-5.5" };
const CODEX_LOCAL: ForgeAgentIdentity = {
  backend: "codex",
  codexModelProvider: "llamacpp",
  model: "qwen3-abliterated",
};
const GROK: ForgeAgentIdentity = { backend: "acp:grok", model: "grok-5" };

function policy(rules: ForgeAgentToolRule[], overrides?: Partial<ForgeAgentToolPolicy>): ForgeAgentToolPolicy {
  return {
    ...DEFAULT_FORGE_AGENT_TOOL_POLICY,
    access: { ...DEFAULT_FORGE_AGENT_TOOL_POLICY.access },
    rules,
    ...overrides,
  };
}

const PRECEDENCE_RULES: ForgeAgentToolRule[] = [
  { repository: REPO, agent: { backend: "*" }, access: { pull_requests: "ask", comments: "allow" } },
  { repository: REPO, agent: { backend: "claude" }, access: { pull_requests: "allow" } },
  { repository: REPO, agent: { backend: "codex" }, access: { pull_requests: "allow", issues: "allow" } },
  {
    repository: REPO,
    agent: { backend: "codex", codexModelProvider: "llamacpp" },
    access: { pull_requests: "auto" },
  },
  {
    repository: REPO,
    agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
    access: { pull_requests: "ask", ci: "off" },
  },
  { repository: REPO, agent: { backend: "claude", model: "claude-opus-5" }, access: { approve_merge: "allow" } },
  { repository: "github.com/other/repo", agent: { backend: "*" }, access: { pull_requests: "off" } },
];

describe("resolveForgeAgentToolAccess", () => {
  it.each([
    // [identity, group, level, source, specificity]
    ["no rule for the group uses the global level", CLAUDE, "issues", "auto", "default", undefined],
    ["All agents sets comments for everyone", GROK, "comments", "allow", "project_rule", 1],
    ["All agents covers an agent with no row", GROK, "pull_requests", "ask", "project_rule", 1],
    ["an agent row beats All agents", CLAUDE, "pull_requests", "allow", "project_rule", 2],
    ["Codex on OpenAI uses the codex row", CODEX_OPENAI, "pull_requests", "allow", "project_rule", 2],
    ["a model row beats its provider row", CODEX_LOCAL, "pull_requests", "ask", "project_rule", 3],
    ["a model row can turn a group off", CODEX_LOCAL, "ci", "off", "project_rule", 3],
    ["Codex rows never cover a custom provider", CODEX_LOCAL, "issues", "auto", "default", undefined],
    ["approve_merge follows a model rule", CLAUDE, "approve_merge", "allow", "project_rule", 3],
  ] as const)("%s", (_name, identity, group, level, source, specificity) => {
    const result = resolveForgeAgentToolAccess(policy(PRECEDENCE_RULES), group, REPO_REF, identity);
    expect(result.level).toBe(level);
    expect(result.source).toBe(source);
    if (result.source === "project_rule") expect(result.specificity).toBe(specificity);
  });

  it("uses the provider row when the custom-provider model differs", () => {
    const result = resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES),
      "pull_requests",
      REPO_REF,
      { ...CODEX_LOCAL, model: "llama-4" },
    );
    expect(result).toMatchObject({ level: "auto", source: "project_rule", specificity: 2 });
  });

  it("does not match model rules when the thread's model is unknown", () => {
    const result = resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES),
      "approve_merge",
      REPO_REF,
      { backend: "claude" },
    );
    expect(result).toEqual({ level: "ask", source: "default" });
  });

  it("compares bare model ids for qualified Codex models", () => {
    const result = resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES),
      "ci",
      REPO_REF,
      { backend: "codex", codexModelProvider: "llamacpp", model: "@llamacpp/qwen3-abliterated" },
    );
    expect(result).toMatchObject({ level: "off", source: "project_rule" });
  });

  it("treats a qualified model as its provider even when the provider is not reported", () => {
    const result = resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES),
      "issues",
      REPO_REF,
      { backend: "codex", model: "@llamacpp/qwen3-abliterated" },
    );
    expect(result).toEqual({ level: "auto", source: "default" });
  });

  it("treats a rule naming the openai provider as the default provider", () => {
    const rules: ForgeAgentToolRule[] = [
      { repository: REPO, agent: { backend: "codex", codexModelProvider: "openai" }, access: { issues: "allow" } },
    ];
    expect(resolveForgeAgentToolAccess(policy(rules), "issues", REPO_REF, CODEX_OPENAI).level).toBe("allow");
    expect(resolveForgeAgentToolAccess(policy(rules), "issues", REPO_REF, CODEX_LOCAL).level).toBe("auto");
  });

  it("does not let a rule re-enable a globally Off group", () => {
    const base = policy(PRECEDENCE_RULES);
    const result = resolveForgeAgentToolAccess(
      { ...base, access: { ...base.access, pull_requests: "off" } },
      "pull_requests",
      REPO_REF,
      CLAUDE,
    );
    expect(result).toEqual({ level: "off", source: "default" });
  });

  it("turns everything off when the master switch is off", () => {
    const result = resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES, { enabled: false }),
      "comments",
      REPO_REF,
      CLAUDE,
    );
    expect(result).toEqual({ level: "off", source: "disabled" });
  });

  it("keeps reads global", () => {
    const rules = [{ repository: REPO, agent: { backend: "*" }, access: { read: "off" } }] as unknown as ForgeAgentToolRule[];
    expect(resolveForgeAgentToolAccess(policy(rules), "read", REPO_REF, CLAUDE)).toEqual({
      level: "allow",
      source: "default",
    });
  });

  it("ignores rules for other repositories and accepts a string key", () => {
    expect(resolveForgeAgentToolAccess(policy(PRECEDENCE_RULES), "pull_requests", "github.com/other/repo", CLAUDE))
      .toMatchObject({ level: "off", source: "project_rule" });
    expect(resolveForgeAgentToolAccess(
      policy(PRECEDENCE_RULES),
      "pull_requests",
      { provider: "github", host: "github.com", owner: "pwrdrvr", repo: "other" },
      CLAUDE,
    )).toEqual({ level: "auto", source: "default" });
  });

  it("matches a repository without regard to case, whatever the provider", () => {
    const rules: ForgeAgentToolRule[] = [
      { repository: "git.corp.example/Team/Repo", agent: { backend: "claude" }, access: { issues: "allow" } },
    ];
    expect(resolveForgeAgentToolAccess(
      policy(rules),
      "issues",
      { provider: "github", host: "git.corp.example", owner: "team", repo: "repo" },
      CLAUDE,
    ).level).toBe("allow");
    expect(resolveForgeAgentToolAccess(
      policy(rules),
      "issues",
      { provider: "gitlab", host: "git.corp.example", owner: "TEAM", repo: "repo" },
      CLAUDE,
    ).level).toBe("allow");
  });

  describe("for a Codex thread whose model provider is unknown", () => {
    const unknown: ForgeAgentIdentity = { backend: "codex", codexModelProviderUnknown: true, model: "qwen3-abliterated" };

    it("never lets a Codex rule loosen access", () => {
      const rules: ForgeAgentToolRule[] = [
        { repository: REPO, agent: { backend: "codex" }, access: { comments: "allow" } },
        { repository: REPO, agent: { backend: "codex", model: "qwen3-abliterated" }, access: { issues: "allow" } },
      ];
      expect(resolveForgeAgentToolAccess(policy(rules), "comments", REPO_REF, unknown))
        .toEqual({ level: "auto", source: "default" });
      expect(resolveForgeAgentToolAccess(policy(rules), "issues", REPO_REF, unknown))
        .toEqual({ level: "auto", source: "default" });
      // The same rules apply once Codex reports the default provider.
      expect(resolveForgeAgentToolAccess(policy(rules), "comments", REPO_REF, CODEX_OPENAI).level).toBe("allow");
    });

    it("lets any Codex rule that could cover it restrict it", () => {
      const rules: ForgeAgentToolRule[] = [
        { repository: REPO, agent: { backend: "*" }, access: { comments: "allow", issues: "allow" } },
        { repository: REPO, agent: { backend: "codex" }, access: { comments: "ask" } },
        { repository: REPO, agent: { backend: "codex", codexModelProvider: "llamacpp" }, access: { issues: "off" } },
      ];
      expect(resolveForgeAgentToolAccess(policy(rules), "comments", REPO_REF, unknown))
        .toMatchObject({ level: "ask", source: "project_rule", rule: rules[1] });
      expect(resolveForgeAgentToolAccess(policy(rules), "issues", REPO_REF, unknown))
        .toMatchObject({ level: "off", source: "project_rule", rule: rules[2] });
      expect(resolveForgeAgentToolAccess(policy(rules), "pull_requests", REPO_REF, unknown))
        .toEqual({ level: "auto", source: "default" });
    });

    it("is known once a qualified model names the provider", () => {
      const rules: ForgeAgentToolRule[] = [
        { repository: REPO, agent: { backend: "codex", codexModelProvider: "llamacpp" }, access: { comments: "allow" } },
      ];
      expect(resolveForgeAgentToolAccess(policy(rules), "comments", REPO_REF, {
        ...unknown,
        model: "@llamacpp/qwen3-abliterated",
      }).level).toBe("allow");
    });

    it("offers no remember option, which could only name the default provider", () => {
      expect(forgeApprovalRememberRuleAgent("agent", unknown)).toBeUndefined();
      expect(forgeApprovalRememberRuleAgent("agent_model", unknown)).toBeUndefined();
      expect(buildForgeApprovalRememberOptions({
        group: "comments",
        repository: REPO,
        identity: unknown,
        resolution: { level: "ask", source: "default" },
        automation: false,
      })).toEqual([]);
    });
  });

  describe("for a repository with an unreadable rule entry", () => {
    const rules: ForgeAgentToolRule[] = [
      { repository: REPO, agent: { backend: "*" }, access: { pull_requests: "allow", issues: "off" } },
    ];
    const tainted = policy(rules, { unreadableRuleRepositories: ["github.com/PwrDrvr/PwrAgent"] });

    it("caps Allow and Auto at Ask", () => {
      expect(resolveForgeAgentToolAccess(tainted, "pull_requests", REPO_REF, CLAUDE))
        .toEqual({ level: "ask", source: "unreadable_rule", repository: REPO });
      expect(resolveForgeAgentToolAccess(tainted, "comments", REPO_REF, CLAUDE))
        .toEqual({ level: "ask", source: "unreadable_rule", repository: REPO });
    });

    it("keeps Off, and leaves other repositories alone", () => {
      expect(resolveForgeAgentToolAccess(tainted, "issues", REPO_REF, CLAUDE).level).toBe("off");
      expect(resolveForgeAgentToolAccess(tainted, "comments", "github.com/other/repo", CLAUDE))
        .toEqual({ level: "auto", source: "default" });
    });

    it("offers no remember option", () => {
      expect(buildForgeApprovalRememberOptions({
        group: "pull_requests",
        repository: REPO,
        identity: CLAUDE,
        resolution: { level: "ask", source: "unreadable_rule", repository: REPO },
        automation: false,
      })).toEqual([]);
    });
  });

  it("picks the more restrictive of two equally specific rules", () => {
    const rules: ForgeAgentToolRule[] = [
      { repository: REPO, agent: { backend: "claude" }, access: { issues: "allow" } },
      { repository: "github.com/PwrDrvr/PwrAgent", agent: { backend: "claude" }, access: { issues: "ask" } },
    ];
    expect(resolveForgeAgentToolAccess(policy(rules), "issues", REPO_REF, CLAUDE).level).toBe("ask");
  });

  it("uses the global level without a repository or identity", () => {
    expect(resolveForgeAgentToolAccess(policy(PRECEDENCE_RULES), "pull_requests", undefined, CLAUDE))
      .toEqual({ level: "auto", source: "default" });
    expect(resolveForgeAgentToolAccess(policy(PRECEDENCE_RULES), "pull_requests", REPO_REF, undefined))
      .toEqual({ level: "auto", source: "default" });
  });
});

describe("resolveForgeAgentToolInheritedAccess", () => {
  it("inherits from the agent row, then All agents, then the global level", () => {
    const p = policy(PRECEDENCE_RULES);
    const modelRow = { backend: "codex" as const, codexModelProvider: "llamacpp", model: "qwen3-abliterated" };
    expect(resolveForgeAgentToolInheritedAccess(p, "pull_requests", REPO, modelRow).level).toBe("auto");
    expect(resolveForgeAgentToolInheritedAccess(p, "comments", REPO, modelRow).level).toBe("allow");
    expect(resolveForgeAgentToolInheritedAccess(p, "issues", REPO, modelRow).level).toBe("auto");
    expect(resolveForgeAgentToolInheritedAccess(p, "pull_requests", REPO, { backend: "*" }))
      .toEqual({ level: "auto", source: "default" });
  });
});

describe("normalizeForgeRuleRepository", () => {
  it.each([
    ["github.com/PwrDrvr/PwrAgent", "github.com/pwrdrvr/pwragent"],
    ["https://GitHub.com/PwrDrvr/PwrAgent.git/", "github.com/pwrdrvr/pwragent"],
    ["gitlab.com/Group/Sub/Repo", "gitlab.com/Group/Sub/Repo"],
    ["github.com/a/b/c", undefined],
    ["https://github.com/PwrDrvr/PwrAgent/pull/5", "github.com/pwrdrvr/pwragent"],
    ["https://gitlab.com/Group/Repo/-/merge_requests/5", "gitlab.com/Group/Repo"],
    ["https://gitlab.com/Group/Sub/Repo/-/tree/main?ref_type=heads", "gitlab.com/Group/Sub/Repo"],
    ["gitlab.com/group/-/merge_requests", undefined],
    ["gitlab.com/group/-repo", undefined],
    ["gitlab.com/group/repo.atom", undefined],
    ["github.com/onlyowner", undefined],
    ["", undefined],
    ["github.com/../repo", undefined],
  ])("%s → %s", (input, expected) => {
    expect(normalizeForgeRuleRepository(input)).toBe(expected);
  });

  it("uses the given provider", () => {
    expect(normalizeForgeRuleRepository({ provider: "gitlab", host: "GitLab.com", owner: "A/B", repo: "C" }))
      .toBe("gitlab.com/A/B/C");
    expect(normalizeForgeRuleRepository("git.corp.example/Team/Repo", "github")).toBe("git.corp.example/team/repo");
  });
});

describe("normalizeForgeAgentToolRules", () => {
  it("skips invalid rules, keeps unknown levels as Ask, and merges duplicates", () => {
    const problems: string[] = [];
    const rules = normalizeForgeAgentToolRules([
      { repository: "github.com/PwrDrvr/PwrAgent", agent: { backend: "claude" }, access: { pull_requests: "allow" } },
      { agent: { backend: "claude" }, access: { pull_requests: "allow" } },
      { repository: REPO, agent: { backend: "gemini" }, access: { pull_requests: "allow" } },
      { repository: REPO, agent: { backend: "*", model: "x" }, access: { pull_requests: "allow" } },
      { repository: REPO, agent: { backend: "claude", codexModelProvider: "llamacpp" }, access: {} },
      { repository: REPO, agent: { backend: "codex" }, access: { comments: "never" } },
      { repository: REPO, agent: { backend: "claude" }, access: { pull_requests: "ask", issues: "allow" } },
      "not a table",
    ], (problem, index) => problems.push(`${index}: ${problem}`));
    expect(rules).toEqual([
      { repository: REPO, agent: { backend: "claude" }, access: { pull_requests: "ask", issues: "allow" } },
      { repository: REPO, agent: { backend: "codex" }, access: { comments: "ask" } },
    ]);
    expect(problems).toHaveLength(6);
    expect(problems[0]).toBe("1: missing repository");
  });

  it("merges entries that differ only in repository case, keeping the first's spelling", () => {
    expect(normalizeForgeAgentToolRules([
      { repository: "ghe.example.com/Acme/Widget", agent: { backend: "codex" }, access: { comments: "auto" } },
      { repository: "ghe.example.com/acme/widget", agent: { backend: "codex" }, access: { comments: "allow" } },
    ])).toEqual([
      { repository: "ghe.example.com/Acme/Widget", agent: { backend: "codex" }, access: { comments: "allow" } },
    ]);
  });

  it("reads the built-in agent names in any case", () => {
    expect(validateForgeAgentRuleAgent({ backend: "Claude" })).toEqual({ ok: true, agent: { backend: "claude" } });
    expect(validateForgeAgentRuleAgent({ backend: " CODEX ", codexModelProvider: "llamacpp" }))
      .toEqual({ ok: true, agent: { backend: "codex", codexModelProvider: "llamacpp" } });
    expect(validateForgeAgentRuleAgent({ backend: "ACP:Grok" })).toEqual({ ok: true, agent: { backend: "acp:Grok" } });
  });
});

describe("forgeRuleProjectLabel", () => {
  it("names the registered project that clones the repository", () => {
    const rows = [
      { kind: "worktree", label: "PwrAgnt (worktree)", repositoryKey: "github.com/pwrdrvr/pwragent" },
      { kind: "directory", label: "PwrAgnt", repositoryKey: "github.com/PwrDrvr/PwrAgent" },
      { kind: "directory", label: "Other" },
    ];
    expect(forgeRuleProjectLabel(rows, REPO)).toBe("PwrAgnt");
    expect(forgeRuleProjectLabel(rows.slice(0, 1), REPO)).toBe("PwrAgnt (worktree)");
    expect(forgeRuleProjectLabel(rows, "github.com/other/repo")).toBeUndefined();
  });
});

describe("upsertForgeAgentToolRule", () => {
  it("adds, updates, and clears one group without touching the input", () => {
    const initial: ForgeAgentToolRule[] = [
      { repository: REPO, agent: { backend: "*" }, access: { comments: "allow" } },
    ];
    const added = upsertForgeAgentToolRule(initial, {
      repository: "github.com/PwrDrvr/PwrAgent",
      agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
      group: "pull_requests",
      level: "allow",
    });
    expect(initial).toHaveLength(1);
    expect(added[1]).toEqual({
      repository: REPO,
      agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
      access: { pull_requests: "allow" },
    });
    const updated = upsertForgeAgentToolRule(added, {
      repository: REPO,
      agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
      group: "ci",
      level: "ask",
    });
    expect(updated).toHaveLength(2);
    expect(updated[1].access).toEqual({ pull_requests: "allow", ci: "ask" });
    const cleared = upsertForgeAgentToolRule(updated, {
      repository: REPO,
      agent: { backend: "*" },
      group: "comments",
      level: undefined,
    });
    expect(cleared[0].access).toEqual({});
    expect(removeForgeAgentToolRule(cleared, REPO, { backend: "*" })).toHaveLength(1);
  });

  it("updates the stored rule for a repository spelled in another case", () => {
    // A GitHub Enterprise host is not recognized as GitHub without the call's
    // provider, so Settings stores its owner and repo as written.
    const stored: ForgeAgentToolRule[] = [
      { repository: "ghe.example.com/Acme/Widget", agent: { backend: "codex" }, access: { comments: "auto" } },
    ];
    const updated = upsertForgeAgentToolRule(stored, {
      repository: "ghe.example.com/acme/widget",
      agent: { backend: "codex" },
      group: "comments",
      level: "allow",
    });
    expect(updated).toEqual([
      { repository: "ghe.example.com/Acme/Widget", agent: { backend: "codex" }, access: { comments: "allow" } },
    ]);
    expect(resolveForgeAgentToolAccess(
      policy(updated),
      "comments",
      { provider: "github", host: "ghe.example.com", owner: "Acme", repo: "Widget" },
      CODEX_OPENAI,
    ).level).toBe("allow");
    expect(removeForgeAgentToolRule(updated, "ghe.example.com/ACME/widget", { backend: "codex" })).toEqual([]);
  });

  it("rejects an invalid agent", () => {
    expect(() => upsertForgeAgentToolRule([], {
      repository: REPO,
      agent: { backend: "*", model: "x" },
      group: "pull_requests",
      level: "allow",
    })).toThrow(/agent/);
  });
});

describe("rule wording", () => {
  it("labels agents and describes rules", () => {
    expect(forgeAgentRuleAgentLabel({ backend: "*" })).toBe("All agents");
    expect(forgeAgentRuleAgentLabel({ backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" }))
      .toBe("Codex · llamacpp · qwen3-abliterated");
    expect(forgeAgentRuleAgentLabel({ backend: "acp:grok" }, { acpAgent: () => "Grok" })).toBe("Grok");
    expect(forgeAgentToolRuleSentence(
      { repository: "github.com/pwrdrvr/pwragent", agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" } },
      "pull_requests",
      "ask",
      { projectLabel: "pwrdrvr/PwrAgent" },
    )).toBe("The pwrdrvr/PwrAgent rule for Codex · llamacpp · qwen3-abliterated asks before opening or updating pull requests.");
    expect(forgeAgentToolRuleOffMessage({ repository: REPO, agent: { backend: "*" } }, "ci"))
      .toContain("Settings → Git → Agent forge tools");
  });
});

describe("approval card remember options", () => {
  const defaultAsk = { level: "ask" as const, source: "default" as const };

  it("offers agent and model options for a default-level card", () => {
    const options = buildForgeApprovalRememberOptions({
      group: "pull_requests",
      repository: REPO,
      identity: CODEX_LOCAL,
      resolution: defaultAsk,
      automation: false,
      projectLabel: "PwrAgent",
    });
    expect(options.map((option) => option.id)).toEqual(["agent", "agent_model"]);
    expect(options[0].label).toBe("Always allow Codex · llamacpp in PwrAgent");
    expect(options[1].label).toBe("Always allow qwen3-abliterated in PwrAgent");
  });

  it("offers only the agent option when the model is unknown", () => {
    expect(buildForgeApprovalRememberOptions({
      group: "ci",
      repository: REPO,
      identity: { backend: "claude" },
      resolution: defaultAsk,
      automation: false,
    }).map((option) => option.id)).toEqual(["agent"]);
  });

  it.each([
    ["approve and merge", { group: "approve_merge" as const }],
    ["an automation", { automation: true }],
    ["a rule set to Ask", {
      resolution: {
        level: "ask" as const,
        source: "project_rule" as const,
        rule: PRECEDENCE_RULES[0],
        specificity: 1 as const,
      },
    }],
    ["an unknown backend", { identity: { backend: "gemini" } }],
  ])("offers nothing for %s", (_name, override) => {
    expect(buildForgeApprovalRememberOptions({
      group: "pull_requests",
      repository: REPO,
      identity: CLAUDE,
      resolution: defaultAsk,
      automation: false,
      ...override,
    })).toEqual([]);
  });

  it("drops the agent option when a model rule already decides the group", () => {
    expect(buildForgeApprovalRememberOptions({
      group: "pull_requests",
      repository: REPO,
      identity: CLAUDE,
      resolution: { level: "auto", source: "project_rule", rule: PRECEDENCE_RULES[5], specificity: 3 },
      automation: false,
    }).map((option) => option.id)).toEqual(["agent_model"]);
  });

  it("maps a chosen option to the rule agent it writes", () => {
    expect(forgeApprovalRememberRuleAgent("agent", CODEX_LOCAL))
      .toEqual({ backend: "codex", codexModelProvider: "llamacpp" });
    expect(forgeApprovalRememberRuleAgent("agent_model", { backend: "codex", codexModelProvider: "llamacpp", model: "@llamacpp/qwen" }))
      .toEqual({ backend: "codex", codexModelProvider: "llamacpp", model: "qwen" });
    expect(forgeApprovalRememberRuleAgent("agent_model", { backend: "claude" })).toBeUndefined();
    const written = upsertForgeAgentToolRule([], {
      repository: REPO,
      agent: forgeApprovalRememberRuleAgent("agent", CODEX_LOCAL)!,
      group: "pull_requests",
      level: "allow",
    });
    expect(forgeAgentRuleMatches(written[0].agent, CODEX_LOCAL)).toBe(true);
    expect(forgeAgentRuleMatches(written[0].agent, CODEX_OPENAI)).toBe(false);
  });

  it("reads offered options and the chosen id from _meta", () => {
    const options = buildForgeApprovalRememberOptions({
      group: "issues",
      repository: REPO,
      identity: CLAUDE,
      resolution: defaultAsk,
      automation: false,
    });
    expect(readForgeApprovalRememberOptions({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: options })).toEqual(options);
    expect(readForgeApprovalRememberOptions({ [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: [{ id: "bogus", label: "x" }] }))
      .toEqual([]);
    expect(readForgeApprovalRememberOptions(null)).toEqual([]);
    expect(readForgeApprovalRememberChoice({ [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent_model" })).toBe("agent_model");
    expect(readForgeApprovalRememberChoice({ [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "everything" })).toBeUndefined();
  });
});
