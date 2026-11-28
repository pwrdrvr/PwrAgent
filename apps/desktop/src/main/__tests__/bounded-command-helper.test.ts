import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openAIDecisionSafetyMaterial } from "@pwragent/shared/openai-decisions";
import type { TokenMiserGateProvider } from "@pwragent/shared/contracts/settings";
import type { BackendClient } from "../app-server/backend-registry-types";
import { boundedCommandHelper, type CaptureEvidence } from "../token-miser/bounded-command-helper";

const evidence: CaptureEvidence = { command: "git diff", exitCode: 0, bytes: 0, lines: 0, repeatedLines: 0,
  zeroTests: false, intent: "Check what changed", sample: "", detail: "" };

function fixture(gate: TokenMiserGateProvider, summarize: boolean) {
  const settings = {
    resolveTokenMiserGate: () => gate,
    resolveTokenMiserSummarizer: () => summarize ? "configured" as const : "off" as const,
    resolveDecisionModelSettings: () => ({ model: "off" as const, local: { model: "clef-test", endpoint: "http://localhost:8040" }, jev: { model: "jev-test" } }),
    resolveDecisionApiKey: vi.fn(async () => "synthetic"),
    resolveOpenAIDecisionsApiKey: vi.fn(async () => "synthetic-openai"),
    resolveOpenAIDecisionsSettings: () => ({ enabled: true }),
    resolveHelperModelSettings: () => ({ helpers: { token_miser_capture_codex: { backend: "claude", model: "haiku" } } }),
  };
  const claude = { generateStructuredObject: vi.fn(async (_request: Parameters<NonNullable<BackendClient["generateStructuredObject"]>>[0]) =>
    ({ status: "ok" as const, object: { summary: "Footer offset changed." } })) };
  const route = { origin: "codex" as const, threadId: "parent", claude, decisions: { profileId: "test", recordUsageLines: vi.fn() } };
  const run = (bytes: number) => boundedCommandHelper(settings, {}, undefined, route)?.enrich({ ...evidence, bytes }, new AbortController().signal);
  return { run, settings, claude, route };
}

it("routes every capture by the named scores, independently of size and response order", async () => {
  let miss = 0, need = 0, noise = 0;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ answers: [
    { type: "score", name: "noise", score: noise }, { type: "predicate", name: "miss", probability: miss },
    { type: "predicate", name: "summary", probability: need },
  ] }));
  try {
    for (const missed of [0, 0.699, 0.7, 1]) for (const needed of [0, 0.699, 0.7, 1]) for (const bytes of [0, 8191, 8192]) {
      miss = missed; need = needed; noise = bytes === 0 ? 0 : 1;
      const { run, claude } = fixture("openai", true);
      const result = await run(bytes);
      if (miss >= 0.7) expect(result).toContain("missed its mark");
      else if (need >= 0.7) expect(result).toContain("Footer offset changed.");
      else expect(result).toBeUndefined();
      expect(claude.generateStructuredObject).toHaveBeenCalledTimes(Number(miss < 0.7 && need >= 0.7));
    }
    expect(fetch).toHaveBeenCalledTimes(48);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.questions.map((q: { name: string }) => q.name).sort()).toEqual(["miss", "noise", "summary"]);
    expect(body.safety_identifier).toBe(createHash("sha256").update(openAIDecisionSafetyMaterial({
      backend: "codex", threadId: "parent", profileId: "test",
    })).digest("hex"));
    expect(JSON.stringify(body.input)).toContain("Check what changed");
  } finally { fetch.mockRestore(); }
});

it("only invokes an ungated summarizer for captures of at least 8192 bytes", async () => {
  const { run, claude } = fixture("none", true);
  expect(await run(8191)).toBeUndefined();
  expect(await run(8192)).toContain("Footer offset changed.");
  expect(claude.generateStructuredObject).toHaveBeenCalledTimes(1);
});

