import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { OpenAIDecisionsError, OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Synthetic keys only. All requests go to an injected fetch.
const OPENAI_KEY = "sk-test-openai-decisions-batch-0123456789";
const JEV_KEY = "sk-test-jev-batch-0123456789abcdef";
const CALLER = { backend: "codex", threadId: "thread-a" };
const JEV_TARGET = { endpoint: "https://jev.test", model: "jev-latest", apiKey: JEV_KEY };

const PREDICATE = { instructions: "Is it a bar joke?", question: { type: "predicate", name: "bar" } };

let db: StateDb;
let usage: ThreadUsageLineRecord[];

beforeEach(() => {
  db = openInMemoryStateDb();
  usage = [];
});
afterEach(() => db.close());

function makeService(fetch: typeof globalThis.fetch, options: { usageFlushCount?: number } = {}) {
  return new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: async () => OPENAI_KEY,
    readSystemOneTarget: async (provider) => provider === "jev" ? JEV_TARGET : undefined,
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async (lines) => { usage.push(...lines); },
    fetch,
    endpoint: "https://openai.test/v1/decisions",
    ...(options.usageFlushCount ? { usageFlushCount: options.usageFlushCount } : {}),
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const OPENAI_OK = {
  model: "gpt-6-luna",
  answers: [{ type: "predicate", probability: 0.9 }],
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
    output_tokens: 0,
  },
};

async function errorOf(work: () => Promise<unknown>): Promise<OpenAIDecisionsError> {
  const error = await work().then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof OpenAIDecisionsError)) throw new Error(`expected OpenAIDecisionsError, got ${String(error)}`);
  return error;
}

