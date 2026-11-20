import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared/codex-model-providers";
import { readBonsaiCatalog } from "../codex-app-server/bonsai-runtime";
import { discoverModelCatalog } from "../codex-app-server/local-responses-bridge.mjs";

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

it("rebinds catalog identity only when the server identifies the old path and selected alias as the same model", async () => {
  let alias = "";
  let modelPath = "";
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/models"
      ? { data: [{ id: alias }] }
      : { model_alias: alias, model_path: modelPath, modalities: { vision: true } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const upstream = `http://127.0.0.1:${address.port}/v1`;
  try {
    await fc.assert(fc.asyncProperty(fc.nat(), fc.string(), async (suffix, instructions) => {
      alias = `bonsai-${suffix}`;
      modelPath = `/models/Bonsai-${suffix}.gguf`;
      const template = { models: [{ slug: modelPath, input_modalities: ["text"], base_instructions: instructions }] };
      expect(await discoverModelCatalog(upstream, template, undefined, alias)).toEqual({
        models: [{ ...template.models[0], slug: alias, input_modalities: ["text", "image"] }],
      });
      expect(template.models[0].slug).toBe(modelPath);
      await expect(discoverModelCatalog(upstream, template, undefined, `other-${suffix}`)).rejects.toThrow("does not match");
      await expect(discoverModelCatalog(upstream, {
        models: [{ ...template.models[0], slug: `/other/Bonsai-${suffix}.gguf` }],
      }, undefined, alias)).rejects.toThrow("does not match");
    }), { numRuns: 25 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
