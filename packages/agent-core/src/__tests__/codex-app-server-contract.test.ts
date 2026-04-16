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
        "thread/list",
        "thread/loaded/list",
        "thread/start",
        "thread/new",
        "thread/resume",
        "thread/name/set",
        "thread/read",
        "thread/compact/start",
        "model/list",
        "skills/list",
        "experimentalFeature/list",
        "mcpServerStatus/list",
        "account/rateLimits/read",
        "account/read",
        "review/start",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
      ],
    });
  });

  it("creates, lists, renames, and resumes a thread without requiring cwd on resume", async () => {
    const { server } = createTestHarness();

    const created = await server.request("thread/start", {
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });

    expect(created).toEqual({
      threadId: "thread-1",
      threadName: undefined,
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
      modelProvider: "xai",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: undefined,
      reasoningEffort: undefined,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const renamed = await server.request("thread/name/set", {
      threadId: "thread-1",
      name: "OpenClaw parity",
    });
    const resumed = await server.request("thread/resume", {
      threadId: "thread-1",
      model: "grok-4.20-fast",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: false,
    });
    const listed = await server.request("thread/list", {});

    expect(renamed).toEqual({
      threadId: "thread-1",
      threadName: "OpenClaw parity",
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
      modelProvider: "xai",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: undefined,
      reasoningEffort: undefined,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(resumed).toEqual({
      threadId: "thread-1",
      threadName: "OpenClaw parity",
      cwd: "/repo/workspace",
      model: "grok-4.20-fast",
      modelProvider: "xai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: undefined,
      reasoningEffort: undefined,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(listed).toEqual({
      threads: [
        {
          threadId: "thread-1",
          title: "OpenClaw parity",
          summary: undefined,
          projectKey: "/repo/workspace",
          model: "grok-4.20-fast",
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ],
    });
  });

  it("returns thread replay state after user and assistant messages are recorded", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    const turn = await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship it" }],
      collaborationMode: { mode: "default" },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Done.",
      providerResponseId: "resp_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(turn).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(replay).toEqual({
      threadId: "thread-1",
      thread: {
        threadId: "thread-1",
        threadName: undefined,
        cwd: "/repo/workspace",
        model: undefined,
        modelProvider: "xai",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: undefined,
        reasoningEffort: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
      messages: [
        { role: "user", text: "Ship it" },
        { role: "assistant", text: "Done." },
      ],
      lastUserMessage: "Ship it",
      lastAssistantMessage: "Done.",
    });
  });
});
