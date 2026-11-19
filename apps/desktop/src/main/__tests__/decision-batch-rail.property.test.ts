import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionsRailItem, DecisionsRailItemFilter } from "@pwragent/shared";
import {
  DECISION_INPUT_PREVIEW_MAX_BYTES,
  decisionInputPreview,
  pageBatchResults,
  recordBatchItem,
  type DecisionBatchItem,
  type DecisionBatchRecord,
} from "../openai-decisions/decision-batches";
import {
  DecisionBatchFileWriter,
  batchEndEntry,
  batchHeaderEntry,
  batchItemEntry,
  readDecisionBatchFile,
} from "../openai-decisions/decision-batch-files";
import { railAnswer, railBatch, railBatchPage, railItem } from "../openai-decisions/decision-batch-rail";

const CALLER = { backend: "codex", threadId: "thread-a" };
const FILTERS: DecisionsRailItemFilter[] = ["all", "succeeded", "failed", "skipped"];

type Outcome =
  | { ok: true; durationMs: number; probability: number; model?: string; preview: string }
  | { ok: false; code: string; durationMs: number; preview: string };

type Ending = "running" | "completed" | "stopped" | "cancelled";

/**
 * A batch as the service produces one: items finish in any order, each at
 * most once; a batch that ended early skips every item that never ran.
 */
type BatchPlan = {
  count: number;
  concurrency: number;
  outcomes: Outcome[];
  /** Indices in the order their items finished. */
  order: number[];
  /** How many items finished before the batch ended (all, when completed). */
  ran: number;
  ending: Ending;
  startedAt: number;
  wallMs: number;
  background: boolean;
};

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({
    ok: fc.constant(true as const),
    durationMs: fc.integer({ min: 0, max: 30_000 }),
    probability: fc.double({ min: 0, max: 1, noNaN: true }),
    model: fc.option(fc.constantFrom("gpt-6-luna", "jev-latest"), { nil: undefined }),
    preview: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    ok: fc.constant(false as const),
    code: fc.constantFrom("rate_limited", "timeout", "invalid_response"),
    durationMs: fc.integer({ min: 0, max: 30_000 }),
    preview: fc.string({ maxLength: 40 }),
  }),
);

const planArb: fc.Arbitrary<BatchPlan> = fc.integer({ min: 1, max: 30 }).chain((count) => fc.record({
  count: fc.constant(count),
  concurrency: fc.integer({ min: 1, max: 8 }),
  outcomes: fc.array(outcomeArb, { minLength: count, maxLength: count }),
  order: fc.shuffledSubarray(Array.from({ length: count }, (_, index) => index), { minLength: count, maxLength: count }),
  ran: fc.integer({ min: 0, max: count }),
  ending: fc.constantFrom<Ending>("running", "completed", "stopped", "cancelled"),
  startedAt: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
  wallMs: fc.integer({ min: 0, max: 600_000 }),
  background: fc.boolean(),
}));

function itemFor(plan: BatchPlan, index: number): DecisionBatchItem {
  const outcome = plan.outcomes[index]!;
  return outcome.ok
    ? {
        index,
        ok: true,
        ...(outcome.model ? { model: outcome.model } : {}),
        answers: [{ type: "predicate", name: "bar", probability: outcome.probability }],
        inputPreview: outcome.preview,
        durationMs: outcome.durationMs,
      }
    : { index, ok: false, code: outcome.code, message: `failed with ${outcome.code}`, inputPreview: outcome.preview, durationMs: outcome.durationMs };
}

/** Builds the record through recordBatchItem, as runBatch and finishBatch do. */
function buildBatch(plan: BatchPlan, resultsFile?: string): { record: DecisionBatchRecord; written: DecisionBatchItem[] } {
  const record: DecisionBatchRecord = {
    batchId: "batch_rail-test",
    caller: { ...CALLER },
    decisionId: "dec_1",
    name: "triage",
    version: 2,
    provider: "jev",
    count: plan.count,
    concurrency: plan.concurrency,
    background: plan.background,
    state: "running",
    createdAt: plan.startedAt - 5,
    startedAt: plan.startedAt,
    results: new Array<DecisionBatchItem | undefined>(plan.count).fill(undefined),
    succeeded: 0,
    failed: 0,
    skipped: 0,
    controller: new AbortController(),
    ...(resultsFile ? { resultsFile } : {}),
  };
  const written: DecisionBatchItem[] = [];
  const ran = plan.ending === "completed" ? plan.count : plan.ran;
  for (const index of plan.order.slice(0, ran)) {
    const item = itemFor(plan, index);
    if (recordBatchItem(record, item)) written.push(item);
  }
  if (plan.ending === "running") return { record, written };
  if (plan.ending === "stopped") record.stoppedBy = { code: "credential_rejected", message: "rejected" };
  if (plan.ending === "cancelled") {
    record.cancelReason = "the call was cancelled";
    record.controller.abort();
  }
  for (let index = 0; index < plan.count; index += 1) {
    if (record.results[index] !== undefined) continue;
    const skip: DecisionBatchItem = { index, ok: false, code: "skipped", message: "Skipped." };
    recordBatchItem(record, skip);
    written.push(skip);
  }
  record.state = plan.ending;
  record.finishedAt = plan.startedAt + plan.wallMs;
  return { record, written };
}

