import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

describe("Codex turn lifecycle", () => {
  it("starts a turn, preserves mixed input, and emits a completion notification", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace", model: "grok-4.20-reasoning" });

    const started = await server.request("turn/start", {
      threadId: "thread-1",
      input: [
        { type: "text", text: "Describe this image" },
        { type: "localImage", path: "/tmp/screenshot.png" },
      ],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "It is a screenshot.",
      providerResponseId: "resp_2",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.input).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "localImage", path: "/tmp/screenshot.png" },
    ]);
    expect(notifications).toEqual([
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "It is a screenshot." }],
          },
        },
      },
    ]);
  });

  it("reuses the prior provider response id on follow-up turns", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "First turn" }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "First answer",
      providerResponseId: "resp_first",
    });
    await Promise.resolve();
    await Promise.resolve();

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Follow up" }],
    });

    expect(provider.runs[1]?.previousResponseId).toBe("resp_first");
  });

  it("steers an active turn with the expected turn id", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Initial prompt" }],
    });

    const steered = await server.request("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Continue with more detail" }],
    });

    expect(steered).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.steerCalls).toEqual([
      {
        thread: {
          threadId: "thread-1",
          cwd: "/repo/workspace",
          model: undefined,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          serviceTier: undefined,
          reasoningEffort: undefined,
        },
        runId: "turn-1",
        input: [{ type: "text", text: "Continue with more detail" }],
      },
    ]);
  });

  it("rejects steering a stale turn id", async () => {
    const { server } = createTestHarness({ provider: new FakeProvider() });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Initial prompt" }],
    });

    await expect(
      server.request("turn/steer", {
        threadId: "thread-1",
        expectedTurnId: "turn-999",
        input: [{ type: "text", text: "Continue" }],
      }),
    ).rejects.toThrow("Cannot steer inactive turn: turn-999");
  });

  it("interrupts an active turn and emits cancellation", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Long running" }],
    });

    const interrupted = await server.request("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(interrupted).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.interrupted).toBe(true);
    expect(notifications).toEqual([
      {
        method: "turn/cancelled",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "cancelled",
          },
        },
      },
    ]);
  });

  it("emits a failed notification when the provider rejects", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Cause failure" }],
    });
    provider.runs[0]?.deferred.reject(new Error("Unauthorized"));
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications).toEqual([
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Unauthorized",
            },
          },
        },
      },
    ]);
  });
});