describe("ad hoc decisions", () => {
  it.each(["jev", "openai"])("sends one Factory assessment per head to %s and refuses stale evidence before dispatch", async (provider) => {
    const requests: Array<Record<string, unknown>> = [];
    const service = makeService(async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)));
      const impact = { type: "choice", name: "impact", choice: "severe", probabilities: { severe: 1 } };
      const risk = { type: "choice", name: "regression_risk", choice: "unknown", probabilities: { unknown: 1 } };
      return json(provider === "jev"
        ? { model: "jev-latest", answers: {
          impact, evidence_coverage: { type: "choice", choice: "partial", probabilities: { partial: 1 } }, regression_risk: risk,
        } }
        : { ...OPENAI_OK, answers: [impact, { type: "score", name: "evidence_coverage", score: 1 }, risk] });
    });
    const definition = { provider, preset: "factory_pr_review_v1" };
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const packet = {
      pullRequest: "https://github.com/example/service/pull/12", baseSha, headSha,
      outcome: "Keep existing accounts readable after upgrade.", change: "Migrate the accounts table.",
      evidence: [{ kind: "test", headSha, reference: "ci/run/123", observation: "Upgrade test passed." }],
    };
    for (const count of [8, 16, 32]) {
      const input = { ...packet, evidence: Array.from({ length: count }, () => packet.evidence[0]) };
      const result = await service.invoke(CALLER, { definition, input, detail: "compact" });
      expect(result).toMatchObject({
        provider, name: definition.preset, answers: [
          { name: "impact", choice: "severe" }, { name: "evidence_coverage", score: 1 }, { name: "regression_risk", choice: "unknown" },
        ],
      });
    }
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const questions = request.questions as Array<{ name: string }> | Record<string, unknown>;
      expect(Array.isArray(questions) ? questions.map((q) => q.name) : Object.keys(questions))
        .toEqual(["impact", "evidence_coverage", "regression_risk"]);
    }
    const stale = { ...packet, evidence: [{ ...packet.evidence[0], headSha: baseSha }] };
    expect((await errorOf(() => service.invoke(CALLER, { definition, inputs: [packet, stale] }))).code).toBe("invalid_input");
    expect((await errorOf(() => service.invoke(CALLER, { definition, input: { ...packet, headSha: "main" } }))).code).toBe("invalid_input");
    const images = [{ type: "input_json", data: packet }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }];
    expect(await errorOf(() => service.invoke(CALLER, { definition, inputs: [packet, images] })))
      .toMatchObject({ code: "invalid_input", message: expect.stringContaining("inputs[1]") });
    expect((await errorOf(() => service.invoke(CALLER, { definition: { ...definition, prefix: "override" }, input: packet }))).code)
      .toBe("invalid_definition");
    expect(requests).toHaveLength(3);
  });

  it.each(["reference", "observation"])("rejects a whitespace-only %s before invoking a provider", async (field) => {
    const service = makeService(() => { throw new Error("unexpected provider request"); });
    const headSha = "1".repeat(40);
    const input = {
      pullRequest: "pr/123", headSha, baseSha: "2".repeat(40), outcome: "Open settings", change: "Fix focus",
      evidence: [{ kind: "ux", headSha, reference: "capture/12", observation: "Focus visible", [field]: " \t\n" }],
    };
    expect(await errorOf(() => service.invoke(CALLER, { definition: { preset: "factory_pr_review_v1" }, input })))
      .toMatchObject({ code: "invalid_input", message: expect.stringContaining(field) });
  });

  it("assesses an issue-linked branch before a PR exists and requires a complete identity", async () => {
    const requests: unknown[] = [];
    const service = makeService(async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)));
      return json(OPENAI_OK);
    });
    const input = {
      headSha: "a".repeat(40), baseSha: "b".repeat(40), outcome: "Open settings", change: "Fix focus", evidence: [],
    };
    const definition = { provider: "openai", preset: "factory_pr_review_v1" };
    const candidate = { issue: "PWR-123", repository: "github.com/example/app", branch: "fix/settings" };
    await service.invoke(CALLER, { definition, input: { ...input, candidate } });
    expect(JSON.stringify(requests)).toContain("PWR-123");
    for (const invalid of [input, { ...input, candidate: { ...candidate, repository: " " } }, { ...input, candidate: { issue: "PWR-123" } }]) {
      expect((await errorOf(() => service.invoke(CALLER, { definition, input: invalid }))).code).toBe("invalid_input");
    }
    expect(requests).toHaveLength(1);
  });

  it("runs a definition without registering it, with a stable cache key per definition", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const service = makeService(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return json(OPENAI_OK, 200, { "x-request-id": "req_adhoc" });
    });
    const definition = { provider: "openai", ...PREDICATE };
    const result = await service.invoke(CALLER, { definition, input: "A panda walks into a bar." });
    await service.invoke(CALLER, { definition, input: { joke: "another" } });
    await service.invoke(CALLER, { definition: { ...definition, instructions: "Is it funny?" }, input: "x" });
    expect(result).toMatchObject({ name: "ad_hoc", provider: "openai", requestId: "req_adhoc" });
    expect(bodies[0]).toMatchObject({
      model: "gpt-6-luna",
      questions: [{ type: "predicate", name: "bar", instructions: "Is it a bar joke?" }],
      input: [{ role: "user", content: [{ type: "input_text", text: "A panda walks into a bar." }] }],
    });
    expect(bodies[1]!.prompt_cache_key).toBe(bodies[0]!.prompt_cache_key);
    expect(bodies[2]!.prompt_cache_key).not.toBe(bodies[0]!.prompt_cache_key);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM openai_decision_versions").get()).toEqual({ n: 0 });
  });

  it("runs on Jev and checks inputs against an optional schema", async () => {
    let request: Record<string, unknown> | undefined;
    const service = makeService(async (url, init) => {
      expect(String(url)).toBe("https://jev.test/v1/systemone");
      request = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return json({ model: "jev-latest", answers: { bar: { noul: 0.7 } } });
    });
    const result = await service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE, inputSchema: { type: "string", maxLength: 10 } },
      input: "short",
    });
    expect(request).toMatchObject({ model: "jev-latest", state: "short" });
    expect(result).toMatchObject({ provider: "jev", answers: [{ type: "predicate", name: "bar", probability: 0.7 }] });
    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE, inputSchema: { type: "string", maxLength: 10 } },
      input: "far too long for it",
    }))).code).toBe("invalid_input");
  });

  it("refuses mixed targets and registration-only fields", async () => {
    let calls = 0;
    const service = makeService(async () => { calls += 1; return json(OPENAI_OK); });
    const definition = { provider: "openai", ...PREDICATE };
    expect((await errorOf(() => service.invoke(CALLER, { definition, name: "x", input: "a" }))).code).toBe("invalid_input");
    expect((await errorOf(() => service.invoke(CALLER, { definition: { ...definition, scope: "thread" }, input: "a" }))).code)
      .toBe("invalid_definition");
    expect((await errorOf(() => service.invoke(CALLER, { definition, input: 42 }))).code).toBe("invalid_input");
    expect(calls).toBe(0);
  });
});

