import { describe, expect, it, vi } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";

/**
 * A disposable OpenAI-compatible `/models` endpoint per provider. Each serves
 * its own catalog, in pages when it has more than `pageSize` models, and
 * answers only to its own key.
 */
type FakeEndpoint = {
  baseUrl: string;
  key?: string;
  models?: string[];
  pageSize?: number;
  /** Report `has_more` forever, past the end of `models`. */
  endless?: boolean;
  status?: number;
  errorMessage?: string;
};

function fakeFetch(endpoints: FakeEndpoint[]) {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    requests.push({ url: input, ...(authorization ? { authorization } : {}) });
    const url = new URL(input);
    const endpoint = endpoints.find((candidate) => input.startsWith(`${candidate.baseUrl}/models`));
    if (!endpoint) return new Response("{}", { status: 404 });
    if (endpoint.status) {
      return new Response(JSON.stringify({ error: { message: endpoint.errorMessage ?? "failed" } }), { status: endpoint.status });
    }
    if (endpoint.key && authorization !== `Bearer ${endpoint.key}`) {
      return new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 });
    }
    const after = url.searchParams.get("after");
    const pageSize = endpoint.pageSize ?? endpoint.models?.length ?? 0;
    if (endpoint.endless) {
      const start = after ? Number(after.slice("m-".length)) + 1 : 0;
      const data = Array.from({ length: pageSize }, (_, index) => ({ id: `m-${start + index}`, object: "model" }));
      return new Response(JSON.stringify({ object: "list", data, has_more: true, last_id: data.at(-1)!.id }));
    }
    const models = endpoint.models ?? [];
    const start = after ? models.indexOf(after) + 1 : 0;
    const page = models.slice(start, start + pageSize);
    const hasMore = start + pageSize < models.length;
    return new Response(JSON.stringify({
      object: "list",
      data: page.map((id) => ({ id, object: "model" })),
      ...(endpoint.pageSize ? { has_more: hasMore, ...(page.length ? { last_id: page.at(-1) } : {}) } : {}),
    }));
  });
  return { fetch, requests };
}

const mathos: CodexModelProviderSettings = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1" };
const refuseless: CodexModelProviderSettings = {
  id: "refuseless",
  name: "Refuseless",
  baseUrl: "https://api.refuseless.example/v1",
  models: ["gpt-oss-120b"],
};

