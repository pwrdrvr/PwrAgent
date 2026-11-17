import fc from "fast-check";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpenAIDecisionsError,
  OpenAIDecisionsService,
  type DecisionBatchCardReport,
} from "../openai-decisions/openai-decisions-service";
import {
  DECISION_BATCH_LIMITS,
  DECISION_TIMING_LIMITS,
  DecisionItemTimings,
  pageBatchResults,
  recordBatchItem,
  type DecisionBatchItem,
  type DecisionBatchRecord,
  type DecisionBatchStatusFilter,
} from "../openai-decisions/decision-batches";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Synthetic keys only. All requests go to an injected fetch.
const OPENAI_KEY = "sk-test-openai-decisions-delivery-0123456789";
const JEV_KEY = "sk-test-jev-delivery-0123456789abcdef";
const CALLER = { backend: "codex", threadId: "thread-a" };
const OTHER = { backend: "codex", threadId: "thread-b" };
const JEV_TARGET = { endpoint: "https://jev.test", model: "jev-latest", apiKey: JEV_KEY };
const PREDICATE = { instructions: "Is it a bar joke?", question: { type: "predicate", name: "bar" } };
const JEV = { provider: "jev", ...PREDICATE };

type Wake = { caller: { backend: string; threadId: string }; batchId: string; text: string };

let db: StateDb;
let cards: DecisionBatchCardReport[];
let wakes: Wake[];

beforeEach(() => {
  db = openInMemoryStateDb();
  cards = [];
  wakes = [];
});
afterEach(() => db.close());

function makeService(
  fetch: typeof globalThis.fetch,
  options: { readApiKey?: () => Promise<string | undefined>; resultsDir?: string; idPrefix?: string } = {},
) {
  let batch = 0;
  return new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: options.readApiKey ?? (async () => OPENAI_KEY),
    readSystemOneTarget: async (provider) => provider === "jev" ? JEV_TARGET : undefined,
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async () => undefined,
    reportBatch: async (report) => { cards.push(report); },
    wakeThread: async (caller, wake) => { wakes.push({ caller, ...wake }); },
    newBatchId: () => `${options.idPrefix ?? "test"}-${(batch += 1)}`,
    ...(options.resultsDir ? { batchResultsDirectory: () => options.resultsDir! } : {}),
    fetch,
    endpoint: "https://openai.test/v1/decisions",
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function jevIndex(init: RequestInit | undefined): number {
  return Number(String((JSON.parse(String(init!.body)) as { state: string }).state).slice(5));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function errorOf(work: () => unknown): Promise<OpenAIDecisionsError> {
  const error = await Promise.resolve().then(work).then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof OpenAIDecisionsError)) throw new Error(`expected OpenAIDecisionsError, got ${String(error)}`);
  return error;
}

type Page = {
  state: string;
  count: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{ index: number; ok: boolean; code?: string; answers?: Array<{ probability?: number }> }>;
  nextFrom?: number;
};

/** Every page of a batch, following nextFrom, as an agent would read it. */
async function readAll(service: OpenAIDecisionsService, batchId: string, status: DecisionBatchStatusFilter, limit: number) {
  const items: Page["results"] = [];
  let from: number | undefined = 0;
  let pages = 0;
  while (from !== undefined) {
    const page = await service.batchResults(CALLER, { batchId, status, from, limit }) as unknown as Page;
    expect(page.results.length).toBeLessThanOrEqual(limit);
    items.push(...page.results);
    if (page.nextFrom !== undefined) expect(page.nextFrom).toBeGreaterThan(from);
    from = page.nextFrom;
    pages += 1;
    expect(pages).toBeLessThanOrEqual(500);
  }
  return items;
}

