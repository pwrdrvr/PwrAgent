import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  type AppServerMcpElicitationRequestNotification,
  type AppServerPendingRequestNotification,
  type ForgeAgentToolPolicy,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import type { GithubToolHandler } from "../agent-tools/pwragent-github-agent-tools";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";

type DynamicResult = { success: boolean; contentItems: Array<{ type: string; text?: string }> };

describe("backend forge tool dispatch", () => {
  let directory: string;
  let db: StateDb;
  let registry: DesktopBackendRegistry;
  let policy: ForgeAgentToolPolicy;
  let forgeRead: ReturnType<typeof vi.fn<ForgeReadHandler>>;
  let github: ReturnType<typeof vi.fn<GithubToolHandler>>;
  let attach: ReturnType<typeof vi.fn<(args: unknown) => Promise<unknown>>>;
  let internals: {
    activeTurnKeys: Set<string>;
    activeCodexTurnModes: Map<string, ThreadExecutionMode>;
    handleServerRequest(backend: "codex", request: AppServerPendingRequestNotification): Promise<DynamicResult>;
    handleAttachThreadPullRequestInspectionRequest: (args: unknown) => Promise<unknown>;
  };
  const request = (tool: string, args: Record<string, unknown>, callId: string): AppServerPendingRequestNotification => ({
    method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", requestId: callId, callId, namespace: "pwragent", tool, arguments: args },
  });
  const text = (result: DynamicResult) => result.contentItems.map((item) => item.text ?? "").join("");

  beforeEach(() => {
    const fixture = createTempStateDb("pwragent-forge-dispatch-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }), listThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {}, readConfiguredMcpServerNames: async () => [],
      } as never,
      overlayStore: new SqliteOverlayStore(db), isBootstrapMode: () => false,
    });
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    internals.activeCodexTurnModes.set("thread-1:turn-1", "default");
    policy = structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY);
    forgeRead = vi.fn<ForgeReadHandler>(async () => ({ source: "cache", observations: [] }));
    github = vi.fn<GithubToolHandler>(async (operation) => operation === "create_pull_request"
      ? { created: true, url: "https://github.com/fixture/project/pull/9" }
      : { ok: true });
    attach = vi.fn<(args: unknown) => Promise<unknown>>(async () => ({ ok: true }));
    internals.handleAttachThreadPullRequestInspectionRequest = attach;
    registry.setForgeReadHandlers(forgeRead, forgeRead);
    registry.setGithubToolHandler(github);
    registry.setForgeToolPolicyResolver(() => policy);
  });

  afterEach(async () => {
    await registry.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function nextApproval() {
    return new Promise<AppServerMcpElicitationRequestNotification>((resolve) => {
      registry.onEvent((event) => {
        if (event.notification.method === "mcpServer/elicitation/request") resolve(event.notification as AppServerMcpElicitationRequestNotification);
      });
    });
  }
  async function answer(notification: AppServerMcpElicitationRequestNotification, action: "accept" | "decline", persist?: "session") {
    await registry.submitServerRequest({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", requestId: String(notification.params.requestId),
      response: { action, content: action === "accept" ? {} : null, _meta: persist ? { persist } : null },
    });
  }

  it("routes Codex calls to the forge read tools instead of failing with no handler", async () => {
    const result = await internals.handleServerRequest("codex", request("get_forge_status", {}, "call-read"));
    expect(text(result)).not.toContain("No PwrAgent handler");
    expect(result.success).toBe(true);
    expect(forgeRead).toHaveBeenCalledWith("get_forge_status", {}, expect.objectContaining({ threadId: "thread-1", turnId: "turn-1" }));
  });

  it("refuses every forge tool, including a stale schema, while the family is off", async () => {
    policy.enabled = false;
    const read = await internals.handleServerRequest("codex", request("list_ci_runs", {}, "call-off-read"));
    const write = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-off-write"));
    expect(text(read)).toContain("tools_disabled");
    expect(text(write)).toContain("Settings → Git");
    expect(forgeRead).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
  });

  it("refuses a group set to Off and runs one set to Allow without asking", async () => {
    policy.access.issues = "off";
    policy.access.comments = "allow";
    const prompts = vi.fn();
    registry.onEvent((event) => { if (event.notification.method === "mcpServer/elicitation/request") prompts(); });
    const off = await internals.handleServerRequest("codex", request("create_issue", { title: "Flaky test" }, "call-issue"));
    expect(text(off)).toContain("Issues is Off");
    const allowed = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-comment"));
    expect(allowed.success).toBe(true);
    expect(github).toHaveBeenCalledTimes(1);
    expect(prompts).not.toHaveBeenCalled();
  });

  it("asks before opening a pull request, then links it to the thread", async () => {
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests", draft: true }, "call-pr"));
    const notification = await prompt;
    expect(notification.params.message).toBe("Allow the agent to open a pull request on GitHub?");
    expect(notification.params._meta).toMatchObject({ pwragent_approval_kind: "mcp_tool_call", tool_params_display: [{ name: "title", value: "fix: tests" }, { name: "draft", value: "true" }] });
    expect(notification.params._meta).not.toHaveProperty("persist");
    expect(github).not.toHaveBeenCalled();
    await answer(notification, "accept");
    const result = await pending;
    expect(result.success).toBe(true);
    expect(text(result)).toContain('"attachedToThread":true');
    expect(attach).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", url: "https://github.com/fixture/project/pull/9" });
  });

  it("does not run a declined write", async () => {
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "New title" }, "call-decline"));
    await answer(await prompt, "decline");
    const result = await pending;
    expect(text(result)).toContain("declined");
    expect(github).not.toHaveBeenCalled();
  });

  it("runs Auto writes without asking in a Full Access turn, but still asks for Ask", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "full-access");
    const auto = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-full"));
    expect(auto.success).toBe(true);
    const prompt = nextApproval();
    const merge = internals.handleServerRequest("codex", request("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) }, "call-merge"));
    const notification = await prompt;
    expect(notification.params._meta).toMatchObject({ riskLevel: "high" });
    await answer(notification, "accept");
    expect((await merge).success).toBe(true);
  });

  it("treats an approving review as an approve-and-merge decision", async () => {
    policy.access.comments = "allow";
    policy.access.approve_merge = "off";
    const comment = await internals.handleServerRequest("codex", request("submit_pull_request_review", { number: 9, event: "COMMENT", body: "Looks close." }, "call-review-comment"));
    expect(comment.success).toBe(true);
    const approve = await internals.handleServerRequest("codex", request("submit_pull_request_review", { number: 9, event: "APPROVE" }, "call-review-approve"));
    expect(text(approve)).toContain("Approve and merge is Off");
  });

  it("remembers a conversation grant for comments until the setting changes", async () => {
    const first = nextApproval();
    const pending = internals.handleServerRequest("codex", request("reply_to_review_comment", { number: 9, commentId: 4, body: "Fixed." }, "call-reply-1"));
    const notification = await first;
    expect(notification.params._meta).toMatchObject({ persist: ["session"] });
    await answer(notification, "accept", "session");
    expect((await pending).success).toBe(true);
    expect((await internals.handleServerRequest("codex", request("reply_to_review_comment", { number: 9, commentId: 5, body: "Done." }, "call-reply-2"))).success).toBe(true);
    expect(github).toHaveBeenCalledTimes(2);
    policy.access.comments = "ask";
    const again = nextApproval();
    const third = internals.handleServerRequest("codex", request("reply_to_review_comment", { number: 9, commentId: 6, body: "Also done." }, "call-reply-3"));
    await answer(await again, "accept");
    expect((await third).success).toBe(true);
  });

  it("hides tools the policy turned off from new turns", () => {
    policy.access.read = "off";
    policy.access.approve_merge = "off";
    const internalsWithCatalog = registry as unknown as { buildCodexParentDynamicTools(tokenMiser: boolean, discovery?: boolean): Array<{ name: string; tools?: Array<{ name: string }> }> };
    const names = internalsWithCatalog.buildCodexParentDynamicTools(false, false).flatMap((tool) => tool.tools?.map((nested) => nested.name) ?? [tool.name]);
    expect(names).toContain("create_pull_request");
    expect(names).toContain("submit_pull_request_review");
    expect(names).not.toContain("get_forge_status");
    expect(names).not.toContain("get_pull_request");
    expect(names).not.toContain("merge_pull_request");
  });
});
