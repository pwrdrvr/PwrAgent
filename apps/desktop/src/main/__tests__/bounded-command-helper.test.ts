import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import type { BoundedCommandHelperMode } from "@pwragent/shared/contracts/settings";
import type { DesktopDecisionModelSettings } from "@pwragent/shared/decision-models";
import { boundedCommandHelper } from "../token-miser/bounded-command-helper";

it("routes only the explicit helper choice and accepts only a listed excerpt", async () => {
  let mode: BoundedCommandHelperMode = "deterministic";
  let decisions: DesktopDecisionModelSettings = { model: "jev" };
  const settings = {
    resolveTokenMiserBoundedHelper: () => mode, resolveDecisionModelSettings: () => decisions,
    resolveDecisionApiKey: vi.fn(async () => undefined),
  };
  const generate = vi.fn(async () => ({ status: "ok" as const, object: { choice: "1" } }));
  const codex = { generateStructuredObject: generate };
  const signal = new AbortController().signal;
  const select = () => boundedCommandHelper(settings, codex)?.select("git diff", ["left", "right"], signal);
  expect(select()).toBeUndefined();
  mode = "codex";
  await expect(select()).resolves.toBe(1);
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ helper: "token_miser_evaluation", disableExecution: true }));
  generate.mockResolvedValueOnce({ status: "ok", object: { choice: "unknown" } });
  await expect(select()).resolves.toBeUndefined();
  expect(settings.resolveDecisionApiKey).not.toHaveBeenCalled();
  mode = "decision";
  decisions = { model: "jev", jev: { enabled: false } };
  expect(select()).toBeUndefined();
  expect(settings.resolveDecisionApiKey).not.toHaveBeenCalled();
  decisions = { model: "jev" };
  await expect(select()).resolves.toBeUndefined();
  expect(settings.resolveDecisionApiKey).toHaveBeenCalledWith("jev");
  const requests: Array<{ path?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify({ answers: { q1: { choice: requests.length === 1 ? "0" : "invalid" } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback endpoint.");
    decisions = { model: "local", local: { endpoint: `http://127.0.0.1:${address.port}`, model: "fixture" } };
    await expect(select()).resolves.toBe(0);
    await expect(select()).resolves.toBeUndefined();
    expect(requests.map((r) => r.path)).toEqual(["/v1/systemone", "/v1/systemone"]);
    const body = JSON.parse(requests[0]!.body);
    expect(body.model).toBe("fixture");
    expect(JSON.parse(body.state)).toEqual({ command: "git diff", excerpts: ["left", "right"] });
    expect(generate).toHaveBeenCalledTimes(2);
    const selected = boundedCommandHelper(settings, codex)!;
    mode = "deterministic";
    await expect(selected.select("git diff", ["left", "right"], signal)).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  } finally {
    server.close();
    await once(server, "close");
  }
});

it("uses the explicitly selected Jev endpoint without registering a sidebar decision", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ answers: { q1: { choice: "1" } } }));
  try {
    const helper = boundedCommandHelper({
      resolveTokenMiserBoundedHelper: () => "decision",
      resolveDecisionModelSettings: () => ({ model: "jev", jev: { model: "fixture-model" } }),
      resolveDecisionApiKey: async () => "synthetic-key",
    }, {});
    await expect(helper!.select("git diff", ["first", "second"], new AbortController().signal)).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ Authorization: "Bearer synthetic-key" }),
    }));
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).model).toBe("fixture-model");
  } finally {
    fetch.mockRestore();
  }
});

it("sends only to the exact helper selected for this capture origin and invalidates changed selections", async () => {
  const codex = { generateStructuredObject: vi.fn(async () => ({ status: "ok" as const, object: { choice: "0" } })) };
  const claude = { generateStructuredObject: vi.fn(async () => ({ status: "ok" as const, object: { choice: "1" } })) };
  const row = { backend: "claude", model: "haiku", reasoningEffort: "low" };
  const settings = {
    resolveTokenMiserBoundedHelper: () => "configured" as const,
    resolveHelperModelSettings: () => ({ defaultModel: "fixture-mini", helpers: { token_miser_capture_antigravity: row } }),
    resolveDecisionModelSettings: () => ({}), resolveDecisionApiKey: vi.fn(),
  };
  const run = (origin: "codex" | "claude" | "acp:antigravity") => boundedCommandHelper(settings, codex, undefined,
    { origin, threadId: "parent", claude });
  const agy = run("acp:antigravity")!;
  expect(agy.label).toContain("haiku");
  expect(run("claude")).toBeUndefined();
  const signal = new AbortController().signal;
  await expect(agy.select("git diff", ["a", "b"], signal)).resolves.toBe(1);
  expect(claude.generateStructuredObject).toHaveBeenCalledWith(expect.objectContaining({
    helper: "token_miser_capture_antigravity", model: "haiku", reasoningEffort: "low", disableExecution: true,
  }));
  expect(codex.generateStructuredObject).not.toHaveBeenCalled();
  row.model = "sonnet";
  await expect(agy.select("git diff", ["a", "b"], signal)).resolves.toBeUndefined();
  expect(claude.generateStructuredObject).toHaveBeenCalledTimes(1);
  await expect(run("codex")!.select("git diff", ["a", "b"], signal)).resolves.toBe(0);
  expect(codex.generateStructuredObject).toHaveBeenCalledWith(expect.objectContaining({ model: "fixture-mini", requireExactModel: true }));
});

it.each(["jev", "local", "openai"] as const)("pins %s regardless of the profile default, with no sidebar registration", async (mode) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(mode === "openai"
    ? { answers: [{ type: "choice", name: "excerpt", choice: "1" }] } : { answers: { q1: { choice: "1" } } }));
  try {
    const settings = {
      resolveTokenMiserBoundedHelper: () => mode,
      resolveDecisionModelSettings: () => ({ model: "off" as const, local: { model: "clef-test", endpoint: "http://localhost:8040" },
        jev: { model: "jev-test" } }),
      resolveDecisionApiKey: vi.fn(async () => "synthetic-key"),
      resolveOpenAIDecisionsApiKey: vi.fn(async () => "synthetic-openai-key"),
      resolveOpenAIDecisionsSettings: () => ({ enabled: true }),
    };
    const helper = boundedCommandHelper(settings, {}, undefined, { origin: "claude", threadId: "parent", claude: {} });
    await expect(helper?.select("git diff", ["a", "b"], new AbortController().signal)).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toContain({ openai: "api.openai.com", local: "localhost:8040", jev: "api.typesafe.ai" }[mode]);
    expect(JSON.parse(String(options?.body)).model).toBe({ openai: "gpt-6-luna", jev: "jev-test", local: "clef-test" }[mode]);
    expect(settings.resolveOpenAIDecisionsApiKey).toHaveBeenCalledTimes(Number(mode === "openai"));
    expect(settings.resolveDecisionApiKey).toHaveBeenCalledTimes(Number(mode !== "openai"));
  } finally { fetch.mockRestore(); }
});