describe("answers outlive the call", () => {
  // Rule: every answer the provider returned is readable by batch id after
  // the call that asked for it is cancelled, whether or not the caller ever
  // saw the call's result. Oracle: the set of inputs the fake provider
  // answered. Pre-fix, a cancelled batch's answers lived only in a result
  // the caller may never receive.
  it("keeps exactly the answered items, and skips exactly the unsent ones", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 60 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 1, max: 60 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 60, maxLength: 60 }),
      fc.integer({ min: 1, max: 40 }),
      async (count, concurrency, abortAt, delays, limit) => {
        const controller = new AbortController();
        const answered = new Set<number>();
        let calls = 0;
        const service = makeService(async (_url, init) => {
          const index = jevIndex(init);
          calls += 1;
          if (calls === Math.min(abortAt, count)) controller.abort();
          await new Promise((resolve) => setTimeout(resolve, delays[index]));
          answered.add(index);
          return json({ answers: { bar: { noul: index / 1000 } } });
        });
        // The caller drops the result, as a client that timed out does.
        await service.invoke(CALLER, {
          definition: JEV,
          inputs: Array.from({ length: count }, (_, index) => `item-${index}`),
          concurrency,
        }, controller.signal);

        const { batches } = await service.batchResults(CALLER, {}) as unknown as { batches: Array<{ batchId: string }> };
        expect(batches).toHaveLength(1);
        const batchId = batches[0]!.batchId;
        const all = await readAll(service, batchId, "all", limit);
        expect(all.map((item) => item.index)).toEqual(Array.from({ length: count }, (_, index) => index));
        const succeeded = await readAll(service, batchId, "succeeded", limit);
        expect(new Set(succeeded.map((item) => item.index))).toEqual(answered);
        for (const item of succeeded) expect(item.answers![0]!.probability).toBe(item.index / 1000);
        const skipped = await readAll(service, batchId, "skipped", limit);
        expect(skipped.map((item) => item.index).sort((a, b) => a - b))
          .toEqual(all.filter((item) => !answered.has(item.index)).map((item) => item.index));
        const summary = await service.batchResults(CALLER, { batchId, limit: 1 }) as unknown as Page;
        expect(summary).toMatchObject({
          count,
          succeeded: answered.size,
          failed: count - answered.size,
          skipped: count - answered.size,
          state: answered.size === count ? "completed" : "cancelled",
        });
      },
    ), { numRuns: 40 });
  });

  it("still refuses a batch as busy when its decision's queue is full", async () => {
    const gate = deferred();
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey: async () => OPENAI_KEY,
      readSystemOneTarget: async () => JEV_TARGET,
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async () => undefined,
      queueLimit: 0,
      fetch: async () => {
        await gate.promise;
        return json({ answers: { bar: { noul: 0.5 } } });
      },
    });
    const first = service.invoke(CALLER, { definition: JEV, inputs: ["item-0"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const background of [false, true]) {
      const error = await errorOf(() => service.invoke(CALLER, { definition: JEV, inputs: ["item-1"], background }));
      expect(error.code).toBe("busy");
    }
    gate.resolve();
    await first;
    // Neither refusal left a batch behind.
    expect((await service.batchResults(CALLER, {}) as { batches: unknown[] }).batches).toHaveLength(1);
  });

  it("hides a batch from every other thread", async () => {
    const service = makeService(async (_url, init) => json({ answers: { bar: { noul: jevIndex(init) / 1000 } } }));
    const result = await service.invoke(CALLER, { definition: JEV, inputs: ["item-0", "item-1"] }) as { batchId: string };
    expect(await service.batchResults(OTHER, {})).toEqual({ batches: [] });
    expect((await errorOf(() => service.batchResults(OTHER, { batchId: result.batchId }))).code).toBe("batch_not_found");
    expect((await errorOf(() => service.cancelBatch(OTHER, { batchId: result.batchId }))).code).toBe("batch_not_found");
  });
});