describe("batches", () => {
  it("runs every item once at no more than the requested concurrency, returning results by index", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 40 }),
      fc.integer({ min: 1, max: 8 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 40, maxLength: 40 }),
      async (count, concurrency, delays) => {
        let inFlight = 0;
        let peak = 0;
        const seen: number[] = [];
        const service = makeService(async (_url, init) => {
          const index = Number(String((JSON.parse(String(init!.body)) as { state: string }).state).slice(5));
          seen.push(index);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delays[index]));
          inFlight -= 1;
          return json({ answers: { bar: { noul: index / 1000 } } });
        });
        const result = await service.invoke(CALLER, {
          definition: { provider: "jev", ...PREDICATE },
          inputs: Array.from({ length: count }, (_, index) => `item-${index}`),
          concurrency,
        }) as { results: Array<{ index: number; ok: boolean; answers?: Array<{ probability: number }> }>; succeeded: number };
        expect(result.succeeded).toBe(count);
        expect(result.results.map((item) => item.index)).toEqual(Array.from({ length: count }, (_, index) => index));
        result.results.forEach((item, index) => expect(item.answers![0]!.probability).toBe(index / 1000));
        expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, index) => index));
        expect(peak).toBeLessThanOrEqual(concurrency);
        if (count >= concurrency) expect(peak).toBe(concurrency);
      },
    ), { numRuns: 25 });
  });

  it("keeps going after an item fails but stops when the credential is rejected", async () => {
    let calls = 0;
    const mixed = makeService(async (_url, init) => {
      calls += 1;
      const text = String((JSON.parse(String(init!.body)) as { input: Array<{ content: Array<{ text: string }> }> })
        .input.at(-1)!.content[0]!.text);
      return text === "bad" ? json({ error: { code: "invalid_request", message: "nope" } }, 400) : json(OPENAI_OK);
    });
    const definition = { provider: "openai", ...PREDICATE };
    const result = await mixed.invoke(CALLER, { definition, inputs: ["a", "bad", "c"], concurrency: 2 }) as {
      results: Array<{ ok: boolean; code?: string }>; succeeded: number; failed: number;
    };
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.results[1]).toMatchObject({ ok: false, code: "upstream_error" });
    expect(calls).toBe(3);

    calls = 0;
    const rejected = makeService(async () => {
      calls += 1;
      return json({ error: { message: `bad key ${OPENAI_KEY}` } }, 401);
    });
    const stopped = await rejected.invoke(CALLER, {
      definition,
      inputs: Array.from({ length: 50 }, (_, index) => `item ${index}`),
      concurrency: 4,
    }) as { results: Array<{ ok: boolean; code?: string }>; stoppedBy?: { code: string } };
    expect(stopped.stoppedBy?.code).toBe("credential_rejected");
    expect(calls).toBeLessThanOrEqual(4);
    expect(stopped.results.filter((item) => item.code === "skipped")).toHaveLength(50 - calls);
    expect(JSON.stringify(stopped)).not.toContain(OPENAI_KEY);
  });

  it("keeps completed answers when one item fails unexpectedly", async () => {
    const service = makeService(async (_url, init) => {
      const state = String((JSON.parse(String(init!.body)) as { state: string }).state);
      // Not a Response: reading it throws a TypeError inside the request path.
      if (state === "item-1") return {} as Response;
      return json({ answers: { bar: { noul: 0.5 } } });
    });
    const result = await service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputs: ["item-0", "item-1", "item-2"],
      concurrency: 1,
    }) as { results: Array<{ ok: boolean; code?: string }>; succeeded: number };
    expect(result.succeeded).toBe(2);
    expect(result.results[1]).toMatchObject({ ok: false, code: "internal_error" });
  });

  it("stops scheduling when the call is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      return json({ answers: { bar: { noul: 0.5 } } });
    });
    const result = await service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputs: Array.from({ length: 30 }, (_, index) => `item-${index}`),
      concurrency: 1,
    }, controller.signal) as { results: Array<{ code?: string }> };
    expect(calls).toBe(3);
    expect(result.results.filter((item) => item.code === "skipped")).toHaveLength(27);
  });

  it("checks every input and the batch bounds before any request", async () => {
    let calls = 0;
    const service = makeService(async () => { calls += 1; return json(OPENAI_OK); });
    await service.register(CALLER, {
      name: "bar_joke",
      provider: "openai",
      ...PREDICATE,
      inputSchema: { type: "string", maxLength: 20 },
    });
    const bad = await errorOf(() => service.invoke(CALLER, { name: "bar_joke", inputs: ["ok", "also ok", "x".repeat(21)] }));
    expect(bad.code).toBe("invalid_input");
    expect(bad.message).toContain("inputs[2]");
    for (const args of [
      { name: "bar_joke", inputs: [] },
      { name: "bar_joke", inputs: Array.from({ length: 501 }, () => "a") },
      { name: "bar_joke", inputs: ["a"], concurrency: 9 },
      { name: "bar_joke", input: "a", concurrency: 2 },
      { name: "bar_joke", input: "a", inputs: ["a"] },
    ]) {
      expect((await errorOf(() => service.invoke(CALLER, args))).code).toBe("invalid_input");
    }
    const missing = await errorOf(() => service.invoke(CALLER, { name: "bar_joke" }));
    expect(missing.message).not.toContain("not both");
    expect(calls).toBe(0);
  });

  it("totals a batch's usage and writes its ledger lines in batches, not per item", async () => {
    const service = makeService(async () => json(OPENAI_OK), { usageFlushCount: 50 });
    const result = await service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      inputs: Array.from({ length: 120 }, (_, index) => `item ${index}`),
    }) as { usage: Record<string, unknown> };
    expect(result.usage).toMatchObject({
      inputTokens: 120_000,
      cachedTokens: 48_000,
      cacheWriteTokens: 12_000,
      priceStatus: "estimated",
      estimatedCostUsd: 0.00804,
      pricedItems: 120,
    });
    await service.flushUsage();
    expect(usage.reduce((sum, line) => sum + line.inputTokens, 0)).toBe(120_000);
    expect(usage.reduce((sum, line) => sum + line.totalCostMicros, 0)).toBe(120 * 67);
    expect(usage.length).toBeLessThanOrEqual(3);
  });
});
