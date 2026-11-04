import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildModelMenu, type ModelMenuEntry } from "../model-menu";

/**
 * The oracle is the rule as `buildModelMenu`'s comment states it, written as
 * a table rather than as patterns: each Codex model names the models that
 * supersede it. A model a Codex model provider serves is never superseded,
 * whatever it is called.
 */
const GPT_6 = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"];
const CODEX_MODELS: Array<{ id: string; supersededBy: string[] }> = [
  { id: "gpt-5.4", supersededBy: [] },
  { id: "gpt-5.5", supersededBy: GPT_6 },
  { id: "gpt-5.5-codex", supersededBy: GPT_6 },
  { id: "gpt-5.6-sol", supersededBy: GPT_6 },
  { id: "gpt-5.6-terra", supersededBy: GPT_6 },
  { id: "gpt-5.6-luna", supersededBy: GPT_6 },
  { id: "gpt-6-astra", supersededBy: [] },
  { id: "gpt-6-sol", supersededBy: ["gpt-6.1-sol", "gpt-6.1-terra"] },
  { id: "gpt-6-luna", supersededBy: [] },
  { id: "gpt-6.1-sol", supersededBy: [] },
  { id: "gpt-6.1-terra", supersededBy: [] },
];

/** Provider models as main builds them: `@<provider>/<model>`. */
const PROVIDER_MODELS: ModelMenuEntry[] = [
  { id: "@bonsai/ternary-bonsai-27b", providerId: "bonsai", providerLabel: "PrismML Bonsai (local)" },
  { id: "@bonsai/ternary-bonsai-8b", providerId: "bonsai", providerLabel: "PrismML Bonsai (local)" },
  // Named like a superseded Codex model, but the provider's own.
  { id: "@openrouter/gpt-5.6-sol", providerId: "openrouter" },
  { id: "@openrouter/gpt-5.5", providerId: "openrouter" },
];

const codexCatalog = fc
  .shuffledSubarray(
    [...CODEX_MODELS.map(({ id }) => ({ id }) as ModelMenuEntry), ...PROVIDER_MODELS],
    { minLength: 1 },
  )
  .filter((models) => models.some((model) => !model.providerId));

const claudeCatalog = fc.uniqueArray(
  fc.record({ id: fc.constantFrom("opus", "sonnet", "haiku", "fable", "opus-4.7", "sonnet-4.6"), other: fc.boolean() }),
  { minLength: 1, selector: (model) => model.id },
);

function isSuperseded(model: ModelMenuEntry, catalog: readonly ModelMenuEntry[]): boolean {
  if (model.providerId) return false;
  const offered = new Set(catalog.filter((entry) => !entry.providerId).map((entry) => entry.id));
  const row = CODEX_MODELS.find((entry) => entry.id === model.id);
  return row?.supersededBy.some((id) => offered.has(id)) ?? false;
}

function expectedCodexMenu(catalog: readonly ModelMenuEntry[]) {
  const own = catalog.filter((model) => !model.providerId);
  const groups: Array<{ providerId: string; label: string; models: ModelMenuEntry[] }> = [];
  for (const model of catalog) {
    if (!model.providerId) continue;
    let group = groups.find((entry) => entry.providerId === model.providerId);
    if (!group) {
      group = { providerId: model.providerId, label: model.providerLabel ?? model.providerId, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return {
    primary: own.filter((model) => !isSuperseded(model, catalog)),
    other: own.filter((model) => isSuperseded(model, catalog)),
    providerGroups: groups,
  };
}

function listed(menu: ReturnType<typeof buildModelMenu>): ModelMenuEntry[] {
  return [...menu.primary, ...menu.other, ...menu.providerGroups.flatMap((group) => group.models)];
}

describe("model menu properties", () => {
  it("arranges any Codex catalog as its rule says", () => {
    fc.assert(fc.property(codexCatalog, (catalog) => {
      expect(buildModelMenu({ kind: "codex", models: catalog })).toEqual(expectedCodexMenu(catalog));
    }));
  });

  it("hides nothing and lists nothing twice", () => {
    fc.assert(fc.property(
      fc.oneof(
        codexCatalog.map((models) => ({ kind: "codex", models })),
        claudeCatalog.map((models) => ({ kind: "claude", models })),
      ),
      ({ kind, models }) => {
        const ids = listed(buildModelMenu({ kind, models })).map((model) => model.id);
        expect([...ids].sort()).toEqual(models.map((model) => model.id).sort());
      },
    ));
  });

  it("decides where a model goes from what is offered, not from the catalog's order", () => {
    fc.assert(fc.property(
      codexCatalog.chain((models) => fc.tuple(fc.constant(models), fc.shuffledSubarray(models, {
        minLength: models.length,
        maxLength: models.length,
      }))),
      ([models, reordered]) => {
        const sections = (catalog: ModelMenuEntry[]) => {
          const menu = buildModelMenu({ kind: "codex", models: catalog });
          return {
            primary: menu.primary.map((model) => model.id).sort(),
            other: menu.other.map((model) => model.id).sort(),
            providers: menu.providerGroups.map((group) => group.providerId).sort(),
          };
        };
        expect(sections(reordered)).toEqual(sections(models));
      },
    ));
  });

  it("puts a Claude model under Other exactly when Claude marks it", () => {
    fc.assert(fc.property(claudeCatalog, (catalog) => {
      const menu = buildModelMenu({ kind: "claude", models: catalog });
      expect(menu.primary).toEqual(catalog.filter((model) => !model.other));
      expect(menu.other).toEqual(catalog.filter((model) => model.other));
      expect(menu.providerGroups).toEqual([]);
    }));
  });

  it("offers an existing Codex thread only its own provider's models, arranged by the same rule", () => {
    fc.assert(fc.property(
      codexCatalog.chain((models) => fc.tuple(fc.constant(models), fc.constantFrom(...models))),
      ([catalog, threadModel]) => {
        const menu = buildModelMenu({ kind: "codex", models: catalog, thread: { model: threadModel.id } });
        const own = catalog.filter((model) => model.providerId === threadModel.providerId);
        expect(menu.providerGroups).toEqual([]);
        expect([...menu.primary, ...menu.other]).toEqual(expect.arrayContaining(own));
        expect(menu.primary.length + menu.other.length).toBe(own.length);
        // Superseded only by what this thread can switch to.
        expect(menu.other).toEqual(own.filter((model) => isSuperseded(model, own)));
      },
    ));
  });
});