describe("pages", () => {
  const itemArb = fc.oneof(
    fc.record({ ok: fc.constant(true as const), answers: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }) }),
    fc.record({ ok: fc.constant(false as const), code: fc.constantFrom("skipped", "upstream_error", "rate_limited") }),
    fc.constant(undefined),
  );

  // Rule: following nextFrom reads every finished item that matches the
  // filter exactly once, in input order, and no page passes its item limit,
  // or its byte bound unless the page holds one item. Oracle: the filter
  // applied to the item list directly.
  it("reassemble to exactly the filtered items in order", () => {
    fc.assert(fc.property(
      fc.array(itemArb, { minLength: 1, maxLength: 80 }),
      fc.constantFrom<DecisionBatchStatusFilter>("all", "succeeded", "failed", "skipped"),
      fc.integer({ min: 1, max: 30 }),
      fc.integer({ min: 40, max: 2_000 }),
      fc.constantFrom("compact" as const, "full" as const),
      (items, status, limit, maxBytes, detail) => {
        const record = batchOf(items);
        const expected = record.results.filter((item): item is DecisionBatchItem => item !== undefined && (
          status === "all"
          || (status === "succeeded" && item.ok)
          || (status === "failed" && !item.ok)
          || (status === "skipped" && !item.ok && item.code === "skipped")
        )).map((item) => item.index);
        const seen: number[] = [];
        let from: number | undefined = 0;
        while (from !== undefined) {
          const page = pageBatchResults(record, { from, limit, status, detail, maxBytes });
          expect(page.results.length).toBeLessThanOrEqual(limit);
          const bytes = page.results.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
          if (page.results.length > 1) expect(bytes).toBeLessThanOrEqual(maxBytes);
          seen.push(...page.results.map((item) => (item as { index: number }).index));
          if (page.nextFrom !== undefined) expect(page.results.length).toBeGreaterThan(0);
          from = page.nextFrom;
        }
        expect(seen).toEqual(expected);
      },
    ), { numRuns: 300 });
  });

  function batchOf(items: Array<{ ok: true; answers: number[] } | { ok: false; code: string } | undefined>): DecisionBatchRecord {
    const record: DecisionBatchRecord = {
      batchId: "batch_pages",
      caller: CALLER,
      decisionId: "d",
      name: "pages",
      version: 1,
      provider: "jev",
      count: items.length,
      concurrency: 8,
      background: false,
      state: "running",
      createdAt: 0,
      results: new Array(items.length).fill(undefined),
      succeeded: 0,
      failed: 0,
      skipped: 0,
      controller: new AbortController(),
    };
    items.forEach((item, index) => {
      if (!item) return;
      recordBatchItem(record, item.ok
        ? { index, ok: true, answers: item.answers.map((probability) => ({ type: "predicate", probability })) }
        : { index, ok: false, code: item.code, message: "failed" });
    });
    return record;
  }
});

describe("compact results", () => {
  const OPENAI_BODY = {
    id: "dec_123",
    model: "gpt-6-luna",
    answers: [
      { type: "predicate", name: "urgent", probability: 0.82 },
      { type: "choice", name: "queue", choice: "billing", confidence: 0.7, probabilities: { billing: 0.7, other: 0.3 } },
      { type: "score", name: "severity", score: 2.4, confidence: 0.5, probabilities: [{ value: 0, probability: 0.1 }] },
      { type: "refusal", name: null },
    ],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0 },
  };

  it("returns answers and confidence by default, and the full body on request", async () => {
    const service = makeService(async () => json(OPENAI_BODY));
    const definition = { provider: "openai", instructions: "Triage.", question: { type: "predicate", name: "urgent" } };
    const compact = await service.invoke(CALLER, { definition, inputs: ["a", "b"] }) as Record<string, unknown> & {
      results: Array<Record<string, unknown>>;
      usage: Record<string, unknown>;
    };
    expect(compact.detail).toBe("compact");
    expect(compact.results[0]).toEqual({
      index: 0,
      ok: true,
      answers: [
        { type: "predicate", name: "urgent", probability: 0.82 },
        { type: "choice", name: "queue", choice: "billing", confidence: 0.7 },
        { type: "score", name: "severity", score: 2.4, confidence: 0.5 },
        { type: "refusal" },
      ],
    });
    expect(compact.usage).toMatchObject({ inputTokens: 2000, priceStatus: "estimated", pricedItems: 2 });

    const full = await service.batchResults(CALLER, { batchId: compact.batchId, detail: "full" }) as unknown as {
      results: Array<{ response?: { id?: string; answers?: unknown[] }; usage?: unknown }>;
    };
    expect(full.results[0]!.response).toMatchObject({ id: "dec_123", answers: OPENAI_BODY.answers });
    expect(full.results[0]!.usage).toBeDefined();
    expect(JSON.stringify([compact, full])).not.toContain(OPENAI_KEY);

    // One input keeps its documented full shape unless compact is asked for.
    const single = await service.invoke(CALLER, { definition, input: "a" }) as Record<string, unknown>;
    expect(single.response).toBeDefined();
    const singleCompact = await service.invoke(CALLER, { definition, input: "a", detail: "compact" }) as Record<string, unknown>;
    expect(singleCompact.response).toBeUndefined();
    expect(singleCompact.answers).toHaveLength(4);
  });

  it("bounds the inline results and points at the rest", async () => {
    const service = makeService(async (_url, init) => json({ answers: { bar: { noul: jevIndex(init) / 1000 } } }));
    const questions = Array.from({ length: 16 }, (_, index) => ({ type: "predicate", name: `q${index}` }));
    const result = await service.invoke(CALLER, {
      definition: { provider: "jev", instructions: "Check.", questions },
      inputs: Array.from({ length: 500 }, (_, index) => `item-${index}`),
    }) as Page & { batchId: string };
    expect(result.succeeded).toBe(500);
    expect(Buffer.byteLength(JSON.stringify(result.results))).toBeLessThanOrEqual(DECISION_BATCH_LIMITS.pageMaxBytes);
    expect(result.nextFrom).toBe(result.results.length);
    const rest = (await readAll(service, result.batchId, "all", 500)).slice(result.nextFrom);
    expect([...result.results, ...rest].map((item) => item.index))
      .toEqual(Array.from({ length: 500 }, (_, index) => index));
  });
});

