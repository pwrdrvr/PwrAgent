import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_AUTO_APPROVAL_SETTINGS } from "@pwragent/shared";
import { McpAutoReviewer } from "../mcp-connections/mcp-auto-reviewer";

const settings = { ...DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, enabled: true };
const input = { kind: "question" as const, serverName: "datadog", message: "Choose a region", task: "Investigate US traffic.", schema: { type: "object", properties: { region: { type: "string", enum: ["us", "eu"] } }, required: ["region"] } };

describe("MCP Auto reviewer", () => {
  it("validates answers against the original schema and forwards provider, model, effort and prompt", async () => {
    const harness = vi.fn(async () => ({ action: "accept", content: { region: "us" }, reason: "The task specifies US." }));
    const reviewer = new McpAutoReviewer({ harness });
    expect(await reviewer.review(settings, input)).toMatchObject({ action: "accept", content: { region: "us" } });
    expect(harness).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-6-luna", reasoningEffort: "low", system: expect.stringContaining(settings.prompt) }), expect.any(AbortSignal));
  });

  it.each([
    { action: "accept", content: { region: "invented" }, reason: "yes" },
    { action: "accept", content: null, reason: "yes" },
    { action: ["accept"], content: {}, reason: "yes" },
    { action: "approve_everything", content: {}, reason: "yes" },
  ])("rejects malformed or schema-invalid answers", async (answer) => {
    expect((await new McpAutoReviewer({ harness: async () => answer }).review(settings, input)).action).toBe("decline");
  });

  it("uses a separate prompt for permission escalations", async () => {
    const harness = vi.fn(async (_request: import("../mcp-connections/mcp-auto-reviewer").McpHarnessReviewRequest, _signal: AbortSignal) => ({ action: "decline", content: null, reason: "Deletion was not authorized." }));
    await new McpAutoReviewer({ harness }).review({ ...settings, prompt: "Read-only monitoring policy.", escalationPrompt: "Check deletion and shell effects." }, { ...input, kind: "escalation" });
    expect(harness.mock.calls[0][0].system).toContain("Check deletion and shell effects.");
    expect(harness.mock.calls[0][0].system).not.toContain("Read-only monitoring policy.");
  });

  it("respects a reject decision", async () => {
    expect(await new McpAutoReviewer({ harness: async () => ({ action: "decline", content: null, reason: "Not authorized." }) }).review(settings, input)).toMatchObject({ action: "decline", content: null });
  });

  it("does not open URL or login flows", async () => {
    const harness = vi.fn();
    const result = await new McpAutoReviewer({ harness }).review(settings, { ...input, mode: "url" });
    expect(result.action).toBe("cancel");
    expect(harness).not.toHaveBeenCalled();
  });

  it("does not turn provider failure or disabled settings into approval", async () => {
    const harness = vi.fn(async () => { throw new Error("unavailable"); });
    expect((await new McpAutoReviewer({ harness }).review(settings, input)).action).toBe("decline");
    expect((await new McpAutoReviewer({ harness }).review({ ...settings, enabled: false }, input)).action).toBe("decline");
    expect(harness).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight review on caller abort", async () => {
    const controller = new AbortController();
    const harness = vi.fn(() => new Promise(() => {}));
    const pending = new McpAutoReviewer({ harness }).review(settings, input, controller.signal);
    controller.abort();
    expect((await pending).action).toBe("cancel");
  });

  it.each(["completions", "responses", "claude"] as const)("calls the %s endpoint and respects the returned decision", async (modelType) => {
    const answer = JSON.stringify({ action: "decline", content: null, reason: "Unauthorized write." });
    const body = modelType === "completions" ? { choices: [{ message: { content: answer } }] }
      : modelType === "responses" ? { output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] }
        : { content: [{ type: "text", text: answer }] };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await new McpAutoReviewer({ fetch }).review({ ...settings, modelType, endpoint: "https://reviewer.test/decide" }, input);
    expect(result.action).toBe("decline");
    expect(fetch).toHaveBeenCalledOnce();
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(sent.model).toBe(settings.model);
    expect(JSON.stringify(sent)).toContain(input.task);
  });

  it("rejects incomplete API responses even when they contain a valid approval object", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ action: "accept", content: { region: "us" }, reason: "OK" }) }] }] })));
    expect((await new McpAutoReviewer({ fetch }).review({ ...settings, modelType: "responses", endpoint: "https://reviewer.test/v1/responses" }, input)).action).toBe("decline");
  });

  it("sends an API key only as a header and bounds the request with cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ action: "decline", content: null, reason: "No" }) }] })));
    await new McpAutoReviewer({ fetch, readEnvironment: () => "fixture-key" }).review({ ...settings, modelType: "claude", endpoint: "https://reviewer.test/v1/messages", apiKeyEnv: "FIXTURE_KEY" }, input);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { "x-api-key": "fixture-key", "anthropic-version": "2023-06-01" }, redirect: "error", signal: expect.any(AbortSignal) });
    expect(fetch.mock.calls[0][1]?.body).not.toContain("fixture-key");
  });

  it("stops waiting when a harness exceeds the review deadline", async () => {
    const result = await new McpAutoReviewer({ harness: () => new Promise(() => {}) }).review({ ...settings, timeoutMs: 20 }, input);
    expect(result).toMatchObject({ action: "cancel", reason: expect.stringContaining("timed out") });
  });

  it("keeps the future decision-model type explicit and unavailable until its adapter is installed", async () => {
    const result = await new McpAutoReviewer({}).review({ ...settings, modelType: "system-one", endpoint: "http://localhost:8000/decide" }, input);
    expect(result).toMatchObject({ action: "decline", reason: expect.stringContaining("System One") });
  });
});
