import { describe, expect, it } from "vitest";
import { createTestHarness, Deferred, FakeProvider } from "../testing/test-harness.js";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(check: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    try {
      await check();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await check();
}

describe("Codex pending input", () => {
  it("routes interactive approval requests through the client and emits resolution", async () => {
    const provider = new FakeProvider();
    const { server, notifications, requests } = createTestHarness({
      provider,
      requestHandler: async () => ({ decision: "approve" }),
    });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Need approval" }],
    });

    await provider.runs[0]?.emit({
      type: "request_input",
      requestId: "req-1",
      method: "turn/requestApproval",
      params: {
        prompt: "Approve this action?",
        options: ["approve", "reject"],
      },
      respond: async () => {
        return;
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Approved path complete.",
      providerResponseId: "resp_approval",
    });
    await waitFor(async () => {
      expect(provider.runs[0]?.eventResponses).toEqual([{ decision: "approve" }]);
      expect(notifications).toEqual([
        {
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            requestId: "req-1",
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Approved path complete." }],
            },
          },
        },
      ]);
    });

    expect(requests).toEqual([
      {
        method: "turn/requestApproval",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          requestId: "req-1",
          prompt: "Approve this action?",
          options: ["approve", "reject"],
        },
      },
    ]);
  });

  it("keeps steer working while an interactive request is in flight", async () => {
    const provider = new FakeProvider();
    const approvalResponse = new Deferred<unknown>();
    const { server } = createTestHarness({
      provider,
      requestHandler: async () => await approvalResponse.promise,
    });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Need approval before continuing" }],
    });

    await provider.runs[0]?.emit({
      type: "request_input",
      requestId: "req-2",
      method: "turn/requestApproval",
      params: {
        prompt: "Approve and continue?",
      },
      respond: async () => {
        return;
      },
    });
    await flushAsync();

    const steered = await server.request("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Continue after approval" }],
    });

    approvalResponse.resolve({ decision: "approve" });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Continued.",
      providerResponseId: "resp_steer",
    });
    await waitFor(async () => {
      expect(provider.runs[0]?.eventResponses).toEqual([{ decision: "approve" }]);
    });

    expect(steered).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.steerCalls).toEqual([
      {
        thread: expect.objectContaining({
          threadId: "thread-1",
        }),
        runId: "turn-1",
        input: [{ type: "text", text: "Continue after approval" }],
      },
    ]);
  });

  it("cancels pending interactive requests when the turn is interrupted", async () => {
    const provider = new FakeProvider();
    const neverResolve = new Deferred<unknown>();
    const { server, notifications } = createTestHarness({
      provider,
      requestHandler: async () => await neverResolve.promise,
    });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Block on approval" }],
    });

    await provider.runs[0]?.emit({
      type: "request_input",
      requestId: "req-3",
      method: "turn/requestApproval",
      params: {
        prompt: "Approve?",
      },
      respond: async () => {
        return;
      },
    });
    await flushAsync();

    const interrupted = await server.request("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await flushAsync();

    expect(interrupted).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.interrupted).toBe(true);
    expect(provider.runs[0]?.eventResponses).toEqual([{ decision: "cancel" }]);
    expect(notifications).toEqual([
      {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          requestId: "req-3",
        },
      },
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
});