describe("background batches", () => {
  it("return at once, show progress, and wake the thread once when they end", async () => {
    const gate = deferred();
    const service = makeService(async (_url, init) => {
      await gate.promise;
      return json({ answers: { bar: { noul: jevIndex(init) / 1000 } } });
    });
    const started = await service.invoke(CALLER, {
      definition: JEV,
      inputs: Array.from({ length: 200 }, (_, index) => `item-${index}`),
      background: true,
    }) as { batchId: string; state: string; pending: number; next: string };
    expect(started.state).toMatch(/^(queued|running)$/);
    expect(started.pending).toBe(200);
    expect(started.next).toContain("End your turn");
    expect(wakes).toHaveLength(0);

    gate.resolve();
    await expect.poll(() => wakes.length).toBe(1);
    expect(wakes[0]).toMatchObject({ caller: CALLER, batchId: started.batchId });
    expect(wakes[0]!.text).toContain(`decisions_batch_results { "batchId": "${started.batchId}" }`);
    expect(wakes[0]!.text).toContain("200 of 200 items answered");

    // Running first, terminal last, never more than 11 writes, and the
    // count never goes backwards.
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.length).toBeLessThanOrEqual(11);
    expect(cards[0]!.status).toBe("running");
    expect(cards.at(-1)).toMatchObject({ status: "success", task: "Decision batch ad_hoc: 200 of 200 done" });
    const done = cards.map((card) => Number(/: (\d+) of/.exec(card.task)![1]));
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(cards.every((card) => card.batchId === started.batchId && card.caller.threadId === CALLER.threadId)).toBe(true);

    const read = await service.batchResults(CALLER, { batchId: started.batchId, status: "succeeded", limit: 500 }) as unknown as Page;
    expect(read).toMatchObject({ state: "completed", succeeded: 200 });
    expect(read.results).toHaveLength(200);
  });

  it("refuses a background batch before it is admitted when the credential is missing", async () => {
    let calls = 0;
    const service = makeService(async () => { calls += 1; return json({}); }, { readApiKey: async () => undefined });
    const error = await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      inputs: ["a", "b"],
      background: true,
    }));
    expect(error.code).toBe("credential_missing");
    expect(await service.batchResults(CALLER, {})).toEqual({ batches: [] });
    expect(calls).toBe(0);
  });

  it("stop on cancel without a wake-up, and keep what finished", async () => {
    const gates: Array<() => void> = [];
    const service = makeService(async (_url, init) => {
      const index = jevIndex(init);
      if (index >= 2) await new Promise<void>((resolve) => gates.push(resolve));
      return json({ answers: { bar: { noul: index / 1000 } } });
    });
    const started = await service.invoke(CALLER, {
      definition: JEV,
      inputs: Array.from({ length: 40 }, (_, index) => `item-${index}`),
      concurrency: 2,
      background: true,
    }) as { batchId: string };
    await expect.poll(() => gates.length).toBe(2);
    const cancelling = service.cancelBatch(CALLER, { batchId: started.batchId });
    for (const release of gates) release();
    const cancelled = await cancelling as unknown as Page;
    expect(cancelled).toMatchObject({ state: "cancelled", succeeded: 4, skipped: 36 });
    expect(cards.at(-1)!.status).toBe("cancelled");
    expect(wakes).toHaveLength(0);
    expect(await service.cancelBatch(CALLER, { batchId: started.batchId })).toMatchObject({ alreadyFinished: true });
  });

  it("are cancelled at shutdown with no card or wake-up", async () => {
    const gate = deferred();
    const service = makeService(async () => {
      await gate.promise;
      return json({ answers: { bar: { noul: 0.5 } } });
    });
    await service.invoke(CALLER, {
      definition: JEV,
      inputs: Array.from({ length: 40 }, (_, index) => `item-${index}`),
      background: true,
    });
    await expect.poll(() => cards.length).toBe(1);
    const closing = service.close();
    gate.resolve();
    await closing;
    expect(cards).toHaveLength(1);
    expect(wakes).toHaveLength(0);
  });

  it("are limited per thread", async () => {
    const gate = deferred();
    const service = makeService(async () => {
      await gate.promise;
      return json({ answers: { bar: { noul: 0.5 } } });
    });
    for (let batch = 0; batch < DECISION_BATCH_LIMITS.backgroundPerThread; batch += 1) {
      // Distinct definitions, so each runs in its own lane.
      await service.invoke(CALLER, {
        definition: { provider: "jev", instructions: `Check ${batch}.`, question: { type: "predicate", name: "bar" } },
        inputs: ["item-0"],
        background: true,
      });
    }
    const error = await errorOf(() => service.invoke(CALLER, { definition: JEV, inputs: ["item-0"], background: true }));
    expect(error.code).toBe("busy");
    // Another thread has its own allowance.
    await service.invoke(OTHER, { definition: JEV, inputs: ["item-0"], background: true });
    gate.resolve();
    await expect.poll(() => wakes.length).toBe(DECISION_BATCH_LIMITS.backgroundPerThread + 1);
  });

  it("validate the new arguments before any request", async () => {
    let calls = 0;
    const service = makeService(async () => { calls += 1; return json({}); });
    for (const args of [
      { definition: JEV, input: "item-0", background: true },
      { definition: JEV, inputs: ["item-0"], background: "yes" },
      { definition: JEV, inputs: ["item-0"], detail: "raw" },
    ]) {
      expect((await errorOf(() => service.invoke(CALLER, args))).code).toBe("invalid_input");
    }
    for (const args of [
      { status: "failed" },
      { batchId: 7 },
      { batchId: "batch_x", limit: 0 },
      { batchId: "batch_x", from: -1 },
      { batchId: "batch_x", extra: true },
    ]) {
      expect((await errorOf(() => service.batchResults(CALLER, args))).code).toBe("invalid_input");
    }
    expect(calls).toBe(0);
  });
});

