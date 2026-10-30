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
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";
import type { ForgePrToolHandler } from "../agent-tools/pwragent-forge-pr-agent-tools";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import { ForgeReadError } from "../pr-status/forge-tool-contract";

type DynamicResult = { success: boolean; contentItems: Array<{ type: string; text?: string }> };

describe("backend forge tool dispatch", () => {
  let directory: string;
  let db: StateDb;
  let overlayStore: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let policy: ForgeAgentToolPolicy;
  let forgeRead: ReturnType<typeof vi.fn<ForgeReadHandler>>;
  let github: ReturnType<typeof vi.fn<ForgePrToolHandler>>;
  let attach: ReturnType<typeof vi.fn<(args: unknown) => Promise<unknown>>>;
  let realAttach: (args: unknown) => Promise<unknown>;
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
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = createTempStateDb("pwragent-forge-dispatch-");
    directory = fixture.tempDir;
    db = StateDb.open(fixture.dbPath);
    overlayStore = new SqliteOverlayStore(db);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [{ id: "thread-1", title: "Fixture work", titleSource: "explicit", source: "codex", linkedDirectories: [] }],
        onNotification: () => () => {}, onPendingRequest: () => () => {}, readConfiguredMcpServerNames: async () => [],
      } as never,
      overlayStore, isBootstrapMode: () => false,
    });
    internals = registry as unknown as typeof internals;
    internals.activeTurnKeys.add("codex:thread-1:turn-1");
    internals.activeCodexTurnModes.set("thread-1:turn-1", "default");
    policy = structuredClone(DEFAULT_FORGE_AGENT_TOOL_POLICY);
    forgeRead = vi.fn<ForgeReadHandler>(async () => ({ source: "cache", observations: [] }));
    github = vi.fn<ForgePrToolHandler>(async (operation) => operation === "create_pull_request"
      ? { created: true, url: "https://github.com/fixture/project/pull/9" }
      : { ok: true });
    attach = vi.fn<(args: unknown) => Promise<unknown>>(async () => ({ ok: true }));
    realAttach = internals.handleAttachThreadPullRequestInspectionRequest.bind(registry);
    internals.handleAttachThreadPullRequestInspectionRequest = attach;
    registry.setForgeReadHandlers(forgeRead, forgeRead);
    registry.setForgePrToolHandler(github);
    registry.setForgeToolPolicyResolver(() => policy);
  });

  afterEach(async () => {
    await registry.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
    expect(text(result)).toMatch(/"attachedToThread":\s*true/);
    expect(attach).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", url: "https://github.com/fixture/project/pull/9" });
  });

  it("shows the whole body and every inline comment on the approval card", async () => {
    const body = `## Summary\n\n${"Moves every macOS job onto the hosted runner. ".repeat(20)}\n\n<!-- end -->`;
    const pr = nextApproval();
    const opening = internals.handleServerRequest("codex", request("create_pull_request", { title: "ci: hosted runners", body }, "call-pr-body"));
    const prNotification = await pr;
    expect(prNotification.params._meta).toMatchObject({ tool_params_display: [{ name: "title", value: "ci: hosted runners" }, { name: "body", value: body, format: "markdown" }] });
    await answer(prNotification, "decline");
    await opening;

    const review = nextApproval();
    const reviewing = internals.handleServerRequest("codex", request("submit_pull_request_review", {
      number: 9,
      event: "COMMENT",
      body: "Two notes.",
      comments: [
        { path: "src/auth/password-reset.ts", line: 41, body: "Rename **this**." },
        { path: "scripts/sign.mjs", startLine: 88, line: 96, body: "Keep the unlock." },
      ],
    }, "call-review-comments"));
    const reviewNotification = await review;
    expect((reviewNotification.params._meta as { tool_params_display: unknown[] }).tool_params_display).toEqual(expect.arrayContaining([
      { name: "body", value: "Two notes.", format: "markdown" },
      { name: "comment", location: "src/auth/password-reset.ts:41", value: "Rename **this**.", format: "markdown" },
      { name: "comment", location: "scripts/sign.mjs:88–96", value: "Keep the unlock.", format: "markdown" },
    ]));
    await answer(reviewNotification, "decline");
    await reviewing;
    expect(github).not.toHaveBeenCalled();
  });

  it("budgets creating a pull request and attaching it through the real SQLite store", async () => {
    policy.access.pull_requests = "allow";
    internals.handleAttachThreadPullRequestInspectionRequest = realAttach;

    const { result, writes } = await measureSqliteWrites(() => internals.handleServerRequest(
      "codex", request("create_pull_request", { title: "fix: tests", draft: true }, "call-pr-budget"),
    ));

    expect(result.success).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ created: true, attachedToThread: true });
    expect(github).toHaveBeenCalledExactlyOnceWith(
      "create_pull_request", { title: "fix: tests", draft: true },
      expect.objectContaining({ backend: "codex", threadId: "thread-1", turnId: "turn-1" }),
    );
    const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
    expect(overlay?.prs).toEqual([expect.objectContaining({
      provider: "github.com", org: "fixture", repo: "project", number: 9,
      url: "https://github.com/fixture/project/pull/9", explicitlyAttached: true,
    })]);
    expect(attach).not.toHaveBeenCalled();
    expectSqliteWriteBudget({
      scenario: "forge-create-pull-request-attach",
      writes,
      note: "One allowed create_pull_request through registry dispatch and real SQLite attachment: 1 commit/16,480 bytes WAL; 20 PR creations/day = 0.3296 MB/day. Provider creation is stubbed; setup and overlay verification are excluded.",
    });
  });

  it("names the GitLab repository and merge request on the card", async () => {
    registry.setForgePrToolHandler(github, async () => ({ provider: "gitlab", host: "gitlab.example.test", owner: "group/sub", repo: "project" }));
    const prompt = nextApproval();
    const pending = internals.handleServerRequest("codex", request("merge_pull_request", { number: 4, expectedHeadSha: "b".repeat(40) }, "call-gitlab"));
    const notification = await prompt;
    expect(notification.params).toMatchObject({ serverName: "GitLab", message: "Allow the agent to merge merge request !4 on GitLab?" });
    expect(notification.params._meta).toMatchObject({ connector_name: "group/sub/project" });
    await answer(notification, "decline");
    expect(text(await pending)).toContain("declined");
  });

  it("runs a write in the approved repository and scopes conversation grants to it", async () => {
    const repoA = { provider: "github" as const, host: "github.com", owner: "acme", repo: "app" };
    const repoB = { provider: "github" as const, host: "github.com", owner: "acme", repo: "site" };
    let next = repoA;
    registry.setForgePrToolHandler(github, async () => next);
    const first = nextApproval();
    const pendingA = internals.handleServerRequest("codex", request("add_issue_comment", { number: 1, body: "Fixed." }, "call-grant-a"));
    await answer(await first, "accept", "session");
    expect((await pendingA).success).toBe(true);
    expect(github).toHaveBeenLastCalledWith("add_issue_comment", { number: 1, body: "Fixed.", repository: repoA }, expect.anything());
    expect((await internals.handleServerRequest("codex", request("add_issue_comment", { number: 2, body: "Again." }, "call-grant-a2"))).success).toBe(true);
    next = repoB;
    const second = nextApproval();
    const pendingB = internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Elsewhere." }, "call-grant-b"));
    const notification = await second;
    expect(notification.params._meta).toMatchObject({ connector_name: "acme/site" });
    await answer(notification, "decline");
    expect(text(await pendingB)).toContain("declined");
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("fails a write with no single target before asking", async () => {
    const prompts = vi.fn();
    registry.onEvent((event) => { if (event.notification.method === "mcpServer/elicitation/request") prompts(); });
    registry.setForgePrToolHandler(github, async () => { throw new ForgeReadError("ambiguous_repository", "Select repository from: github:github.com/a/b, gitlab:gitlab.com/a/b."); });
    const result = await internals.handleServerRequest("codex", request("create_issue", { title: "Bug" }, "call-ambiguous"));
    expect(text(result)).toContain("ambiguous_repository");
    expect(prompts).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
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

  it("runs Auto writes without asking in a Codex Auto turn, except approve and merge", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    const prompts = vi.fn();
    registry.onEvent((event) => { if (event.notification.method === "mcpServer/elicitation/request") prompts(); });
    const created = await internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests", draft: true }, "call-auto-pr"));
    expect(created.success).toBe(true);
    const comment = await internals.handleServerRequest("codex", request("add_issue_comment", { number: 3, body: "Fixed." }, "call-auto-comment"));
    expect(comment.success).toBe(true);
    expect(prompts).not.toHaveBeenCalled();
    expect(github).toHaveBeenCalledTimes(2);

    policy.access.approve_merge = "auto";
    const mergePrompt = nextApproval();
    const merge = internals.handleServerRequest("codex", request("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) }, "call-auto-merge"));
    await answer(await mergePrompt, "decline");
    expect(text(await merge)).toContain("declined");

    policy.access.pull_requests = "ask";
    const askPrompt = nextApproval();
    const asked = internals.handleServerRequest("codex", request("update_pull_request", { number: 9, title: "New title" }, "call-auto-ask"));
    await answer(await askPrompt, "accept");
    expect((await asked).success).toBe(true);
    expect(github).toHaveBeenCalledTimes(3);
  });

  it("refuses Auto writes from an Auto-mode automation, which no one can review", async () => {
    internals.activeCodexTurnModes.set("thread-1:turn-1", "auto");
    (registry as unknown as { headlessAutomationTurns: Map<string, unknown> }).headlessAutomationTurns.set("codex:thread-1:turn-1", {
      agentThreadId: "thread-1", automationRunId: "run-1", executionMode: "auto", queueEntryId: "queue-1",
    });
    const result = await internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests", draft: true }, "call-automation-pr"));
    expect(text(result)).toContain("approval_required");
    expect(github).not.toHaveBeenCalled();
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

  describe("an approval still open when the turn ends", () => {
    let addTodo: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      addTodo = vi.fn(async (_context: unknown, input: { title: string }) => ({ todo: { id: "todo-1", ...input }, created: true }));
      registry.setPwrAgentThreadTodoHandler({ add: addTodo, update: vi.fn(), list: vi.fn(() => []), resolve: vi.fn() } as never);
    });
    const endTurn = async (status: "completed" | "interrupted") => await registry.publishLocalEvent({
      backend: "codex",
      notification: { method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status, output: [] } } },
    });

    it("leaves the operator a to-do saying the request was withdrawn", async () => {
      const prompt = nextApproval();
      const pending = internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests" }, "call-pr-ended"));
      await prompt;
      await endTurn("completed");
      await pending;
      expect(github).not.toHaveBeenCalled();
      expect(registry.getPendingRequestForThread({ backend: "codex", threadId: "thread-1" })).toBeUndefined();
      await vi.waitFor(() => expect(addTodo).toHaveBeenCalledTimes(1));
      const [context, input] = addTodo.mock.calls[0]!;
      expect(context).toEqual({ backend: "codex", threadId: "thread-1" });
      expect(input).toMatchObject({ key: "forge-approval-withdrawn", title: "Reply to retry the withdrawn GitHub request" });
      expect(input.detail).toContain("Allow the agent to open a pull request on GitHub?");
      expect(input.detail).toContain("nothing ran");
      expect(input).not.toHaveProperty("action");
    });

    it("leaves the to-do when the turn fails while the card waits", async () => {
      const prompt = nextApproval();
      const pending = internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests" }, "call-pr-failed"));
      await prompt;
      await registry.publishLocalEvent({
        backend: "codex",
        notification: { method: "turn/failed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "failed", error: { message: "Connection lost" } } } },
      });
      await pending;
      await vi.waitFor(() => expect(addTodo).toHaveBeenCalledTimes(1));
    });

    it("leaves no to-do when the operator stopped the turn", async () => {
      const prompt = nextApproval();
      const pending = internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests" }, "call-pr-stopped"));
      await prompt;
      await endTurn("interrupted");
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(addTodo).not.toHaveBeenCalled();
    });

    it("tells the agent in get_thread_status that its call waits on the operator", async () => {
      const prompt = nextApproval();
      const pending = internals.handleServerRequest("codex", request("create_pull_request", { title: "fix: tests" }, "call-pr-status"));
      await prompt;
      const status = JSON.parse(text(await internals.handleServerRequest("codex", request("get_thread_status", {}, "call-status")))) as {
        thread: { pendingApprovals?: Array<{ serverName?: string; message?: string }>; pendingApprovalGuidance?: string };
      };
      expect(status.thread.pendingApprovals).toEqual([
        { method: "mcpServer/elicitation/request", serverName: "GitHub", message: "Allow the agent to open a pull request on GitHub?" },
      ]);
      expect(status.thread.pendingApprovalGuidance).toContain("withdrawn");
      await endTurn("interrupted");
      await pending;
    });
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
