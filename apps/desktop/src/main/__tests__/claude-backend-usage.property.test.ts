import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Query, SDKControlGetUsageResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { claudeRateLimits } from "../claude/claude-usage";

/** The provider's full snapshot is the oracle, including same-window credits. */
async function creditedReading(overall: number, fable: number, credit: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-credit-"));
  const store = new ClaudeSessionStore(root);
  const resetsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const snapshot = (weekly: number, model: number) => ({ rate_limits_available: true, rate_limits: {
    seven_day: { utilization: weekly, resets_at: resetsAt },
    model_scoped: [{ display_name: "Fable", utilization: model, resets_at: resetsAt }],
  }, session: { model_usage: {} } } as SDKControlGetUsageResponse);
  const before = snapshot(overall, fable);
  const after = snapshot(overall - credit, 0);
  await store.saveRateLimits(claudeRateLimits(before));
  const completed = Promise.withResolvers<void>();
  const backend = new ClaudeBackend({
    store,
    query: () => Object.assign((async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    })(), { close: vi.fn(), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => after }) as unknown as Query,
    getSessionInfo: async () => undefined,
    discoverModels: async () => [],
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
    emit: async ({ notification }) => {
      if (notification.method === "turn/completed") completed.resolve();
      if (notification.method === "turn/failed") completed.reject(new Error("Fixture turn failed"));
    },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
    resolveEnv: async () => ({ PATH: "/fixture" }),
  });
  try {
    await backend.discover({ models: false });
    expect(backend.summary().rateLimits).toEqual(claudeRateLimits(before));
    const { threadId } = await backend.startThread({ cwd: root, executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Continue after credit" }] });
    await completed.promise;
    expect(backend.summary().rateLimits).toEqual(claudeRateLimits(after));
    await backend.close();
    expect((await store.readRateLimits()).limits).toEqual(claudeRateLimits(after));
  } finally {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

it("matches Claude's fresh snapshot after a Fable credit without clearing the remaining weekly use", async () => {
  // A Fable credit changes utilization, not the weekly reset date or account.
  await fc.assert(fc.asyncProperty(fc.record({
    remaining: fc.integer({ min: 1, max: 49 }),
    credit: fc.integer({ min: 1, max: 50 }),
    fable: fc.integer({ min: 1, max: 100 }),
  }), ({ remaining, credit, fable }) => creditedReading(remaining + credit, fable, credit)), { numRuns: 25 });
});

it("applies the 58% to 8% weekly and 100% to 0% Fable reset regression", async () => {
  await creditedReading(58, 100, 50);
});
