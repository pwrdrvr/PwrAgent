import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";

/**
 * The reasoning choices a provider's `GET /models` declares, read the way
 * Open Math OS documents them (`/v1/openapi.json`, 0.57.0):
 * `supported_reasoning_efforts` lists each model's choices from lower to
 * higher effort, `on`/`off` are a thinking switch rather than an effort,
 * `default_reasoning_effort` is the catalog default, and `input_modalities`
 * holds `image` exactly when the model takes images. Codex sends any effort
 * string as `reasoning.effort`, so every named level is offered as written.
 */
function oracle(entry: {
  supported_reasoning_efforts?: unknown[];
  default_reasoning_effort?: unknown;
  input_modalities?: string[];
}) {
  const efforts: string[] = [];
  for (const value of entry.supported_reasoning_efforts ?? []) {
    if (typeof value !== "string") continue;
    const effort = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/u.test(effort)) continue;
    if (effort.toLowerCase() === "on" || effort.toLowerCase() === "off") continue;
    if (!efforts.includes(effort) && efforts.length < 16) efforts.push(effort);
  }
  const fallback = typeof entry.default_reasoning_effort === "string" ? entry.default_reasoning_effort.trim() : "";
  return {
    supportsReasoning: efforts.length > 0,
    reasoningEfforts: efforts.length ? efforts : undefined,
    defaultReasoningEffort: efforts.includes(fallback) ? fallback : undefined,
    supportsImage: entry.input_modalities ? entry.input_modalities.includes("image") : undefined,
  };
}

const effortName = fc.oneof(
  fc.constantFrom("low", "medium", "high", "max", "xhigh", "ultramath", "minimal", "none"),
  fc.constantFrom("on", "off", "ON", " high ", "", "two words", "x".repeat(40)),
  fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/u),
);

const modelEntry = fc.record({
  supported_reasoning_efforts: fc.option(fc.array(fc.oneof(effortName, fc.integer()), { maxLength: 8 }), { nil: undefined }),
  default_reasoning_effort: fc.option(fc.oneof(effortName, fc.constant(null)), { nil: undefined }),
  input_modalities: fc.option(fc.subarray(["text", "image", "audio"]), { nil: undefined }),
}, { requiredKeys: [] });

const mathos: CodexModelProviderSettings = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1" };

function serving(entries: Array<Record<string, unknown>>) {
  return async (input: string) => input.startsWith(`${mathos.baseUrl}/models`)
    ? new Response(JSON.stringify({ object: "list", has_more: false, data: entries }))
    : new Response("{}", { status: 404 });
}

describe("a provider model's reasoning choices", () => {
  it("offers exactly the effort levels the endpoint declares, starting on its default", async () => {
    await fc.assert(fc.asyncProperty(fc.array(modelEntry, { minLength: 1, maxLength: 6 }), async (generated) => {
      const entries = generated.map((entry, index) => ({ id: `model-${index}`, object: "model", ...entry }));
      const catalog = new CodexModelProviderCatalog({
        resolveProviders: () => [mathos],
        resolveKeys: async () => ({}),
        fetch: serving(entries),
      });
      const options = await catalog.listModelOptions();
      expect(options.map((option) => option.id)).toEqual(entries.map((entry) => `@mathos/${entry.id}`));
      entries.forEach((entry, index) => {
        const expected = oracle(entry);
        const option = options[index]!;
        expect(option.supportsReasoning).toBe(expected.supportsReasoning);
        expect(option.reasoningEfforts).toEqual(expected.reasoningEfforts);
        expect(option.defaultReasoningEffort).toBe(expected.defaultReasoningEffort);
        expect(option.supportsImage).toBe(expected.supportsImage);
      });
    }), { numRuns: 120 });
  });

  it("shows Test connection the same choices it will offer", async () => {
    await fc.assert(fc.asyncProperty(fc.array(modelEntry, { minLength: 1, maxLength: 4 }), async (generated) => {
      const entries = generated.map((entry, index) => ({ id: `model-${index}`, object: "model", ...entry }));
      const catalog = new CodexModelProviderCatalog({
        resolveProviders: () => [mathos],
        resolveKeys: async () => ({}),
        fetch: serving(entries),
      });
      const result = await catalog.test({ ...mathos, discoverModels: true }, undefined);
      const options = await catalog.listModelOptions();
      expect(result.models.items?.map((item) => item.id)).toEqual(entries.map((entry) => entry.id));
      result.models.items!.forEach((item, index) => {
        expect(item.reasoningEfforts).toEqual(options[index]!.reasoningEfforts);
        expect(item.defaultReasoningEffort).toBe(options[index]!.defaultReasoningEffort);
      });
    }), { numRuns: 40 });
  });
});
