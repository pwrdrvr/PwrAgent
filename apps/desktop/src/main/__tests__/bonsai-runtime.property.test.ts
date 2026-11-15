import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { readBonsaiCatalog } from "../codex-app-server/bonsai-runtime";

it("the Bonsai adapter owns discovery while preserving every other supplied catalog field and source byte", async () => {
  const provider: CodexModelProviderSettings = {
    id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["bonsai2-27b"], compatibility: "bonsai",
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "bonsai-discovery-property-"));
  try {
    const catalogPath = path.join(directory, "models.json");
    const template = await readBonsaiCatalog(provider);
    await fc.assert(fc.asyncProperty(
      fc.option(fc.boolean(), { nil: undefined }), fc.string(), fc.string(),
      async (enabled, instructions, label) => {
        const model: (typeof template.models)[number] = {
          ...template.models[0], base_instructions: instructions, display_name: label,
        };
        if (enabled === undefined) delete model.supports_search_tool;
        else model.supports_search_tool = enabled;
        const catalog = { ...template, models: [model], user_metadata: { label } };
        const source = JSON.stringify(catalog, null, 2);
        await writeFile(catalogPath, source);
        expect(await readBonsaiCatalog({ ...provider, catalogPath })).toEqual({
          ...catalog, models: [{ ...model, supports_search_tool: true }],
        });
        expect(await readFile(catalogPath, "utf8")).toBe(source);
      },
    ), { numRuns: 30, examples: [[false, "Legacy instructions", "Custom Bonsai"], [undefined, "", ""]] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
