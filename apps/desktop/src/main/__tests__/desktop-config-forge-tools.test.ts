import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  resolveForgeAgentToolAccess,
  type ForgeAgentToolRule,
} from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

// `DesktopSettingsService` builds a real `CodexDiscoveryCoordinator` unless the
// test injects one; keep its probe off this machine's Codex installs.
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import(
    "./helpers/codex-discovery-stub"
  );
  return stubbedCodexDiscovery(
    await importOriginal<typeof import("@pwrdrvr/codex-discovery")>(),
  );
});

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createService(contents?: string): { service: DesktopSettingsService; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-forge-rules-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.toml");
  if (contents !== undefined) fs.writeFileSync(configPath, contents);
  return {
    service: new DesktopSettingsService({ configPath, env: {}, secretStore: new MemoryDesktopSecretStore() }),
    configPath,
  };
}

function writePatch(existing: string, rules: ForgeAgentToolRule[]): string {
  return applyTomlEdits(existing, desktopSettingsPatchToEdits(
    { git: { agentTools: { rules } } },
    parseTomlTables(existing, "test.toml"),
  ));
}

const RULES: ForgeAgentToolRule[] = [
  {
    repository: "github.com/pwrdrvr/pwragent",
    agent: { backend: "claude" },
    access: { pull_requests: "allow", comments: "allow" },
  },
  {
    repository: "github.com/pwrdrvr/pwragent",
    agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
    access: { pull_requests: "ask" },
  },
  {
    repository: "gitlab.com/Group/Sub/Repo",
    agent: { backend: "*" },
    access: { ci: "off" },
  },
];

describe("CI rerun policy config", () => {
  it("defaults to Auto for existing configs without rewriting them", () => {
    const parsed = parseDesktopSettingsToml("[git.agent_tools]\nread = \"allow\"\n", "test.toml");
    expect(parsed.git?.agentTools?.access?.ci).toBeUndefined();
    expect(DEFAULT_FORGE_AGENT_TOOL_POLICY.access.ci).toBe("auto");
  });

  it.each(["allow", "auto", "ask", "off"] as const)("round trips %s without changing other policies or comments", (ci) => {
    const existing = "# Operator policy\n[git.agent_tools]\nread = \"off\"\ncomments = \"ask\"\n";
    const written = applyTomlEdits(existing, desktopSettingsPatchToEdits(
      { git: { agentTools: { access: { ci } } } },
      parseTomlTables(existing, "test.toml"),
    ));
    expect(written).toContain("# Operator policy");
    expect(parseDesktopSettingsToml(written, "test.toml").git?.agentTools?.access).toEqual({ read: "off", comments: "ask", ci });
  });
});

describe("forge tool project rules config", () => {
  it("reads no rules from a config that predates them", () => {
    const parsed = parseDesktopSettingsToml("[git.agent_tools]\npull_requests = \"ask\"\n", "test.toml");
    expect(parsed.git?.agentTools?.rules).toBeUndefined();
  });

  it("round trips rules beside the global levels and comments", () => {
    const existing = "# Operator policy\n[git.agent_tools]\nenabled = true\npull_requests = \"ask\"\n";
    const written = writePatch(existing, RULES);
    expect(written).toContain("# Operator policy");
    expect(written).toContain("[[git.agent_tools.rules]]");
    expect(written).toContain("codex_model_provider = \"llamacpp\"");
    const parsed = parseDesktopSettingsToml(written, "test.toml");
    expect(parsed.git?.agentTools?.access).toEqual({ pull_requests: "ask" });
    expect(parsed.git?.agentTools?.enabled).toBe(true);
    expect(parsed.git?.agentTools?.rules).toEqual(RULES);

    const globalEdit = applyTomlEdits(written, desktopSettingsPatchToEdits(
      { git: { agentTools: { access: { issues: "off" } } } },
      parseTomlTables(written, "test.toml"),
    ));
    expect(parseDesktopSettingsToml(globalEdit, "test.toml").git?.agentTools).toEqual({
      enabled: true,
      access: { pull_requests: "ask", issues: "off" },
      rules: RULES,
    });
  });

  it("replaces the whole list and removes it when empty", () => {
    const written = writePatch("", RULES);
    const replaced = writePatch(written, [RULES[2]]);
    expect(parseDesktopSettingsToml(replaced, "test.toml").git?.agentTools?.rules).toEqual([RULES[2]]);
    const cleared = writePatch(replaced, []);
    expect(cleared).not.toContain("git.agent_tools.rules");
    expect(parseDesktopSettingsToml(cleared, "test.toml").git?.agentTools?.rules).toBeUndefined();
  });

  it("refuses to write an invalid rule", () => {
    expect(() => writePatch("", [
      { repository: "github.com/pwrdrvr/pwragent", agent: { backend: "*", model: "gpt-5.5" }, access: {} },
    ])).toThrow(/Invalid forge tool rule 1/);
    expect(() => writePatch("", [
      { repository: "not a repository", agent: { backend: "claude" }, access: {} },
    ])).toThrow(/Invalid forge tool rule 1/);
  });

  it("skips invalid entries with a warning and never widens access", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = parseDesktopSettingsToml([
      "[git.agent_tools]",
      "pull_requests = \"auto\"",
      "",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/pwrdrvr/pwragent\"",
      "agent = \"*\"",
      "pull_requests = \"allow\"",
      "",
      "# Meant to be off for Grok, but misspelled.",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/pwrdrvr/pwragent\"",
      "agent = \"acp:grok\"",
      "pull_requests = \"of\"",
      "read = \"off\"",
      "",
      "[[git.agent_tools.rules]]",
      "agent = \"claude\"",
      "pull_requests = \"allow\"",
      "",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/pwrdrvr/pwragent\"",
      "agent = \"gemini\"",
      "pull_requests = \"allow\"",
      "",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/pwrdrvr/pwragent\"",
      "agent = \"*\"",
      "model = \"gpt-5.5\"",
      "",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/pwrdrvr/pwragent\"",
      "agent = \"claude\"",
      "codex_model_provider = \"llamacpp\"",
      "",
      "[[git.agent_tools.rules]]",
      "repository = \"github.com/PwrDrvr/PwrAgent\"",
      "agent = \"*\"",
      "comments = \"ask\"",
      "",
    ].join("\n"), "test.toml");
    const rules = parsed.git?.agentTools?.rules ?? [];
    expect(rules).toEqual([
      {
        repository: "github.com/pwrdrvr/pwragent",
        agent: { backend: "*" },
        access: { pull_requests: "allow", comments: "ask" },
      },
      {
        repository: "github.com/pwrdrvr/pwragent",
        agent: { backend: "acp:grok" },
        access: { pull_requests: "ask" },
      },
    ]);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("entry 2") && message.includes("\"ask\""))).toBe(true);
    expect(messages.some((message) => message.includes("entry 2") && message.includes("ignoring read"))).toBe(true);
    expect(messages.some((message) => message.includes("entry 3: missing repository"))).toBe(true);
    expect(messages.some((message) => message.includes("entry 4: unknown agent"))).toBe(true);
    expect(messages.some((message) => message.includes("entry 5: the All agents rule"))).toBe(true);
    expect(messages.some((message) => message.includes("entry 6: codex_model_provider"))).toBe(true);

    // The misspelled Grok rule still asks rather than falling back to the
    // All agents Allow.
    const policy = {
      ...DEFAULT_FORGE_AGENT_TOOL_POLICY,
      rules,
    };
    expect(resolveForgeAgentToolAccess(
      policy,
      "pull_requests",
      { provider: "github", host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" },
      { backend: "acp:grok" },
    ).level).toBe("ask");
  });
});

