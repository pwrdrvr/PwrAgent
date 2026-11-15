import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateCodexModelProviders } from "../codex-model-providers";

describe("Bonsai alias compatibility properties", () => {
  it("recognizes the exact launcher alias on a single-model loopback provider without rewriting IDs or declaring pricing", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^gpu[a-z0-9_-]{0,12}$/),
      fc.constantFrom("localhost", "127.0.0.1", "[::1]"),
      fc.integer({ min: 1024, max: 65535 }),
      fc.boolean(),
      (id, host, port, local) => {
        const raw = { id, baseUrl: `http://${host}:${port}/v1`, models: ["bonsai2-27b"], local };
        const [provider] = validateCodexModelProviders([raw]);
        expect(provider.compatibility).toBe("bonsai");
        expect(provider.models).toEqual(raw.models);
        expect(provider.local === true).toBe(local);
        expect(raw).not.toHaveProperty("compatibility");
      },
    ));
  });

  it("does not infer compatibility for arbitrary aliases, remote endpoints, or multiple models", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9_-]{1,16}$/), (suffix) => {
      for (const fields of [
        { baseUrl: "http://localhost:8080/v1", models: [`bonsai2-27b-${suffix}`] },
        { baseUrl: "https://models.example/v1", models: ["bonsai2-27b"] },
        { baseUrl: "http://localhost:8080/v1", models: ["bonsai2-27b", `other-${suffix}`] },
      ]) {
        expect(validateCodexModelProviders([{ id: "gpu", ...fields }])[0]).not.toHaveProperty("compatibility");
      }
    }));
  });
});