/** Every page for a filter, following nextFrom as the tab's Show more does. */
function readAll(record: DecisionBatchRecord, status: DecisionsRailItemFilter, limit: number, maxBytes: number, now: number) {
  const items: DecisionsRailItem[] = [];
  let from: number | undefined = 0;
  let pages = 0;
  while (from !== undefined) {
    const page = railBatchPage(record, { status, from, limit, now, maxBytes });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    if (page.nextFrom !== undefined) {
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.nextFrom).toBeGreaterThan(from);
    }
    items.push(...page.items);
    from = page.nextFrom;
    pages += 1;
    expect(pages).toBeLessThanOrEqual(record.count + 1);
  }
  return items;
}

describe("decision batch rail projection", () => {
  // Rule: the tab's counts and timing are what the batch's items say.
  // Oracle: a direct recount over the plan the batch was built from.
  it("counts, latency and throughput agree with a recount of the items", () => {
    fc.assert(fc.property(planArb, fc.integer({ min: 0, max: 60_000 }), (plan, afterStart) => {
      const { record } = buildBatch(plan);
      const now = plan.startedAt + afterStart;
      const batch = railBatch(record, now);
      const ran = plan.ending === "completed" ? plan.count : plan.ran;
      const finishedOutcomes = plan.order.slice(0, ran).map((index) => plan.outcomes[index]!);
      const oks = finishedOutcomes.filter((outcome) => outcome.ok);
      const skipped = plan.ending === "running" ? 0 : plan.count - ran;

      expect(batch.succeeded).toBe(oks.length);
      expect(batch.failed).toBe(finishedOutcomes.length - oks.length);
      expect(batch.skipped).toBe(skipped);
      expect(batch.finished).toBe(batch.succeeded + batch.failed + batch.skipped);
      expect(batch.finished).toBeLessThanOrEqual(batch.count);
      if (plan.ending !== "running") expect(batch.finished).toBe(batch.count);

      if (oks.length === 0) {
        expect(batch.latency).toBeUndefined();
      } else {
        const durations = oks.map((outcome) => outcome.durationMs);
        expect(batch.latency).toEqual({
          samples: durations.length,
          meanMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          maxMs: Math.max(...durations),
        });
      }

      const wall = plan.ending === "running" ? afterStart : plan.wallMs;
      expect(batch.wallMs).toBe(wall);
      if (wall > 0 && ran > 0) expect(batch.itemsPerSecond).toBeCloseTo(ran / (wall / 1000), 9);
      else expect(batch.itemsPerSecond).toBeUndefined();

      const firstModel = [...plan.outcomes.entries()]
        .filter(([index, outcome]) => outcome.ok && record.results[index]?.ok)
        .map(([, outcome]) => (outcome.ok ? outcome.model : undefined))
        .find((model) => model !== undefined);
      expect(batch.model).toBe(firstModel);
      expect(batch.stopping).toBe(false);
    }));
  });

  // Rule: paging through a filter yields exactly the finished items that
  // match it, in input order, each once, whatever the page size or byte
  // bound, and each filter's total is the count shown beside it.
  // Oracle: the record's items filtered directly.
  it("pages through every filter in input order, each item once", () => {
    fc.assert(fc.property(
      planArb,
      fc.integer({ min: 1, max: 7 }),
      fc.integer({ min: 1, max: 600 }),
      (plan, limit, maxBytes) => {
        const { record } = buildBatch(plan);
        const now = plan.startedAt + plan.wallMs;
        const batch = railBatch(record, now);
        const totals: Record<DecisionsRailItemFilter, number> = {
          all: batch.finished,
          succeeded: batch.succeeded,
          failed: batch.failed,
          skipped: batch.skipped,
        };
        for (const status of FILTERS) {
          const expected = record.results
            .filter((item): item is DecisionBatchItem => item !== undefined)
            .filter((item) => status === "all"
              || (status === "succeeded" && item.ok)
              || (status === "failed" && !item.ok && item.code !== "skipped")
              || (status === "skipped" && !item.ok && item.code === "skipped"))
            .map(railItem);
          const read = readAll(record, status, limit, maxBytes, now);
          expect(read).toEqual(expected);
          expect(read).toHaveLength(totals[status]);
        }
      },
    ));
  });

  describe("from a result file", () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "decision-rail-")); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    // Rule: a finished batch reads the same in the tab from memory and from
    // its result file after a restart, previews and latency included,
    // whatever order its items finished in.
    // Oracle: the in-memory record the file was written from.
    it("reads the same as the in-memory batch it was written from", async () => {
      await fc.assert(fc.asyncProperty(
        planArb.filter((plan) => plan.ending !== "running"),
        async (plan) => {
          const file = path.join(dir, `batch_rail-${Math.random().toString(36).slice(2)}.jsonl`);
          const { record, written } = buildBatch(plan, file);
          const writer = new DecisionBatchFileWriter(file, { keep: () => new Set(), onError: (error) => { throw error; } });
          writer.append(batchHeaderEntry(record));
          for (const item of written) writer.append(batchItemEntry(item));
          writer.append(batchEndEntry(record));
          await writer.settle();
          expect(writer.failed).toBe(false);

          const fromFile = await readDecisionBatchFile(file, CALLER);
          expect(fromFile).toBeDefined();
          const now = plan.startedAt + plan.wallMs + 1_000;
          expect(railBatch(fromFile!, now)).toEqual(railBatch(record, now));
          for (const status of FILTERS) {
            expect(railBatchPage(fromFile!, { status, from: 0, limit: 500, now }))
              .toEqual(railBatchPage(record, { status, from: 0, limit: 500, now }));
          }
          await rm(file, { force: true });
        },
      ), { numRuns: 40 });
    });
  });
});

