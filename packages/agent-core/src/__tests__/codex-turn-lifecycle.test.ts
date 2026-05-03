import { describe, expect, it } from "vitest";
import type {
  AppServerProvider,
  ProviderActiveTurn,
  ProviderTurnParams,
} from "../providers/provider-contract.js";
import { createTestHarness, Deferred, FakeProvider } from "../testing/test-harness.js";

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

    expect(started).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(provider.runs[0]?.input).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "localImage", path: "/tmp/screenshot.png" },
    ]);
    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
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

  it("rejects a second start while the thread has an active turn", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "First turn" }],
    });

    await expect(
      server.request("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "Overlapping turn" }],
      }),
    ).rejects.toThrow("Thread already has an active turn in progress: thread-1");
    expect(provider.runs).toHaveLength(1);

    provider.runs[0]?.deferred.resolve({
      assistantText: "Done",
      providerResponseId: "resp_done",
    });
    await Promise.resolve();
    await Promise.resolve();

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Follow up" }],
    });

    expect(provider.runs).toHaveLength(2);
  });

  it("rejects a concurrent start while provider startup is still pending", async () => {
    const provider = new SlowStartProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    const firstStart = server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "First turn" }],
    });
    await provider.startRequested.promise;

    const secondStart = server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Overlapping turn" }],
    });
    await Promise.resolve();

    expect(provider.startCalls).toBe(1);
    await expect(secondStart).rejects.toThrow(
      "Thread already has an active turn in progress: thread-1",
    );

    provider.allowStart.resolve();
    await expect(firstStart).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(provider.runs).toHaveLength(1);
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

    expect(steered).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(provider.runs[0]?.steerCalls).toEqual([
      {
        thread: expect.objectContaining({
          threadId: "thread-1",
          cwd: "/repo/workspace",
          model: undefined,
          modelProvider: "xai",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          serviceTier: undefined,
          reasoningEffort: undefined,
        }),
        turnId: "turn-1",
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

    expect(interrupted).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(provider.runs[0]?.interrupted).toBe(true);
    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
          },
        },
      },
      {
        method: "turn/cancelled",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
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
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
          },
        },
      },
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
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

  it("fails the turn when the provider resolves without assistant text", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Return something visible" }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "",
      providerResponseId: "resp_empty",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
          },
        },
      },
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Provider completed the turn without assistant text.",
            },
          },
        },
      },
    ]);
  });
});

class SlowStartProvider implements AppServerProvider {
  readonly startRequested = new Deferred<void>();
  readonly allowStart = new Deferred<void>();
  private readonly delegate = new FakeProvider();
  startCalls = 0;

  get runs() {
    return this.delegate.runs;
  }

  async startTurn(params: ProviderTurnParams): Promise<ProviderActiveTurn> {
    this.startCalls += 1;
    this.startRequested.resolve();
    await this.allowStart.promise;
    return this.delegate.startTurn(params);
  }
}
