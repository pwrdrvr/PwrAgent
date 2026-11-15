import { once } from "node:events";
import { createServer } from "node:http";
import fc from "fast-check";
import { expect, it } from "vitest";
import { discoverModelCatalog } from "../codex-app-server/local-responses-bridge.mjs";

it("accepts an alias only when both metadata endpoints attest to the configured ID, regardless of the model path", async () => {
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^\/models\/[a-z]{1,16}\.gguf$/),
    fc.boolean(), fc.boolean(), fc.boolean(),
    async (modelPath, listed, matchingAlias, vision) => {
      const alias = "bonsai2-27b";
      const template = { models: [{ slug: alias, display_name: "PrismML Bonsai 2 27B", input_modalities: ["text"] }] };
      const original = structuredClone(template);
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/v1/models"
          ? { data: [{ id: listed ? alias : modelPath }] }
          : { model_alias: matchingAlias ? alias : "other", model_path: modelPath, modalities: { vision } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture needs a loopback port");
        const discovery = discoverModelCatalog(`http://127.0.0.1:${address.port}/v1`, template);
        if (listed && matchingAlias) {
          const result = await discovery;
          expect(result.models[0]).toEqual({
            ...template.models[0], input_modalities: vision ? ["text", "image"] : ["text"],
          });
        } else {
          await expect(discovery).rejects.toThrow("does not match the catalog model");
        }
        expect(template).toEqual(original);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  ), { numRuns: 50 });
});