describe("CodexModelProviderCatalog catalogs", () => {
  it("lists a provider's whole catalog across pages", async () => {
    const models = Array.from({ length: 450 }, (_, index) => `mathos-model-${index}`);
    const { fetch, requests } = fakeFetch([{ baseUrl: mathos.baseUrl, key: "mathos-key", models, pageSize: 100 }]);
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos],
      resolveKeys: async () => ({ mathos: "mathos-key" }),
      fetch,
    });
    const options = await catalog.listModelOptions();
    expect(options.map((option) => option.id)).toEqual(models.map((model) => `@mathos/${model}`));
    expect(requests).toHaveLength(5);
    expect(requests[1].url).toBe(`${mathos.baseUrl}/models?after=mathos-model-99`);
    expect(catalog.catalogStates()).toEqual([
      { id: "mathos", name: "MathOS", status: "ready", listedCount: 0, discoveredCount: 450 },
    ]);
  });

  it("lists a large single-page catalog past 200 models", async () => {
    const models = Array.from({ length: 640 }, (_, index) => `m-${index}`);
    const { fetch } = fakeFetch([{ baseUrl: mathos.baseUrl, models }]);
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos],
      resolveKeys: async () => ({}),
      fetch,
    });
    expect(await catalog.listModelOptions()).toHaveLength(640);
  });

  it("stops at its model limit and says the catalog has more", async () => {
    const { fetch, requests } = fakeFetch([{ baseUrl: mathos.baseUrl, models: [], pageSize: 100, endless: true }]);
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos],
      resolveKeys: async () => ({}),
      fetch,
    });
    expect(await catalog.listModelOptions()).toHaveLength(2_000);
    expect(requests.length).toBeLessThanOrEqual(20);
    expect(catalog.catalogStates()[0]).toMatchObject({ status: "ready", discoveredCount: 2_000, truncated: true });
  });

  it("keeps two providers' identical model ids apart and reads each with its own key and URL", async () => {
    const { fetch, requests } = fakeFetch([
      { baseUrl: mathos.baseUrl, key: "mathos-key", models: ["gpt-oss-120b", "mathos-coder"] },
      { baseUrl: refuseless.baseUrl, key: "refuseless-key", models: ["gpt-oss-120b"] },
    ]);
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos, refuseless],
      resolveKeys: async () => ({ mathos: "mathos-key", refuseless: "refuseless-key" }),
      fetch,
    });
    const options = await catalog.listModelOptions();
    expect(options.map((option) => [option.id, option.label, option.providerLabel])).toEqual([
      ["@mathos/gpt-oss-120b", "gpt-oss-120b", "MathOS"],
      ["@mathos/mathos-coder", "mathos-coder", "MathOS"],
      ["@refuseless/gpt-oss-120b", "gpt-oss-120b", "Refuseless"],
    ]);
    for (const request of requests) {
      const key = request.url.startsWith(mathos.baseUrl) ? "mathos-key" : "refuseless-key";
      expect(request.authorization).toBe(`Bearer ${key}`);
    }
  });

  it("reports a failed read truthfully, keeps the listed models, and never returns the key", async () => {
    const { fetch } = fakeFetch([
      { baseUrl: mathos.baseUrl, status: 401, errorMessage: "Incorrect API key provided: sk-live-ABCDEFGH1234. Check it." },
      { baseUrl: refuseless.baseUrl, status: 503, errorMessage: "upstream unavailable for sk-live-ABCDEFGH1234" },
    ]);
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos, refuseless, { ...refuseless, id: "listed", name: "Listed", discoverModels: false }],
      resolveKeys: async () => ({ mathos: "sk-live-ABCDEFGH1234", refuseless: "sk-live-ABCDEFGH1234" }),
      fetch,
    });
    const options = await catalog.listModelOptions();
    expect(options.map((option) => option.id)).toEqual(["@refuseless/gpt-oss-120b", "@listed/gpt-oss-120b"]);
    const states = catalog.catalogStates();
    expect(states).toEqual([
      { id: "mathos", name: "MathOS", status: "unavailable", listedCount: 0, error: "HTTP 401: Incorrect API key provided: [key]. Check it." },
      { id: "refuseless", name: "Refuseless", status: "unavailable", listedCount: 1, error: "HTTP 503: upstream unavailable for [key]" },
      { id: "listed", name: "Listed", status: "off", listedCount: 1 },
    ]);
    expect(JSON.stringify(states)).not.toContain("ABCDEFGH");
  });

  it("offers only the listed models after a later read fails, then recovers", async () => {
    let now = 0;
    let down = false;
    const fetch = vi.fn(async () => down
      ? new Response(JSON.stringify({ error: { message: "maintenance" } }), { status: 503 })
      : new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }, { id: "mathos-coder" }] })));
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [{ ...mathos, models: ["gpt-oss-120b"] }],
      resolveKeys: async () => ({}),
      fetch,
      now: () => now,
    });
    expect(await catalog.listModelOptions()).toHaveLength(2);
    down = true;
    now += 11 * 60_000;
    expect((await catalog.listModelOptions()).map((option) => option.id)).toEqual(["@mathos/gpt-oss-120b"]);
    expect(catalog.catalogStates()[0]).toMatchObject({ status: "unavailable", error: "HTTP 503: maintenance" });
    down = false;
    now += 2 * 60_000;
    expect(await catalog.listModelOptions()).toHaveLength(2);
    expect(catalog.catalogStates()[0]).toMatchObject({ status: "ready", discoveredCount: 2 });
  });

  it("reports a provider as pending before its first read", () => {
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos],
      resolveKeys: async () => ({}),
      fetch: vi.fn(),
    });
    expect(catalog.catalogStates()).toEqual([{ id: "mathos", name: "MathOS", status: "pending", listedCount: 0 }]);
  });

  it("stops paging when an endpoint repeats a page", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "same" }], has_more: true, last_id: "same" })));
    const catalog = new CodexModelProviderCatalog({
      resolveProviders: () => [mathos],
      resolveKeys: async () => ({}),
      fetch,
    });
    expect((await catalog.listModelOptions()).map((option) => option.id)).toEqual(["@mathos/same"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