it("uses the issuing thread type's model and requires an explicit target for a different provider", async () => {
  const { settings, route, claude } = fixture("none", true);
  const scoped = { ...settings, resolveHelperModelSettings: () => ({ defaultModel: "mini",
    helpers: { token_miser_capture_antigravity: { backend: "claude", model: "haiku" },
      token_miser_capture_codex: { backend: "claude" } } }) };
  const helper = boundedCommandHelper(scoped, claude, undefined, { ...route, origin: "acp:antigravity" })!;
  await helper.enrich({ ...evidence, bytes: 8192 }, new AbortController().signal);
  expect(claude.generateStructuredObject).toHaveBeenCalledWith(expect.objectContaining({
    helper: "token_miser_capture_antigravity", model: "haiku", requireExactModel: true,
  }));
  for (const origin of ["claude", "codex"] as const) {
    expect(boundedCommandHelper(scoped, claude, undefined, { ...route, origin })).toBeUndefined();
  }
});

it.each(["jev", "local"] as const)("uses the selected %s model and endpoint for one multi-question gate", async gate => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ answers: {
    miss: { noul: 0.9 }, summary: { noul: 0.9 }, noise: { probabilities: { clear: 0.2, noisy: 0.8 } },
  } }));
  try {
    const { run, settings, claude } = fixture(gate, true);
    expect(await run(0)).toContain("missed its mark");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain(gate === "local" ? "localhost:8040" : "api.typesafe.ai");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).model).toBe(gate === "local" ? "clef-test" : "jev-test");
    expect(settings.resolveOpenAIDecisionsApiKey).not.toHaveBeenCalled();
    expect(claude.generateStructuredObject).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it("keeps the digest after missing, malformed or failed gate results and never retries a paid gate", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const { run, claude } = fixture("openai", true);
    for (const response of [Response.json({ answers: [] }), Response.json({ error: { code: "server_is_overloaded" } },
      { status: 503, headers: { "retry-after": "0" } })]) {
      fetch.mockResolvedValueOnce(response);
      expect(await run(10000)).toBeUndefined();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(claude.generateStructuredObject).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it("keeps excerpts within the UTF-8 budget and drops an insufficient summary", async () => {
  const { settings, route, claude } = fixture("none", true);
  const helper = boundedCommandHelper(settings, {}, undefined, route)!;
  const long = "界".repeat(15_000) + "private-tail-marker";
  claude.generateStructuredObject.mockResolvedValueOnce({ status: "ok", object: { summary: "" } });
  expect(await helper.enrich({ ...evidence, bytes: 8192, intent: long, detail: long }, new AbortController().signal)).toBeUndefined();
  expect(claude.generateStructuredObject).toHaveBeenCalledWith(expect.objectContaining({
    helper: "token_miser_capture_codex", model: "haiku", requireExactModel: true, disableExecution: true,
  }));
  const [request] = route.claude.generateStructuredObject.mock.calls[0]!;
  expect(Buffer.byteLength(request.prompt + request.system + JSON.stringify(request.schema))).toBeLessThan(4096);
  expect(request.prompt).not.toContain("private-tail-marker");
});

it("fails open on a slow gate even if the transport ignores cancellation and eventually recommends a summary", async () => {
  const late = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { started.resolve(); return late.promise; });
  const deadline = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  try {
    const { run, claude } = fixture("openai", true);
    const result = run(9000);
    await started.promise;
    deadline.abort();
    expect(await result).toBeUndefined();
    late.resolve(Response.json({ answers: [
      { type: "predicate", name: "miss", probability: 0 }, { type: "predicate", name: "summary", probability: 1 },
      { type: "score", name: "noise", score: 0.5 },
    ] }));
    await new Promise(resolve => setImmediate(resolve));
    expect(claude.generateStructuredObject).not.toHaveBeenCalled();
  } finally { timer.mockRestore(); fetch.mockRestore(); }
});

it("binds consent to the selected gate and model through both stages", async () => {
  const f = fixture("openai", true);
  const helper = boundedCommandHelper(f.settings, {}, undefined, f.route)!;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    vi.spyOn(f.settings, "resolveHelperModelSettings").mockReturnValue({
      helpers: { token_miser_capture_codex: { backend: "claude", model: "different-model" } },
    });
    return Response.json({ answers: [{ type: "predicate", name: "miss", probability: 0 },
      { type: "predicate", name: "summary", probability: 1 }, { type: "score", name: "noise", score: 1 }] });
  });
  try {
    expect(await helper.enrich(evidence, new AbortController().signal)).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.claude.generateStructuredObject).not.toHaveBeenCalled();
    vi.spyOn(f.settings, "resolveOpenAIDecisionsSettings").mockReturnValue({ enabled: false });
    expect(await f.run(16000)).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.claude.generateStructuredObject).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