describe("per-item timing", () => {
  // Oracle: the latest 200 durations of each decision version, summarized
  // directly. The window must never mix versions or keep older samples.
  it("summarizes exactly the latest window of each decision version", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.constantFrom("d1", "d2"), fc.integer({ min: 1, max: 2 }), fc.integer({ min: 0, max: 30_000 })), {
        maxLength: 700,
      }),
      (events) => {
        const timings = new DecisionItemTimings();
        const seen = new Map<string, number[]>();
        for (const [decisionId, version, ms] of events) {
          timings.record(decisionId, version, ms);
          const key = `${decisionId}/${version}`;
          seen.set(key, [...(seen.get(key) ?? []), ms]);
        }
        for (const decisionId of ["d1", "d2"]) {
          for (const version of [1, 2]) {
            const window = (seen.get(`${decisionId}/${version}`) ?? []).slice(-DECISION_TIMING_LIMITS.samplesPerDecision);
            const summary = timings.summary(decisionId, version);
            if (window.length === 0) {
              expect(summary).toBeUndefined();
              continue;
            }
            const sorted = [...window].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            const p50 = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
            expect(summary).toEqual({
              samples: window.length,
              minMs: sorted[0],
              maxMs: sorted.at(-1),
              meanMs: Math.round(window.reduce((sum, value) => sum + value, 0) / window.length),
              p50Ms: Math.round(p50),
            });
          }
        }
      },
    ), { numRuns: 100 });
  });

  it("forgets the least recently run decision first", () => {
    const timings = new DecisionItemTimings();
    for (let index = 0; index <= DECISION_TIMING_LIMITS.decisions; index += 1) {
      timings.record(`d${index}`, 1, index);
      // d0 keeps running, so it is never the oldest.
      if (index > 0) timings.record("d0", 1, 5);
    }
    expect(timings.summary("d0", 1)).toBeDefined();
    expect(timings.summary("d1", 1)).toBeUndefined();
    expect(timings.summary(`d${DECISION_TIMING_LIMITS.decisions}`, 1)).toMatchObject({ samples: 1 });
  });

  it("is reported by decisions_list for the listed version", async () => {
    let clock = 0;
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey: async () => OPENAI_KEY,
      readSystemOneTarget: async () => JEV_TARGET,
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async () => undefined,
      now: () => clock,
      fetch: async (_url, init) => {
        // Item n takes (n + 1) * 100 ms of the injected clock.
        clock += (jevIndex(init) + 1) * 100;
        return json({ answers: { bar: { noul: 0.5 } } });
      },
    });
    await service.register(CALLER, { name: "bar_joke", ...JEV, inputSchema: { type: "string" } });
    const listed = () => (service.list(CALLER, {}) as { decisions: Array<{ timing?: unknown }> }).decisions[0]!;
    expect(listed().timing).toBeUndefined();
    await service.invoke(CALLER, { name: "bar_joke", inputs: ["item-0", "item-1", "item-2"], concurrency: 1 });
    expect(listed().timing).toEqual({ samples: 3, minMs: 100, maxMs: 300, meanMs: 200, p50Ms: 200 });
    // A new version starts its own window.
    await service.update(CALLER, { name: "bar_joke", ...JEV, instructions: "Is it a pun?", inputSchema: { type: "string" } });
    expect(listed().timing).toBeUndefined();
  });
});

