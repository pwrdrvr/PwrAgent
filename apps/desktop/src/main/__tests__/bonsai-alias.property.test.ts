import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";
import { readBonsaiCatalog } from "../codex-app-server/bonsai-runtime";
import { parseDesktopSettingsToml, desktopSettingsPatchToEdits } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { codexModelProviderImportsFromConfig } from "../settings/codex-model-provider-import";
import { parseCodexConfigToml } from "../settings/codex-config-toml";

const providerId = fc.stringMatching(/^gpu[a-z0-9_-]{0,12}$/);
const aliasProvider = (id: string): CodexModelProviderSettings => ({
  id, name: "Local GPU", baseUrl: "http://localhost:8080/v1", models: ["bonsai2-27b"],
  compatibility: "bonsai", local: true,
});

describe("Bonsai alias catalog properties", () => {
  it("keeps the short protocol ID and friendly name in the private catalog", async () => {
    await fc.assert(fc.asyncProperty(providerId, async (id) => {
      expect((await readBonsaiCatalog(aliasProvider(id))).models[0]).toMatchObject({
        slug: "bonsai2-27b", display_name: "PrismML Bonsai 2 27B",
      });
    }), { numRuns: 30 });
  });

  it("keeps the short protocol ID and friendly name in the picker with or without discovery", async () => {
    await fc.assert(fc.asyncProperty(
      providerId,
      fc.boolean(),
      async (id, discoverModels) => {
        const provider = { ...aliasProvider(id), discoverModels };
        const catalog = new CodexModelProviderCatalog({
          resolveProviders: () => [provider], resolveKeys: async () => ({}),
          fetch: async () => new Response(JSON.stringify({ data: [{ id: "bonsai2-27b" }] })),
        });
        expect(await catalog.listModelOptions()).toEqual([expect.objectContaining({
          id: `@${id}/bonsai2-27b`, label: "PrismML Bonsai 2 27B",
        })]);
      },
    ), { numRuns: 30 });
  });

  it("imports and round trips the alias, catalog path, and explicit local pricing IDs without migrating historical IDs", () => {
    fc.assert(fc.property(providerId, (id) => {
      const [candidate] = codexModelProviderImportsFromConfig(parseCodexConfigToml([
        `model_provider = "${id}"`, 'model = "bonsai2-27b"', 'model_catalog_json = "models.json"',
        `[model_providers.${id}]`, 'base_url = "http://localhost:8080/v1"',
      ].join("\n")), { label: "Fixture", configPath: "/fixtures/config.toml" });
      expect(candidate).toMatchObject({ models: ["bonsai2-27b"], compatibility: "bonsai", local: true });
      const localModelIds = ["/models/Bonsai.gguf", "bonsai2-27b", `@${id}/bonsai2-27b`];
      const providers = [{ ...aliasProvider(id), catalogPath: "/fixtures/models.json" }];
      const source = "# Keep profile settings\n[models.codex]\nprofile = 'work'\n";
      const written = applyTomlEdits(source, desktopSettingsPatchToEdits({
        models: { codex: { providers, localModelIds } },
      }, parseTomlTables(source, "fixture.toml")));
      expect(parseDesktopSettingsToml(written, "fixture.toml").models?.codex).toMatchObject({
        profile: "work", providers, localModelIds,
      });
    }), { numRuns: 30 });
  });
});
