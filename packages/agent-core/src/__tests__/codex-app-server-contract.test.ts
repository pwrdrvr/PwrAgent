import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

describe("Codex app-server contract", () => {
  it("returns server info and supported methods from initialize", async () => {
    const { server } = createTestHarness();

    const result = await server.request("initialize", {
      protocolVersion: "1.0",
      clientInfo: { name: "test-client", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });

    expect(result).toEqual({
      protocolVersion: "1.0",
      serverInfo: {
        name: "@pwragnt/grok-app-server",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
      methods: [
        "initialize",
        "thread/start",
        "thread/new",
        "thread/resume",
        "thread/read",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
      ],
    });
  });

  it("creates and resumes a thread without requiring cwd on resume", async () => {
    const { server } = createTestHarness();

    const created = await server.request("thread/start", {
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });

    expect(created).toEqual({
      threadId: "thread-1",
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: undefined,
      reasoningEffort: undefined,
    });

    const resumed = await server.request("thread/resume", {
      threadId: "thread-1",
      model: "grok-4.20-fast",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    expect(resumed).toEqual({
      threadId: "thread-1",
      cwd: "/repo/workspace",
      model: "grok-4.20-fast",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: undefined,
      reasoningEffort: undefined,
    });
  });

  it("returns thread replay state after user and assistant messages are recorded", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    const turn = await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship it" }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Done.",
      providerResponseId: "resp_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    const replay = await server.request("thread/read", { threadId: "thread-1" });

    expect(turn).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(replay).toEqual({
      threadId: "thread-1",
      messages: [
        { role: "user", text: "Ship it" },
        { role: "assistant", text: "Done." },
      ],
      lastUserMessage: "Ship it",
      lastAssistantMessage: "Done.",
    });
  });
});
