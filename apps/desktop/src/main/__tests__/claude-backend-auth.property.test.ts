import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SDKMessage, SDKUserMessage, Query, query } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";

type OverlappingTurn = "older" | "newer";
type Continuation = "manual" | "follow-up";
const initialTurns = ["older", "newer"] as const;
const expiredLogin = "Failed to authenticate: this login reached its time limit and cannot be renewed.";

function rejectedLogin(): SDKMessage {
  return { type: "result", subtype: "success", is_error: true, result: expiredLogin } as SDKMessage;
}

/** Replay a retained SDK process, a separate process, then a turn on the retained one. */
async function replayAuth(order: readonly OverlappingTurn[], continuation: Continuation) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-auth-model-"));
  const results = {
    older: Promise.withResolvers<void>(), newer: Promise.withResolvers<void>(), followUp: Promise.withResolvers<void>(),
  };
  let retainedThreadId: string;
  const run = vi.fn((args: Parameters<typeof query>[0]) => {
    async function* stream() {
      const input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      await input.next();
      if (args.options?.sessionId !== retainedThreadId) {
        await results.newer.promise;
        yield { type: "result", subtype: "success", is_error: false, result: "Model response",
          usage: { output_tokens: 10 } } as SDKMessage;
        return;
      }

      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "Fixture task",
        task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      await results.older.promise;
      yield rejectedLogin();
      if (continuation === "manual") {
        if ((await input.next()).done) return;
      } else {
        await results.followUp.promise;
        yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed",
          output_file: "", summary: "Fixture task finished" } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: {
          id: "follow-up-error", content: [{ type: "text", text: expiredLogin }],
        } } as SDKMessage;
      }
      yield rejectedLogin();
    }
    return Object.assign(stream(), { close: () => {} }) as unknown as Query;
  });
  const terminal = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const backend = new ClaudeBackend({
    store: new ClaudeSessionStore(root),
    query: run,
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
    resolveEnv: async () => ({ PATH: "/fixture" }),
    discoverModels: async () => [],
    emit: async ({ notification }) => {
      if (notification.method === "turn/failed" || notification.method === "turn/completed") {
        const { threadId } = notification.params as { threadId: string };
        terminal.get(threadId)?.resolve();
      }
    },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
  });
  const start = (threadId: string) => backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
  try {
    retainedThreadId = (await backend.startThread({ cwd: root, executionMode: "default" })).threadId;
    const other = (await backend.startThread({ cwd: root, executionMode: "default" })).threadId;
    const threads = { older: retainedThreadId, newer: other };
    for (const name of initialTurns) {
      terminal.set(threads[name], Promise.withResolvers<void>());
      await start(threads[name]);
    }
    const statuses = [];
    for (const name of order) {
      results[name].resolve();
      await terminal.get(threads[name])!.promise;
      statuses.push(backend.summary().claude?.authStatus);
    }

    terminal.set(retainedThreadId, Promise.withResolvers<void>());
    if (continuation === "manual") await start(retainedThreadId);
    else results.followUp.resolve();
    await terminal.get(retainedThreadId)!.promise;
    expect(run).toHaveBeenCalledTimes(2);
    return { statuses, afterReuse: backend.summary().claude?.authStatus };
  } finally {
    for (const result of Object.values(results)) result.resolve();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

it("reports the credential outcome of the latest-started turn with a decisive result, including on a reused process", async () => {
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray([...initialTurns], { minLength: 2, maxLength: 2 }),
    fc.constantFrom("manual", "follow-up"),
    async (order, continuation) => {
      const observed = new Set<OverlappingTurn>();
      const expected = order.map((turn) => {
        observed.add(turn);
        const latest = initialTurns.findLast((started) => observed.has(started));
        return latest === "older" ? "session-expired" : "signed-in";
      });
      expect(await replayAuth(order, continuation)).toEqual({ statuses: expected, afterReuse: "session-expired" });
    },
  ), { numRuns: 12 });
});

it("keeps a newer model response ahead of an older rejection that finishes late", async () => {
  expect((await replayAuth(["newer", "older"], "manual")).statuses).toEqual(["signed-in", "signed-in"]);
});

it("accepts a new rejection from a retained process after a separate process recovered the account", async () => {
  expect(await replayAuth(["older", "newer"], "manual")).toEqual({
    statuses: ["session-expired", "signed-in"], afterReuse: "session-expired",
  });
});