describe("result files", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "decision-batches-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function readLines(file: string) {
    return (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // Rule: after a restart, a batch reads back exactly as it read before,
  // item for item at full detail, whatever point a cancel cut it at.
  // Oracle: the original service's own pages, read before the restart.
  it("read back after a restart exactly as before it", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 40 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 1, max: 40 }),
      fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 40, maxLength: 40 }),
      async (count, concurrency, abortAt, delays) => {
        await rm(dir, { recursive: true, force: true });
        const controller = new AbortController();
        let calls = 0;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          const index = jevIndex(init);
          calls += 1;
          if (calls === Math.min(abortAt, count)) controller.abort();
          await new Promise((resolve) => setTimeout(resolve, delays[index]));
          return index % 7 === 3
            ? json({ error: { message: `bad ${JEV_KEY}` } }, 500)
            : json({ answers: { bar: { noul: index / 1000 } } });
        };
        const before = makeService(fetch, { resultsDir: dir, idPrefix: "before" });
        const result = await before.invoke(CALLER, {
          definition: JEV,
          inputs: Array.from({ length: count }, (_, index) => `item-${index}`),
          concurrency,
        }, controller.signal) as { batchId: string; resultsFile: string };
        expect(result.resultsFile).toBe(path.join(dir, `${result.batchId}.jsonl`));
        const expected = await before.batchResults(CALLER, { batchId: result.batchId, detail: "full", limit: 500 });

        const after = makeService(fetch, { resultsDir: dir, idPrefix: "after" });
        const read = await after.batchResults(CALLER, { batchId: result.batchId, detail: "full", limit: 500 });
        expect(read).toEqual(expected);
        const listed = await after.batchResults(CALLER, {}) as { batches: Array<{ batchId: string }> };
        expect(listed.batches.map((batch) => batch.batchId)).toEqual([result.batchId]);

        const lines = await readLines(result.resultsFile);
        expect(lines[0]).toMatchObject({ type: "batch", batchId: result.batchId, count });
        expect(lines.at(-1)).toMatchObject({ type: "end" });
        expect(lines.filter((line) => line.type === "item")).toHaveLength(count);
        expect(JSON.stringify(lines)).not.toContain(JEV_KEY);
      },
    ), { numRuns: 25 });
  });

  it("reads a batch cut off by a crash as cancelled, skipping a torn last line", async () => {
    const file = path.join(dir, "batch_crashed.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "batch", format: 1, batchId: "batch_crashed", decisionId: "d", name: "triage", version: 1, provider: "jev", count: 4, concurrency: 2, background: true, createdAt: 5 }),
      JSON.stringify({ type: "item", index: 1, ok: true, answers: [{ type: "predicate", probability: 0.25 }] }),
      JSON.stringify({ type: "item", index: 0, ok: false, code: "rate_limited", message: "rate_limited: HTTP 429." }),
      "{\"type\":\"item\",\"index\":2,\"ok\":tr",
    ].join("\n"));
    const service = makeService(async () => json({}), { resultsDir: dir });
    const read = await service.batchResults(CALLER, { batchId: "batch_crashed" }) as unknown as Page;
    expect(read).toMatchObject({ state: "cancelled", count: 4, succeeded: 1, failed: 3, skipped: 2 });
    expect(read.results.map((item) => item.code ?? "ok")).toEqual(["rate_limited", "ok", "skipped", "skipped"]);
  });

  it("never turns a batch id that PwrAgent did not make into a path", async () => {
    await writeFile(path.join(dir, "..", "decision-batches-outside.jsonl"), "{}").catch(() => undefined);
    const service = makeService(async () => json({}), { resultsDir: dir });
    for (const batchId of ["../decision-batches-outside", "batch_../x", "batch_a/b", "batch_"]) {
      expect((await errorOf(() => service.batchResults(CALLER, { batchId }))).code).toBe("batch_not_found");
    }
    await rm(path.join(dir, "..", "decision-batches-outside.jsonl"), { force: true });
  });

  it("keeps the latest files per thread and deletes the oldest", async () => {
    // Twenty older batches, each a minute apart.
    for (let index = 0; index < 20; index += 1) {
      const file = path.join(dir, `batch_old-${index}.jsonl`);
      await writeFile(file, `${JSON.stringify({ type: "batch", batchId: `batch_old-${index}` })}\n`);
      const at = new Date(1_800_000_000_000 + index * 60_000);
      await utimes(file, at, at);
    }
    const service = makeService(async () => json({ answers: { bar: { noul: 0.5 } } }), { resultsDir: dir });
    await service.invoke(CALLER, { definition: JEV, inputs: ["item-0"] });
    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(20);
    expect(names).not.toContain("batch_old-0.jsonl");
    expect(names).toContain("batch_old-1.jsonl");
    expect(names).toContain("batch_test-1.jsonl");
  });
});

