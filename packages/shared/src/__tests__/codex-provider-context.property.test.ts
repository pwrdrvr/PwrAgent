import fc from "fast-check";
import { expect, it } from "vitest";
import { parseCodexProviderCatalogModel, validateCodexModelProviders } from "../codex-model-providers";

// Oracle: pinned llama-server get_res_model_info reports slot_n_ctx as meta.n_ctx;
// model_n_ctx_train is training capacity, never the active serving limit.
it("uses the active slot limit ahead of generic or training context metadata", () => {
  fc.assert(fc.property(fc.integer({ min: 1024, max: 2_000_000 }), fc.integer({ min: 1024, max: 2_000_000 }), (active, training) => {
    expect(parseCodexProviderCatalogModel({ id: "flint", context_window: training, context_length: training,
      meta: { n_ctx: active, n_ctx_train: training } })?.contextWindow).toBe(active);
  }));
});

it("discovers Flint's 262144 active tokens independently of training capacity", () => {
  expect(parseCodexProviderCatalogModel({ id: "flint", meta: { n_ctx: 262144, n_ctx_train: 1048576 } }))
    .toEqual({ id: "flint", contextWindow: 262144 });
});

it("keeps the smaller active slot when generic metadata advertises even one more token", () => {
  expect(parseCodexProviderCatalogModel({ id: "flint", context_window: 1025,
    meta: { n_ctx: 1024, n_ctx_train: 1025 } })?.contextWindow).toBe(1024);
});

it("rejects malformed limits without treating training context as serving context", () => {
  fc.assert(fc.property(fc.constantFrom(undefined, null, "65536", 0, -1, 1023, 2_000_001, 65536.5, Infinity, NaN), (invalid) => {
    expect(parseCodexProviderCatalogModel({ id: "flint", meta: { n_ctx: invalid, n_ctx_train: 1048576 } }))
      .toEqual({ id: "flint" });
    expect(parseCodexProviderCatalogModel({ id: "mathos", context_window: invalid, context_length: 65536 })?.contextWindow).toBe(65536);
  }));
});

it("round trips a provider cap independently of discovered metadata and other providers", () => {
  fc.assert(fc.property(fc.integer({ min: 1024, max: 2_000_000 }), (contextWindowCap) => {
    const provider = { id: "flint", baseUrl: "http://localhost:8080/v1", contextWindowCap,
      modelMetadata: [{ id: "flint", contextWindow: 262144 }] };
    const parsed = validateCodexModelProviders([provider, { id: "mathos", baseUrl: "https://mathos.example/v1" }]);
    expect(parsed[0]).toMatchObject(provider);
    expect(parsed[1]).not.toHaveProperty("contextWindowCap");
  }));
});

it("refuses invalid manual budgets rather than silently discarding them", () => {
  fc.assert(fc.property(fc.constantFrom(null, "65536", 0, -1, 1023, 2_000_001, 65536.5, Infinity, NaN), (contextWindowCap) => {
    expect(() => validateCodexModelProviders([{ id: "flint", baseUrl: "http://localhost:8080/v1", contextWindowCap }])).toThrow();
  }));
});