describe("forge tool project rules in the settings service", () => {
  it("exposes rules in the policy and snapshot", async () => {
    const { service } = createService(writePatch("", RULES));
    expect(service.resolveForgeAgentToolPolicy().rules).toEqual(RULES);
    expect((await service.readSettingsProjection()).git.agentTools.rules).toEqual(RULES);
  });

  it("reports no rules by default", async () => {
    const { service } = createService();
    expect(service.resolveForgeAgentToolPolicy().rules).toEqual([]);
    expect((await service.readSettingsProjection()).git.agentTools.rules).toEqual([]);
  });

  it("replaces the list through a config patch", async () => {
    const { service } = createService(writePatch("", RULES));
    await service.writeConfigPatchTargeted({ git: { agentTools: { rules: [RULES[0]] } } });
    expect(service.resolveForgeAgentToolPolicy().rules).toEqual([RULES[0]]);
  });

  it("upserts one group and keeps both of two concurrent upserts", async () => {
    const { service, configPath } = createService("# keep me\n[git.agent_tools]\nci = \"ask\"\n");
    await Promise.all([
      service.upsertForgeAgentToolRule({
        repository: "github.com/PwrDrvr/PwrAgent",
        agent: { backend: "claude" },
        group: "pull_requests",
        level: "allow",
      }),
      service.upsertForgeAgentToolRule({
        repository: "github.com/pwrdrvr/pwragent",
        agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
        group: "ci",
        level: "allow",
      }),
    ]);
    const saved = await service.upsertForgeAgentToolRule({
      repository: "github.com/pwrdrvr/pwragent",
      agent: { backend: "claude" },
      group: "issues",
      level: "allow",
    });
    const expected: ForgeAgentToolRule[] = [
      {
        repository: "github.com/pwrdrvr/pwragent",
        agent: { backend: "claude" },
        access: { pull_requests: "allow", issues: "allow" },
      },
      {
        repository: "github.com/pwrdrvr/pwragent",
        agent: { backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" },
        access: { ci: "allow" },
      },
    ];
    expect(saved).toEqual(expected);
    expect(service.resolveForgeAgentToolPolicy().rules).toEqual(expected);
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("# keep me");
    expect(parseDesktopSettingsToml(contents, "test.toml").git?.agentTools?.access).toEqual({ ci: "ask" });
  });

  it("rejects an invalid upsert without writing", async () => {
    const { service } = createService();
    await expect(service.upsertForgeAgentToolRule({
      repository: "github.com/pwrdrvr/pwragent",
      agent: { backend: "*", model: "gpt-5.5" },
      group: "pull_requests",
      level: "allow",
    })).rejects.toThrow(/agent/);
    expect(service.resolveForgeAgentToolPolicy().rules).toEqual([]);
  });
});