describe("operator stop", () => {
  it("cancels a running batch with no wake-up, and refuses one that is not running", async () => {
    const gates: Array<() => void> = [];
    const service = makeService(async (_url, init) => {
      const index = jevIndex(init);
      if (index >= 1) await new Promise<void>((resolve) => gates.push(resolve));
      return json({ answers: { bar: { noul: index / 1000 } } });
    });
    const started = await service.invoke(CALLER, {
      definition: JEV,
      inputs: Array.from({ length: 20 }, (_, index) => `item-${index}`),
      concurrency: 1,
      background: true,
    }) as { batchId: string };
    await expect.poll(() => gates.length).toBe(1);
    // Another thread cannot stop it.
    expect(await service.stopBatch(OTHER, started.batchId)).toBe("not_running");
    const stopping = service.stopBatch(CALLER, started.batchId);
    gates[0]!();
    expect(await stopping).toBe("stopped");
    expect(cards.at(-1)).toMatchObject({ status: "cancelled" });
    expect(cards.at(-1)!.message).toContain("stopped from the thread");
    expect(wakes).toHaveLength(0);
    const read = await service.batchResults(CALLER, { batchId: started.batchId }) as unknown as Page;
    expect(read).toMatchObject({ state: "cancelled", succeeded: 2, skipped: 18 });
    expect(await service.stopBatch(CALLER, started.batchId)).toBe("not_running");
  });
});