describe("decision input preview", () => {
  // Rule: a preview is the start of the input's compact JSON, at most
  // DECISION_INPUT_PREVIEW_MAX_BYTES of UTF-8, cut only between
  // characters, and marked truncated exactly when something was cut.
  // Oracle: Buffer's UTF-8 byte count and JSON.stringify.
  it("keeps a whole-character prefix within the byte bound", () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.string({ unit: "grapheme", minLength: 0, maxLength: 1_500 }),
        fc.string({ unit: "binary", minLength: 500, maxLength: 3_000 }),
        fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ unit: "grapheme", maxLength: 400 }), { maxKeys: 8 }),
      ),
      (input) => {
        const full = JSON.stringify(input);
        fc.pre(!/\bsk-[A-Za-z0-9_-]{16,}/.test(full) && !/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(full));
        const preview = decisionInputPreview(input);
        expect(preview.inputRedacted).toBeUndefined();
        const text = preview.inputPreview!;
        expect(full.startsWith(text)).toBe(true);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DECISION_INPUT_PREVIEW_MAX_BYTES);
        expect(preview.inputTruncated === true).toBe(Buffer.byteLength(full) > DECISION_INPUT_PREVIEW_MAX_BYTES);
        // Never half a surrogate pair at the cut.
        const last = text.charCodeAt(text.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        if (preview.inputTruncated) {
          // The next character would not have fit.
          const next = String.fromCodePoint(full.slice(text.length).codePointAt(0)!);
          expect(Buffer.byteLength(text + next)).toBeGreaterThan(DECISION_INPUT_PREVIEW_MAX_BYTES);
        }
      },
    ));
  });

  it("keeps no preview of an input that looks like it holds a key", () => {
    expect(decisionInputPreview({ note: "use sk-test-0123456789abcdefghij please" })).toEqual({ inputRedacted: true });
    expect(decisionInputPreview("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toEqual({ inputRedacted: true });
    expect(decisionInputPreview({ title: "Sidebar flickers" })).toEqual({ inputPreview: "{\"title\":\"Sidebar flickers\"}" });
  });

  // Rule: decisions tools return what they did before previews existed;
  // the agent has its inputs and pays for every byte it reads.
  it("stays out of decisions_batch_results pages at both details", () => {
    fc.assert(fc.property(planArb, (plan) => {
      const { record } = buildBatch(plan);
      for (const detail of ["compact", "full"] as const) {
        const page = pageBatchResults(record, { from: 0, limit: 500, status: "all", detail });
        for (const item of page.results as Array<Record<string, unknown>>) {
          expect(item).not.toHaveProperty("inputPreview");
          expect(item).not.toHaveProperty("inputTruncated");
          expect(item).not.toHaveProperty("inputRedacted");
          expect(item).not.toHaveProperty("durationMs");
        }
      }
    }));
  });
});

describe("rail answers", () => {
  // Rule: a predicate shows the side the model leaned to, with that
  // side's probability, so the shown probability is never under one half.
  it("shows a predicate as the likelier of yes and no", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (probability) => {
      const answer = railAnswer({ type: "predicate", name: "relevant", probability });
      expect(answer.value).toBe(probability >= 0.5 ? "yes" : "no");
      expect(answer.probability).toBeGreaterThanOrEqual(0.5);
      expect(answer.probability).toBeCloseTo(Math.max(probability, 1 - probability), 12);
    }));
  });

  it("keeps a choice's value and confidence, and names what it cannot read", () => {
    expect(railAnswer({ type: "choice", name: "severity", choice: "medium", confidence: 0.71 }))
      .toEqual({ type: "choice", name: "severity", value: "medium", probability: 0.71 });
    expect(railAnswer({ type: "score", name: "risk", score: 2.345, confidence: 0.6 }))
      .toEqual({ type: "score", name: "risk", value: "2.35", probability: 0.6 });
    expect(railAnswer({ type: "unavailable", name: "x", reason: "no probability" }))
      .toEqual({ type: "unavailable", name: "x", reason: "no probability" });
    expect(railAnswer("odd")).toEqual({ type: "other", value: "\"odd\"" });
  });
});
