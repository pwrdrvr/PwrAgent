import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { buildOpenAIDecisionsUsageLine } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionsUsageBatcher } from "../openai-decisions/openai-decisions-usage-batcher";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const FLUSH_COUNT = 5;
const FLUSH_MS = 1_000;

type Request = {
  thread: number;
  decision: number;
  version: number;
  input: number;
  cached: number;
  writes: number;
  output: number;
};

const request = fc.record({
  thread: fc.integer({ min: 0, max: 2 }),
  decision: fc.integer({ min: 0, max: 1 }),
  version: fc.integer({ min: 1, max: 2 }),
  input: fc.integer({ min: 0, max: 400_000 }),
  cached: fc.integer({ min: 0, max: 200_000 }),
  writes: fc.integer({ min: 0, max: 50_000 }),
  output: fc.integer({ min: 0, max: 100 }),
});

const command = fc.oneof(
  { weight: 6, arbitrary: request.map((value) => ({ kind: "add" as const, value })) },
  { weight: 1, arbitrary: fc.constant({ kind: "flush" as const }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 * FLUSH_MS }).map((ms) => ({ kind: "tick" as const, ms })) },
);

function lineFor(value: Request, at: number): { group: { decisionId: string; version: number }; line: ThreadUsageLineRecord } {
  const group = { decisionId: `decision-${value.decision}`, version: value.version };
  return {
    group,
    line: buildOpenAIDecisionsUsageLine({
      caller: { backend: "codex", threadId: `thread-${value.thread}` },
      ...group,
      attempt: {
        status: 200,
        model: "gpt-6-luna",
        usage: {
          input_tokens: value.input,
          input_tokens_details: { cached_tokens: value.cached, cache_write_tokens: value.writes },
          output_tokens: value.output,
        },
      },
      accountKey: "api-project",
      now: at,
      fallbackId: `req-${at}`,
    }),
  };
}

/** What a batch must preserve: everything summed per thread, decision version, and price band. */
function totals(entries: Array<{ key: string; line: ThreadUsageLineRecord }>) {
  const byKey = new Map<string, number[]>();
  for (const { key, line } of entries) {
    const sum = byKey.get(key) ?? [0, 0, 0, 0, 0, 0];
    const values = [line.inputTokens, line.cachedInputTokens, line.cacheWriteInputTokens, line.outputTokens, line.totalCostMicros, 1];
    byKey.set(key, sum.map((total, index) => total + values[index]!));
  }
  return Object.fromEntries([...byKey].map(([key, sum]) => [key, sum.slice(0, 5)]).sort());
}

const keyOf = (line: ThreadUsageLineRecord, decisionVersion: string) =>
  [line.threadId, decisionVersion, line.priceStatus, line.pricingRateId ?? "-"].join("|");

it("writes exactly what was added, grouped, without writing per request or while idle", async () => {
  await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 60 }), async (commands) => {
    const batches: ThreadUsageLineRecord[][] = [];
    const batcher = new OpenAIDecisionsUsageBatcher({
      write: async (lines) => { batches.push(lines); },
      flushAfterMs: FLUSH_MS,
      flushAtCount: FLUSH_COUNT,
    });
    const added: Array<{ key: string; line: ThreadUsageLineRecord }> = [];
    let pending = 0;
    let at = 0;
    for (const step of commands) {
      if (step.kind === "add") {
        const { group, line } = lineFor(step.value, at += 1);
        added.push({ key: keyOf(line, `${group.decisionId}:${group.version}`), line });
        const before = batches.length;
        batcher.add(group, line);
        pending += 1;
        await Promise.resolve();
        await Promise.resolve();
        if (pending >= FLUSH_COUNT) {
          expect(batches.length).toBe(before + 1);
          pending = 0;
        } else {
          // Below the threshold an add never writes.
          expect(batches.length).toBe(before);
        }
      } else if (step.kind === "flush") {
        const before = batches.length;
        await batcher.flush();
        // Flushing with nothing pending writes nothing.
        expect(batches.length).toBe(before + (pending > 0 ? 1 : 0));
        pending = 0;
      } else {
        await vi.advanceTimersByTimeAsync(step.ms);
        pending = batcher.pendingRequestCount;
      }
    }
    await batcher.flush();
    expect(batcher.pendingRequestCount).toBe(0);
    // Idle afterwards: no timer is left to write anything.
    const settled = batches.length;
    await vi.advanceTimersByTimeAsync(10 * FLUSH_MS);
    expect(batches.length).toBe(settled);

    const written = batches.flatMap((lines) => lines.map((line) => {
      const [decisionId, version] = line.sourceItemId!.split(":");
      return { key: keyOf(line, `${decisionId}:${version}`), line };
    }));
    expect(totals(written)).toEqual(totals(added));
    for (const lines of batches) {
      // One line per group in a batch, never a priced and unpriced mix.
      const keys = lines.map((line) => {
        const [decisionId, version] = line.sourceItemId!.split(":");
        return keyOf(line, `${decisionId}:${version}`);
      });
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(lines.map((line) => line.usageLineId)).size).toBe(lines.length);
      for (const line of lines) expect(line.outputCostMicros).toBe(0);
    }
  }), { numRuns: 200 });
});

it("flushes on its own once the window passes after the first pending request", async () => {
  const batches: ThreadUsageLineRecord[][] = [];
  const batcher = new OpenAIDecisionsUsageBatcher({
    write: async (lines) => { batches.push(lines); },
    flushAfterMs: FLUSH_MS,
    flushAtCount: FLUSH_COUNT,
  });
  const { group, line } = lineFor({ thread: 0, decision: 0, version: 1, input: 10, cached: 0, writes: 0, output: 0 }, 1);
  batcher.add(group, line);
  await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
  expect(batches).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(batches).toHaveLength(1);
});
