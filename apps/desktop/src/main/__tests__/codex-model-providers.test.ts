import { describe, expect, it, vi } from "vitest";
import { validateCodexModelProviders, type CodexModelProviderSettings, type ThreadUsageLineRecord } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";
import { wrapCodexProviderUsageAttribution } from "../app-server/codex-provider-usage-attribution";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { codexModelProviderAccountKey } from "../usage-account-identity";

const refuseless: CodexModelProviderSettings = {
  id: "refuseless",
  name: "Refuseless",
  baseUrl: "https://api.refuseless.example/v1",
  models: ["glm-5.3-abliterated"],
  rates: [{ model: "glm-5.3-abliterated", inputPerMillion: 2, outputPerMillion: 3, cachedInputPerMillion: 0.35 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Codex model provider config", () => {
  const save = (existing: string, providers: CodexModelProviderSettings[]) => applyTomlEdits(
    existing,
    desktopSettingsPatchToEdits({ models: { codex: { providers } } }, parseTomlTables(existing, "test.toml")),
  );

  it("round trips providers and their rates and keeps the rest of the file", () => {
    const existing = "# Keep my configuration\n[models.codex]\nprofile = \"work\"\n";
    const local: CodexModelProviderSettings = {
      id: "bonsai",
      name: "Bonsai",
      baseUrl: "http://127.0.0.1:8080/v1",
      models: ["bonsai-2"],
      discoverModels: false,
      local: true,
    };
    const written = save(existing, [refuseless, local]);
    const parsed = parseDesktopSettingsToml(written, "test.toml");
    expect(parsed.models?.codex?.providers).toEqual([refuseless, local]);
    expect(parsed.models?.codex?.profile).toBe("work");
    expect(written).toContain("# Keep my configuration");
    // No key is ever written to config.toml.
    expect(written).not.toMatch(/api_key|env_key/u);

    const cleared = save(written, []);
    expect(cleared).not.toContain("providers");
    expect(cleared).not.toContain("provider_rates");
    expect(parseDesktopSettingsToml(cleared, "test.toml").models?.codex?.profile).toBe("work");
  });

  it("refuses a malformed provider in a write", () => {
    expect(() => save("", [{ ...refuseless, baseUrl: "ftp://example.com" }])).toThrow();
  });

  it("repairs the earlier Bonsai shape and preserves isolated runtime settings on save", () => {
    const [provider] = validateCodexModelProviders([{
      id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["/models/Bonsai.gguf"],
    }]);
    expect(provider.compatibility).toBe("bonsai");
    const configured = { ...provider, catalogPath: "/profiles/bonsai/models.json" };
    const written = save("# Keep\n", [refuseless, configured]);
    expect(parseDesktopSettingsToml(written, "test.toml").models?.codex?.providers).toEqual([refuseless, configured]);
    expect(written).toContain('catalog_path = "/profiles/bonsai/models.json"');
    expect(written).toContain("# Keep");
    expect(validateCodexModelProviders([refuseless])[0]).not.toHaveProperty("compatibility");
  });

  it.each([
    { baseUrl: "https://api.example/v1", models: ["Bonsai.gguf"], compatibility: "bonsai" },
    { baseUrl: "http://localhost:8080/v1", models: [], compatibility: "bonsai" },
    { baseUrl: "http://localhost:8080/v1", models: ["a", "b"], compatibility: "bonsai" },
    { baseUrl: "http://localhost:8080/v1", models: ["a"], compatibility: "unknown" },
    { baseUrl: "http://localhost:8080/v1", models: ["a"], catalogPath: "/tmp/storage.jsonl" },
  ])("rejects unsupported isolated runtime settings: %j", (fields) => {
    expect(() => validateCodexModelProviders([{ id: "fixture", ...fields }])).toThrow();
  });
});

describe("wrapCodexProviderUsageAttribution", () => {
  const line = { threadId: "t1", provider: "openai", model: "glm" } as ThreadUsageLineRecord;

  it("passes ordinary usage straight through, synchronously", () => {
    const upsertThreadUsageLine = vi.fn(async (_params: { line: ThreadUsageLineRecord }) => "written");
    const other = vi.fn(function (this: unknown) {
      return this;
    });
    const store = { upsertThreadUsageLine, other };
    const wrapped = wrapCodexProviderUsageAttribution(store, () => undefined);
    void wrapped.upsertThreadUsageLine({ line });
    expect(upsertThreadUsageLine).toHaveBeenCalledWith({ line });
    // Other members keep their receiver.
    expect(wrapped.other()).toBe(store);
  });

  it("rewrites provider usage before it is stored, single and batched", async () => {
    const upsertThreadUsageLine = vi.fn(async (_params: { line: ThreadUsageLineRecord }) => undefined);
    const upsertThreadUsageLines = vi.fn(async (_params: { lines: ThreadUsageLineRecord[] }) => undefined);
    const wrapped = wrapCodexProviderUsageAttribution(
      { upsertThreadUsageLine, upsertThreadUsageLines },
      (entry) => entry.threadId === "t1"
        ? Promise.resolve({ ...entry, provider: "refuseless" })
        : undefined,
    );
    await wrapped.upsertThreadUsageLine({ line });
    expect(upsertThreadUsageLine).toHaveBeenCalledWith({ line: { ...line, provider: "refuseless" } });
    const other = { ...line, threadId: "t2" };
    await wrapped.upsertThreadUsageLines({ lines: [line, other] });
    expect(upsertThreadUsageLines).toHaveBeenCalledWith({ lines: [{ ...line, provider: "refuseless" }, other] });
  });
});

describe("codexModelProviderAccountKey", () => {
  it("separates endpoints and keys and never contains the key", () => {
    const first = codexModelProviderAccountKey("https://api.refuseless.example/v1", "sk-one");
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(first).not.toContain("sk-one");
    expect(codexModelProviderAccountKey("https://api.refuseless.example/v2", "sk-one")).toBe(first);
    expect(codexModelProviderAccountKey("https://api.refuseless.example/v1", "sk-two")).not.toBe(first);
    expect(codexModelProviderAccountKey("https://other.example/v1", "sk-one")).not.toBe(first);
  });
});

describe("CodexModelProviderCatalog", () => {
  it("lists configured and discovered models as qualified options and caches discovery", async () => {
    let now = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.refuseless.example/v1/models");
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer sk-test");
      expect(init?.redirect).toBe("error");
      return jsonResponse({ data: [
        { id: "glm-5.3-abliterated" },
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        { id: "@bad/prefix" },
      ] });
    });
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [refuseless],
      resolveKeys: async () => ({ refuseless: "sk-test" }),
      fetch,
      now: () => now,
    });
    const options = await catalog.listModelOptions();
    expect(options).toEqual([
      expect.objectContaining({ id: "@refuseless/glm-5.3-abliterated", label: "glm-5.3-abliterated", providerId: "refuseless", providerLabel: "Refuseless" }),
      expect.objectContaining({ id: "@refuseless/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }),
    ]);
    await catalog.listModelOptions();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 11 * 60_000;
    await catalog.listModelOptions();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the listed models when the endpoint is down", async () => {
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [refuseless],
      resolveKeys: async () => ({}),
      fetch: async () => jsonResponse({ error: { message: "nope" } }, 503),
    });
    expect((await catalog.listModelOptions()).map((option) => option.id)).toEqual(["@refuseless/glm-5.3-abliterated"]);
  });

  it("does not call an endpoint whose discovery is off", async () => {
    const fetch = vi.fn();
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [{ ...refuseless, discoverModels: false }],
      resolveKeys: async () => ({}),
      fetch,
    });
    expect(await catalog.listModelOptions()).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tests /models and one short /responses request", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [],
      resolveKeys: async () => ({}),
      fetch: async (url, init) => {
        requests.push({ url, body: init?.body as string | undefined });
        return url.endsWith("/responses")
          ? jsonResponse({ error: { message: "Unknown endpoint" } }, 404)
          : jsonResponse({ data: [{ id: "glm-5.3-abliterated" }] });
      },
    });
    const result = await catalog.test(refuseless, "sk-test");
    expect(result.models).toEqual({ ok: true, count: 1 });
    expect(result.responses).toEqual({ ok: false, model: "glm-5.3-abliterated", error: "HTTP 404: Unknown endpoint" });
    expect(JSON.parse(requests[1].body ?? "{}")).toMatchObject({
      model: "glm-5.3-abliterated",
      instructions: expect.any(String),
      input: [
        { role: "developer", content: expect.any(String) },
        { role: "user", content: expect.any(String) },
      ],
      tools: [{ type: "namespace", name: "compatibility_check", tools: [{ type: "function", name: "check" }] }],
      max_output_tokens: 256,
      store: false,
    });
  });

  it("surfaces chat-template failures rather than treating /models as inference success", async () => {
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [],
      resolveKeys: async () => ({}),
      fetch: async (url, init) => {
        if (!url.endsWith("/responses")) return jsonResponse({ data: [{ id: "local-model" }] });
        const body = JSON.parse(String(init?.body));
        expect(body.instructions).toBeTruthy();
        expect(body.input[0].role).toBe("developer");
        expect(body.tools[0].type).toBe("namespace");
        return jsonResponse({ error: { message: "Jinja Exception: System message must be at the beginning." } }, 500);
      },
    });
    const result = await catalog.test({ ...refuseless, models: ["local-model"] }, undefined);
    expect(result.models.ok).toBe(true);
    expect(result.responses).toMatchObject({ ok: false, error: expect.stringContaining("System message must be at the beginning") });
  });

  it("accepts a completed regular OpenAI response with provider authentication", async () => {
    const provider = { ...refuseless, id: "openai-key", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"] };
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [],
      resolveKeys: async () => ({}),
      fetch: async (url, init) => {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer test-key");
        if (!url.endsWith("/responses")) return jsonResponse({ data: [{ id: "gpt-5.5" }] });
        expect(JSON.parse(String(init?.body)).model).toBe("gpt-5.5");
        return jsonResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] });
      },
    });
    expect((await catalog.test(provider, "test-key")).responses).toEqual({ ok: true, model: "gpt-5.5" });
  });

  it("tests Bonsai through its prepared bridge and always closes its resources", async () => {
    const close = vi.fn(async () => undefined);
    const prepareCompatibility = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:12345/v1", overrides: [], close }));
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [], resolveKeys: async () => ({}), prepareCompatibility,
      fetch: async (url) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        expect(url).toBe("http://127.0.0.1:12345/v1/responses");
        return jsonResponse({ error: { message: "fixture failure" } }, 500);
      },
    });
    const provider = { ...refuseless, id: "bonsai", compatibility: "bonsai" as const };
    expect((await catalog.test(provider, undefined)).responses.ok).toBe(false);
    expect(prepareCompatibility).toHaveBeenCalledWith(provider);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { error: { message: "failed" } },
    { status: "failed", output: [] },
    { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: " " }] }] },
  ])("does not report HTTP 200 as successful inference without completed text (%j)", async (response) => {
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [],
      resolveKeys: async () => ({}),
      fetch: async (url) => url.endsWith("/responses") ? jsonResponse(response) : jsonResponse({ data: [] }),
    });
    expect((await catalog.test(refuseless, undefined)).responses).toMatchObject({
      ok: false,
      error: expect.stringContaining("did not return a completed text response"),
    });
  });
});
