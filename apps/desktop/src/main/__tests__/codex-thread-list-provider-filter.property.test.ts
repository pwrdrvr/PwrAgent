import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CodexModelProviderTranslator } from "../codex-app-server/codex-model-provider-translation";

/**
 * Codex's own `thread/list` provider filter, as `thread_processor.rs` applies
 * it: an omitted `modelProviders` lists only the threads recorded under the
 * configured default provider; an empty list lists every provider.
 */
function codexListsThread(
  params: Record<string, unknown>,
  threadProvider: string,
  defaultProvider: string,
): boolean {
  const filter = params.modelProviders;
  if (Array.isArray(filter)) return filter.length === 0 || filter.includes(threadProvider);
  if (typeof params.ancestorThreadId === "string") return true;
  return threadProvider === defaultProvider;
}

const providerId = fc.constantFrom("openai", "mathos", "refuseless", "ollama");
const listParams = fc.record({
  archived: fc.option(fc.boolean(), { nil: undefined }),
  cursor: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  limit: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
  searchTerm: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
}, { requiredKeys: [] });

describe("thread/list across Codex model providers", () => {
  it("lists every thread on a provider PwrAgent configured, whatever Codex's default", () => {
    fc.assert(fc.property(
      fc.uniqueArray(providerId, { minLength: 1, maxLength: 3 }),
      providerId,
      listParams,
      (configuredIds, defaultProvider, params) => {
        const configured = new Set(configuredIds);
        const translator = new CodexModelProviderTranslator(() => configured);
        const sent = translator.translateRequest("thread/list", params) as Record<string, unknown>;
        // The default provider's threads stay listed too.
        for (const threadProvider of [...configured, defaultProvider]) {
          expect(codexListsThread(sent, threadProvider, defaultProvider)).toBe(true);
        }
        // Nothing else in the request changes.
        const { modelProviders: _modelProviders, ...rest } = sent;
        expect(rest).toEqual(params);
      },
    ));
  });

  it("keeps a filter the caller chose, and Codex's default when PwrAgent configures no provider", () => {
    fc.assert(fc.property(listParams, providerId, (params, chosen) => {
      const translator = new CodexModelProviderTranslator(() => new Set(["mathos"]));
      const filtered = { ...params, modelProviders: [chosen] };
      expect(translator.translateRequest("thread/list", filtered)).toEqual(filtered);

      const none = new CodexModelProviderTranslator(() => new Set());
      expect(none.translateRequest("thread/list", params)).toEqual(params);
    }));
  });
});
