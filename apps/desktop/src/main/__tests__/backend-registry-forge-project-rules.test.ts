import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY,
  FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY,
  type AppServerMcpElicitationRequestNotification,
  type AppServerPendingRequestNotification,
  type ForgeAgentToolPolicy,
  type ForgeAgentToolRule,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import { DesktopBackendRegistry, type ForgeToolRuleWriter } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import type { ForgePrToolHandler } from "../agent-tools/pwragent-forge-pr-agent-tools";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";

type DynamicResult = { success: boolean; contentItems: Array<{ type: string; text?: string }> };

describe("forge project rules at the write gate", () => {
  const repository = { provider: "github" as const, host: "github.com", owner: "Fixture", repo: "Project" };
  const ruleRepository = "github.com/fixture/project";
  let directory: string;
  let db: StateDb;
  let overlayStore: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let policy: ForgeAgentToolPolicy;
  let github: ReturnType<typeof vi.fn<ForgePrToolHandler>>;
  let writeRule: ReturnType<typeof vi.fn<ForgeToolRuleWriter>>;
  let codexProvider: string | undefined;
  let internals: {
    activeTurnKeys: Set<string>;
    activeCodexTurnModes: Map<string, ThreadExecutionMode>;
    headlessAutomationTurns: Map<string, unknown>;
    handleServerRequest(backend: "codex", request: AppServerPendingRequestNotification): Promise<DynamicResult>;
    handleAttachThreadPullRequestInspectionRequest: (args: unknown) => Promise<unknown>;
  };
  const request = (tool: string, args: Record<string, unknown>, callId: string): AppServerPendingRequestNotification => ({
    method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", requestId: callId, callId, namespace: "pwragent", tool, arguments: args },
  });
  const text = (result: DynamicResult) => result.contentItems.map((item) => item.text ?? "").join("");
  const rule = (agent: ForgeAgentToolRule["agent"], access: ForgeAgentToolRule["access"]): ForgeAgentToolRule => ({
    repository: ruleRepository, agent, access,
  });

  beforeEach(() => {
    const fixture = createTempStateDb("pwragent-forge-rules-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    overlayStore = new SqliteOverlayStore(db);
    codexProvider = undefined;
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [{ id: "thread-1", title: "Fixture work", titleSource: "explicit", source: "codex", linkedDirectories: [] }],
        onNotification: () => () => {}, onPendingRequest: () => () => {}, readConfiguredMcpServerNames: async () => [],
        modelProviderForThread: () => codexProvider,
      } as never,
      overlayStore, isBootstrapMode: () => false,
    });
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    internals.activeCodexTurnModes.set("thread-1:turn-1", "default");
    internals.handleAttachThreadPullRequestInspectionRequest = async () => ({ ok: true });
    policy = structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY);
    github = vi.fn<ForgePrToolHandler>(async () => ({ ok: true }));
    writeRule = vi.fn<ForgeToolRuleWriter>(async () => []);
    const forgeRead = vi.fn<ForgeReadHandler>(async () => ({ source: "cache", observations: [] }));
    registry.setForgeReadHandlers(forgeRead, forgeRead);
    registry.setForgePrToolHandler(github, async (_operation, args) => ({ repository, args }));
    registry.setForgeToolPolicyResolver(() => policy);
    registry.setForgeToolRuleWriter(writeRule);
  });

  afterEach(async () => {
    await registry.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function watchApprovals() {
    const seen: AppServerMcpElicitationRequestNotification[] = [];
    registry.onEvent((event) => {
      if (event.notification.method === "mcpServer/elicitation/request") seen.push(event.notification as AppServerMcpElicitationRequestNotification);
    });
    return seen;
  }
  function nextApproval() {
    return new Promise<AppServerMcpElicitationRequestNotification>((resolve) => {
      registry.onEvent((event) => {
        if (event.notification.method === "mcpServer/elicitation/request") resolve(event.notification as AppServerMcpElicitationRequestNotification);
      });
    });
  }
  async function answer(
    notification: AppServerMcpElicitationRequestNotification,
    action: "accept" | "decline",
    meta?: Record<string, unknown>,
  ) {
    await registry.submitServerRequest({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(notification.params.requestId),
      response: { action, content: action === "accept" ? {} : null, _meta: meta ?? null },
    });
  }
  const rememberOptions = (notification: AppServerMcpElicitationRequestNotification) =>
    (notification.params._meta?.[FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY] ?? []) as Array<{ id: string; label: string }>;

  it("runs a write a rule allows without a card and names the rule in the result", async () => {
    policy.rules = [rule({ backend: "codex" }, { comments: "allow" })];
    const prompts = watchApprovals();
    const result = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-rule-allow"));
    expect(result.success).toBe(true);
    expect(prompts).toHaveLength(0);
    expect(JSON.parse(text(result))).toEqual({
      ok: true,
      approval: { source: "project_rule", rule: "Fixture/Project rule for Codex" },
    });
    expect(github).toHaveBeenCalledWith("add_issue_comment", { number: 3, body: "Fixed.", repository }, expect.anything());
  });

  it("asks when a rule says Ask, even in an Auto turn, and offers no remember options", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    policy.rules = [rule({ backend: "codex" }, { pull_requests: "ask" })];
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "New title" }, "call-rule-ask"));
    const notification = await prompt;
    expect(notification.params._meta?.subtitle).toBe(
      "The Fixture/Project rule for Codex asks before opening or updating pull requests. This allows this call only.",
    );
    expect(notification.params._meta).not.toHaveProperty(FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY);
    expect(github).not.toHaveBeenCalled();
    await answer(notification, "accept");
    const result = await pending;
    expect(result.success).toBe(true);
    expect(JSON.parse(text(result))).not.toHaveProperty("approval");
  });

  it("refuses a write a rule turns off, naming the rule and the setting", async () => {
    policy.access.issues = "allow";
    policy.rules = [rule({ backend: "codex" }, { issues: "off" })];
    const result = await internals.handleServerRequest("codex", request("create_issue", { title: "Flaky test" }, "call-rule-off"));
    expect(text(result)).toContain("tools_disabled");
    expect(text(result)).toContain("The Fixture/Project rule for Codex turns off opening or updating issues.");
    expect(text(result)).toContain("Settings → Git → Agent forge tools");
    expect(github).not.toHaveBeenCalled();
  });

  it("cannot re-enable a group that is Off globally", async () => {
    policy.access.issues = "off";
    policy.rules = [rule({ backend: "codex" }, { issues: "allow" })];
    const result = await internals.handleServerRequest("codex", request("create_issue", { title: "Flaky test" }, "call-global-off"));
    expect(text(result)).toContain("Issues is Off");
    expect(github).not.toHaveBeenCalled();
  });

  it("does not apply a Codex rule to a thread on a custom model provider", async () => {
    policy.rules = [rule({ backend: "codex" }, { comments: "allow" })];
    codexProvider = "llamacpp";
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-custom-provider"));
    const notification = await prompt;
    expect(rememberOptions(notification).map((option) => option.label)).toEqual(["Always allow Codex · llamacpp in Fixture/Project"]);
    await answer(notification, "decline");
    expect(text(await pending)).toContain("declined");
    expect(github).not.toHaveBeenCalled();

    policy.rules = [rule({ backend: "codex", codexModelProvider: "llamacpp" }, { comments: "allow" })];
    const allowed = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-provider-rule"));
    expect(allowed.success).toBe(true);
    expect(JSON.parse(text(allowed))).toMatchObject({ approval: { rule: "Fixture/Project rule for Codex · llamacpp" } });
  });

  it("does not let a Codex rule cover a local model named only in the thread's model id", async () => {
    policy.rules = [rule({ backend: "codex" }, { comments: "allow" })];
    await overlayStore.setThreadModelSettings({ backend: "codex", threadId: "thread-1", model: "@llamacpp/qwen3-abliterated" });
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-qualified-model"));
    await answer(await prompt, "decline");
    expect(text(await pending)).toContain("declined");
    expect(github).not.toHaveBeenCalled();
  });

  it("applies a model rule only once the thread's model is known and equal", async () => {
    codexProvider = "llamacpp";
    policy.rules = [rule({ backend: "codex", codexModelProvider: "llamacpp", model: "qwen3-abliterated" }, { pull_requests: "allow" })];
    const prompt = nextApproval();
    const unknown = internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "A" }, "call-model-unknown"));
    const notification = await prompt;
    expect(rememberOptions(notification).map((option) => option.id)).toEqual(["agent"]);
    await answer(notification, "decline");
    expect(text(await unknown)).toContain("declined");

    await overlayStore.setThreadModelSettings({ backend: "codex", threadId: "thread-1", model: "@llamacpp/qwen3-other" });
    const other = nextApproval();
    const otherModel = internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "B" }, "call-model-other"));
    await answer(await other, "decline");
    expect(text(await otherModel)).toContain("declined");
    expect(github).not.toHaveBeenCalled();

    await overlayStore.setThreadModelSettings({ backend: "codex", threadId: "thread-1", model: "@llamacpp/qwen3-abliterated" });
    const allowed = await internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "C" }, "call-model-match"));
    expect(allowed.success).toBe(true);
    expect(JSON.parse(text(allowed))).toMatchObject({
      approval: { source: "project_rule", rule: "Fixture/Project rule for Codex · llamacpp · qwen3-abliterated" },
    });
  });

  it("saves the chosen remember option as a rule before running the call", async () => {
    await overlayStore.setThreadModelSettings({ backend: "codex", threadId: "thread-1", model: "gpt-5.5" });
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-remember"));
    const notification = await prompt;
    expect(rememberOptions(notification)).toEqual([
      expect.objectContaining({ id: "agent", label: "Always allow Codex in Fixture/Project" }),
      expect.objectContaining({ id: "agent_model", label: "Always allow gpt-5.5 in Fixture/Project" }),
    ]);
    await answer(notification, "accept", { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent_model" });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(writeRule).toHaveBeenCalledExactlyOnceWith({
      repository: ruleRepository,
      agent: { backend: "codex", model: "gpt-5.5" },
      group: "comments",
      level: "allow",
    });
    expect(writeRule.mock.invocationCallOrder[0]).toBeLessThan(github.mock.invocationCallOrder[0]!);
    expect(JSON.parse(text(result))).toMatchObject({
      rememberedRule: { rule: "Fixture/Project rule for Codex · gpt-5.5", saved: true },
    });
  });

  it("still runs the approved call once when the rule cannot be saved", async () => {
    writeRule.mockRejectedValueOnce(new Error("config.toml is read-only"));
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("rerun_failed_ci_jobs", { runId: 42 }, "call-remember-fails"));
    await answer(await prompt, "accept", { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent" });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(github).toHaveBeenCalledTimes(1);
    const remembered = (JSON.parse(text(result)) as { rememberedRule: { saved: boolean; error: string } }).rememberedRule;
    expect(remembered.saved).toBe(false);
    expect(remembered.error).toContain("config.toml is read-only");
  });

  it("writes no rule when the operator declines", async () => {
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-remember-decline"));
    await answer(await prompt, "decline", { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent" });
    expect(text(await pending)).toContain("declined");
    expect(writeRule).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  it("ignores a remember choice the card did not offer", async () => {
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) }, "call-merge-remember"));
    const notification = await prompt;
    expect(notification.params._meta).not.toHaveProperty(FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY);
    await answer(notification, "accept", { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent" });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(writeRule).not.toHaveBeenCalled();
    expect(JSON.parse(text(result))).not.toHaveProperty("rememberedRule");

    // The thread's model is unknown, so the model option was never offered.
    const second = nextApproval();
    const comment = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-model-remember"));
    const commentCard = await second;
    expect(rememberOptions(commentCard).map((option) => option.id)).toEqual(["agent"]);
    await answer(commentCard, "accept", { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent_model" });
    expect((await comment).success).toBe(true);
    expect(writeRule).not.toHaveBeenCalled();
  });

  it("ends a conversation grant when a rule changes what decides the group", async () => {
    policy.access.comments = "ask";
    const first = nextApproval();
    const granted = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "One." }, "call-grant-1"));
    await answer(await first, "accept", { persist: "session" });
    expect((await granted).success).toBe(true);
    expect((await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Two." }, "call-grant-2"))).success).toBe(true);
    expect(github).toHaveBeenCalledTimes(2);

    policy.rules = [rule({ backend: "codex" }, { comments: "ask" })];
    const again = nextApproval();
    const asked = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Three." }, "call-grant-3"));
    await answer(await again, "decline");
    expect(text(await asked)).toContain("declined");
    expect(github).toHaveBeenCalledTimes(2);
  });

  describe("in an automation", () => {
    beforeEach(() => {
      internals.headlessAutomationTurns.set("codex:thread-1:turn-1", {
        agentThreadId: "thread-1", automationRunId: "run-1", executionMode: "auto", queueEntryId: "queue-1",
      });
    });

    it("runs a write a rule allows", async () => {
      policy.rules = [rule({ backend: "codex" }, { pull_requests: "allow" })];
      const result = await internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "New title" }, "call-automation-allow"));
      expect(result.success).toBe(true);
      expect(github).toHaveBeenCalledTimes(1);
    });

    it("refuses a write a rule asks for, naming the rule", async () => {
      policy.rules = [rule({ backend: "codex" }, { pull_requests: "ask" })];
      const result = await internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "New title" }, "call-automation-ask"));
      expect(text(result)).toContain("approval_required");
      expect(text(result)).toContain("The Fixture/Project rule for Codex asks before opening or updating pull requests.");
      expect(github).not.toHaveBeenCalled();
    });
  });
});
