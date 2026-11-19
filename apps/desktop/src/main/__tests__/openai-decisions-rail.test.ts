import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpenAIDecisionsError,
  OpenAIDecisionsService,
  type DecisionBatchCardReport,
} from "../openai-decisions/openai-decisions-service";
import type { RegisteredDecisionProvider } from "@pwragent/shared/openai-decisions";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Synthetic keys only. All requests go to an injected fetch.
const JEV_KEY = "sk-test-jev-rail-0123456789abcdef";
const CALLER = { backend: "codex", threadId: "thread-a" };
const OTHER = { backend: "codex", threadId: "thread-b" };
const JEV_TARGET = { endpoint: "https://jev.test", model: "jev-latest", apiKey: JEV_KEY };
const PREDICATE = { instructions: "Is it a bar joke?", question: { type: "predicate", name: "bar" } };
const JEV = { provider: "jev", ...PREDICATE };

let db: StateDb;
let dir: string;
let cards: DecisionBatchCardReport[];
let wakes: string[];

beforeEach(async () => {
  db = openInMemoryStateDb();
  dir = await mkdtemp(path.join(os.tmpdir(), "decision-rail-service-"));
  cards = [];
  wakes = [];
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeService(
  fetch: typeof globalThis.fetch,
  options: { idPrefix?: string; disabled?: RegisteredDecisionProvider[] } = {},
) {
  let batch = 0;
  return new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: async () => undefined,
    readSystemOneTarget: async (provider) => provider === "jev" ? JEV_TARGET : undefined,
    isProviderEnabled: (provider) => !(options.disabled ?? []).includes(provider),
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async () => undefined,
    reportBatch: async (report) => { cards.push(report); },
    wakeThread: async (_caller, wake) => { wakes.push(wake.batchId); },
    newBatchId: () => `${options.idPrefix ?? "rail"}-${(batch += 1)}`,
    batchResultsDirectory: (caller) => path.join(dir, caller.threadId),
    fetch,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function jevIndex(init: RequestInit | undefined): number {
  return Number(String((JSON.parse(String(init!.body)) as { state: string }).state).slice(5));
}

/** A fetch whose requests wait for a gate each, and reject when aborted. */
function gatedFetch() {
  const gates: Array<{ index: number; release: () => void; aborted: boolean }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const index = jevIndex(init);
    await new Promise<void>((resolve, reject) => {
      const gate = { index, release: resolve, aborted: false };
      gates.push(gate);
      init?.signal?.addEventListener("abort", () => {
        gate.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
    return json({ model: "jev-latest", answers: { bar: { noul: 0.9 } } });
  };
  return { fetch, gates };
}

const inputs = (count: number) => Array.from({ length: count }, (_, index) => `item-${index}`);

describe("Decisions tab: Stop and Cancel", () => {
  // Rule: Stop starts nothing more and keeps the answers already in flight;
  // Cancel aborts what is in flight. Neither wakes the thread.
  it("Stop lets requests in flight finish and skips the rest", async () => {
    const { fetch, gates } = gatedFetch();
    const service = makeService(fetch);
    const started = await service.invoke(CALLER, { definition: JEV, inputs: inputs(10), concurrency: 2, background: true }) as { batchId: string };
    await expect.poll(() => gates.length).toBe(2);

    expect(await service.operatorBatchAction(OTHER, started.batchId, "stop")).toEqual({ outcome: "not_running" });
    expect(await service.operatorBatchAction(CALLER, started.batchId, "stop")).toEqual({ outcome: "stopped" });
    const stopping = (await service.railSnapshot(CALLER)).batches[0]!;
    expect(stopping).toMatchObject({ state: "running", stopping: true });

    for (const gate of gates) gate.release();
    await expect.poll(async () => (await service.railSnapshot(CALLER)).batches[0]!.state).toBe("stopped");
    // The card's last write follows the state change.
    await expect.poll(() => cards.at(-1)?.status).toBe("failed");
    const batch = (await service.railSnapshot(CALLER)).batches[0]!;
    expect(gates.every((gate) => !gate.aborted)).toBe(true);
    expect(gates).toHaveLength(2);
    expect(batch).toMatchObject({ succeeded: 2, failed: 0, skipped: 8, stopping: false, stoppedBy: { code: "stopped_by_operator" } });
    expect(cards.at(-1)!.message).toContain("Stopped from the thread after 2 items; 8 skipped.");
    expect(wakes).toEqual([]);
  });

  it("Cancel aborts requests in flight", async () => {
    const { fetch, gates } = gatedFetch();
    const service = makeService(fetch);
    const started = await service.invoke(CALLER, { definition: JEV, inputs: inputs(10), concurrency: 2, background: true }) as { batchId: string };
    await expect.poll(() => gates.length).toBe(2);
    expect(await service.operatorBatchAction(CALLER, started.batchId, "cancel")).toEqual({ outcome: "cancelled" });
    const batch = (await service.railSnapshot(CALLER)).batches[0]!;
    expect(gates.every((gate) => gate.aborted)).toBe(true);
    expect(batch).toMatchObject({ state: "cancelled", succeeded: 0, cancelReason: "cancelled from the thread" });
    expect(await service.operatorBatchAction(CALLER, started.batchId, "cancel")).toEqual({ outcome: "not_running" });
    expect(wakes).toEqual([]);
  });

  it("a Stop after every item started stopped nothing: the batch completes and wakes its thread", async () => {
    const { fetch, gates } = gatedFetch();
    const service = makeService(fetch);
    const started = await service.invoke(CALLER, { definition: JEV, inputs: inputs(2), concurrency: 2, background: true }) as { batchId: string };
    await expect.poll(() => gates.length).toBe(2);
    expect(await service.operatorBatchAction(CALLER, started.batchId, "stop")).toEqual({ outcome: "stopped" });
    for (const gate of gates) gate.release();
    await expect.poll(() => wakes).toEqual([started.batchId]);
    expect((await service.railSnapshot(CALLER)).batches[0]).toMatchObject({ state: "completed", succeeded: 2 });
    expect((await service.railSnapshot(CALLER)).batches[0]!.stoppedBy).toBeUndefined();
  });
});

describe("Decisions tab: snapshot and items", () => {
  it("lists visible decisions with the provider's on/off state", async () => {
    const service = makeService(async () => json({}), { disabled: ["jev"] });
    // Registering on a disabled provider is refused, so register first on a
    // service where it is on.
    const on = makeService(async () => json({}));
    on.register(CALLER, { name: "triage", scope: "thread", provider: "jev", ...PREDICATE, inputSchema: { type: "object", properties: { title: { type: "string" } } } });
    on.register(CALLER, { name: "shared_rule", scope: "profile", provider: "jev", ...PREDICATE, inputSchema: { type: "string" } });
    on.register(OTHER, { name: "elsewhere", scope: "thread", provider: "jev", ...PREDICATE, inputSchema: { type: "string" } });
    const snapshot = await service.railSnapshot(CALLER);
    expect(snapshot.decisions.map((decision) => decision.name).sort()).toEqual(["shared_rule", "triage"]);
    expect(snapshot.decisions.find((decision) => decision.name === "triage")).toMatchObject({
      provider: "jev",
      providerDisabled: true,
      scope: "thread",
      version: 1,
      questions: [{ type: "predicate", name: "bar" }],
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    });
    expect(snapshot.batches).toEqual([]);
  });

  it("keeps a capped input preview and latency per item in the result file, and reads them back after a restart", async () => {
    const big = { title: "Crash on launch", body: "x".repeat(5_000) };
    const before = makeService(async (_url, init) => {
      const state = String((JSON.parse(String(init!.body)) as { state: unknown }).state);
      return state.includes("fail")
        ? json({ error: { message: "nope" } }, 400)
        : json({ model: "jev-latest", answers: { bar: { noul: 0.2 } } });
    }, { idPrefix: "before" });
    const result = await before.invoke(CALLER, {
      definition: { ...JEV, inputSchema: { type: "object" } },
      inputs: [big, { title: "fail please" }, { title: "Typo" }],
    }) as { batchId: string; resultsFile: string; results: Array<Record<string, unknown>> };
    // The tool result is unchanged: no previews or durations.
    for (const item of result.results) {
      expect(item).not.toHaveProperty("inputPreview");
      expect(item).not.toHaveProperty("durationMs");
    }
    const lines = (await readFile(result.resultsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const items = lines.filter((line) => line.type === "item");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(typeof item.durationMs).toBe("number");
      expect(Buffer.byteLength(String(item.inputPreview))).toBeLessThanOrEqual(2048);
    }
    expect(items.find((item) => item.index === 0)).toMatchObject({ inputTruncated: true });
    expect(items.find((item) => item.index === 1)).toMatchObject({ ok: false, inputPreview: "{\"title\":\"fail please\"}" });

    const after = makeService(async () => json({}), { idPrefix: "after" });
    const snapshot = await after.railSnapshot(CALLER);
    expect(snapshot.batches).toHaveLength(1);
    expect(snapshot.batches[0]).toMatchObject({
      batchId: result.batchId,
      state: "completed",
      succeeded: 2,
      failed: 1,
      skipped: 0,
      model: "jev-latest",
      hasResultsFile: true,
    });
    const failed = await after.railBatchPage(CALLER, { batchId: result.batchId, status: "failed", from: 0, limit: 50 });
    expect(failed.items).toEqual([expect.objectContaining({ index: 1, ok: false, inputPreview: "{\"title\":\"fail please\"}" })]);
    const succeeded = await after.railBatchPage(CALLER, { batchId: result.batchId, status: "succeeded", from: 0, limit: 50 });
    expect(succeeded.items.map((item) => item.answers)).toEqual([
      [{ type: "predicate", name: "bar", value: "no", probability: 0.8 }],
      [{ type: "predicate", name: "bar", value: "no", probability: 0.8 }],
    ]);
    expect(await after.railResultsFile(CALLER, result.batchId)).toBe(result.resultsFile);

    // Another thread can neither read nor open it.
    expect(await after.railResultsFile(OTHER, result.batchId)).toBeUndefined();
    const error = await after.railBatchPage(OTHER, { batchId: result.batchId, status: "all", from: 0, limit: 10 })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAIDecisionsError);
    expect((error as OpenAIDecisionsError).code).toBe("batch_not_found");
  });
});
