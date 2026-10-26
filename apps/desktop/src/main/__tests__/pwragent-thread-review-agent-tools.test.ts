import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PWRAGENT_THREAD_REVIEW_OPERATION_NAMES } from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { OPEN_FINDINGS_GUIDANCE, buildPwrAgentThreadReviewToolDefinitions, type PwrAgentThreadReviewHandler } from "../agent-tools/pwragent-thread-review-agent-tools";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const db = openInMemoryStateDb();
const service = new ThreadReviewService(db);
const handler: PwrAgentThreadReviewHandler = {
  record: (identity, input) => service.record(identity, input),
  list: (identity, status) => service.list({ ...identity, status }),
  update: (identity, request) => service.update(request, "agent", identity),
};
const context: AgentToolCallContext = { backend: "codex", threadId: "owner", transport: "codex_dynamic_tool" };
afterEach(() => db.raw.prepare("DELETE FROM thread_reviews").run());
afterAll(() => db.close());

describe("review tools", () => {
  it("advertises the same additive contracts in the unified dynamic/MCP catalog", () => {
    const definitions = buildPwrAgentThreadReviewToolDefinitions(handler);
    expect(definitions.map((entry) => entry.name)).toEqual([...PWRAGENT_THREAD_REVIEW_OPERATION_NAMES]);
    expect(definitions.every((entry) => entry.namespace === "pwragent" && entry.advertiseMcp !== false)).toBe(true);
    const catalog = resolveAgentToolCatalogs({}).find((entry) => entry.id === "thread_todos")!;
    const toolNames = catalog.dynamicTools.flatMap((entry) => entry.type === "namespace" ? entry.tools.map((tool) => tool.name) : []);
    expect(toolNames).toEqual(expect.arrayContaining([...PWRAGENT_THREAD_REVIEW_OPERATION_NAMES]));
  });

  it("records through dynamic tools and resolves through MCP with a documented outcome", async () => {
    const router = new AgentToolRouter(buildPwrAgentThreadReviewToolDefinitions(handler));
    const recorded = await router.handleDynamicToolCall({ backend: "codex", call: {
      namespace: "pwragent", tool: "record_review", threadId: "owner", turnId: "turn", callId: "call",
      arguments: { sourceKey: "external-review", title: "Review cancellation", items: [{ title: "Abort pending requests" }] },
    } });
    expect(recorded.success).toBe(true);
    const review = service.list({ backend: "codex", threadId: "owner" })[0]!;
    const response = await router.handleMcpToolCall({ backend: "codex", threadId: "owner", namespace: "pwragent", tool: "update_review_item", args: {
      id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Added the abort handler.", url: "https://example.com/commit/fix",
    } });
    expect(response.isError).not.toBe(true);
    expect(service.get(review.id)).toMatchObject({ status: "handled", items: [{ resolution: { actor: "agent", url: "https://example.com/commit/fix" } }] });
  });

  it("says how to settle findings where it lists them, and only while one is open", async () => {
    const review = service.record({ backend: "codex", threadId: "owner" }, {
      sourceKey: "artifact", title: "Review", items: [{ title: "Abort pending requests" }],
    });
    const tool = buildPwrAgentThreadReviewToolDefinitions(handler).find((entry) => entry.name === "list_reviews")!;
    expect(await tool.dispatch({}, context)).toMatchObject({ ok: true, data: { guidance: OPEN_FINDINGS_GUIDANCE } });
    service.update({ id: review.id, itemId: review.items[0]!.id, status: "addressed", note: "Done." }, "agent", { backend: "codex", threadId: "owner" });
    const settled = await tool.dispatch({ status: "all" }, context);
    expect(settled).toMatchObject({ ok: true, data: { reviews: [{ status: "handled" }] } });
    expect((settled as { data: object }).data).not.toHaveProperty("guidance");
  });

  it("names every way to settle a finding in its schema and guidance", () => {
    const tool = buildPwrAgentThreadReviewToolDefinitions(handler).find((entry) => entry.name === "update_review_item")!;
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.status!.enum).toEqual([
      "open", "addressed", "declined", "deferred", "dismissed", "fixed", "no_change_needed", "skipped",
    ]);
    expect(properties).toHaveProperty("todoId");
    for (const word of ["addressed", "declined", "deferred", "add_todo", "todoId"]) {
      expect(OPEN_FINDINGS_GUIDANCE).toContain(word);
      expect(tool.description).toContain(word);
    }
  });

  it("settles findings through their older names and passes a deferral's todoId to the handler", async () => {
    const owner = { backend: "codex" as const, threadId: "owner" };
    const review = service.record(owner, {
      sourceKey: "aliases", title: "Review", items: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    });
    const deferring: PwrAgentThreadReviewHandler = {
      ...handler,
      update: (identity, request) => service.update(request, "agent", identity,
        request.todoId === "todo-1" ? { id: "todo-1", title: "Follow up" } : undefined),
    };
    const tool = buildPwrAgentThreadReviewToolDefinitions(deferring).find((entry) => entry.name === "update_review_item")!;
    const [one, two, three] = review.items;
    expect(await tool.dispatch({ id: review.id, itemId: one!.id, status: "dismissed", note: "Intended." }, context))
      .toMatchObject({ ok: true });
    expect(await tool.dispatch({ id: review.id, itemId: two!.id, status: "fixed", note: "Done." }, context))
      .toMatchObject({ ok: true });
    expect(await tool.dispatch({ id: review.id, itemId: three!.id, status: "skipped", note: "Out of scope." }, context))
      .toMatchObject({ ok: true, data: { review: { items: [{}, {}, { status: "declined" }] } } });
    expect(await tool.dispatch({ id: review.id, itemId: three!.id, status: "deferred", note: "Later." }, context))
      .toMatchObject({ ok: false, code: "invalid_arguments", message: expect.stringContaining("todoId") });
    expect(await tool.dispatch({ id: review.id, itemId: three!.id, status: "deferred", note: "Later.", todoId: "todo-1" }, context))
      .toMatchObject({ ok: true });
    expect(service.get(review.id)).toMatchObject({
      status: "handled",
      items: [{ status: "declined" }, { status: "addressed" }, { status: "deferred", resolution: { todo: { id: "todo-1", title: "Follow up" } } }],
    });
  });

  it("rejects guessed review ids from another calling thread even with spoofed arguments", async () => {
    const review = service.record({ backend: "codex", threadId: "other" }, { sourceKey: "artifact", title: "Review", items: [] });
    const tool = buildPwrAgentThreadReviewToolDefinitions(handler).find((entry) => entry.name === "update_review")!;
    const result = await tool.dispatch({ id: review.id, status: "dismissed", note: "Ignore", threadId: "other", backend: "codex" }, context);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(service.get(review.id)?.status).toBe("open");
  });

  it.each([
    ["record_review", { sourceKey: "artifact", title: "Review", items: [{ title: "Invalid", priority: 10 }] }],
    ["record_review", { sourceKey: "artifact", title: "Review", items: [null] }],
    ["list_reviews", { status: "unresolved" }],
    ["update_review_item", { id: "missing", status: "addressed" }],
  ])("rejects malformed arguments to %s", async (name, args) => {
    const tool = buildPwrAgentThreadReviewToolDefinitions(handler).find((entry) => entry.name === name)!;
    expect(await tool.dispatch(args, context)).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});
