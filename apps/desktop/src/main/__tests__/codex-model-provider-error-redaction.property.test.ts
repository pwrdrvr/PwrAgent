import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";

/**
 * The rule: an error a provider's endpoint returns is published to every
 * window and to federated peers (`codexModelProviders[].error`) and shown in
 * Settings. Whatever the endpoint echoes of the key it was sent, whole,
 * truncated or masked, no 4-character run of that key may reach the
 * published text.
 */
const provider: CodexModelProviderSettings = { id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1" };
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-";

const apiKey = fc.string({
  unit: fc.constantFrom(...KEY_ALPHABET),
  minLength: 12,
  maxLength: 56,
});

/** The ways an endpoint has been seen to quote a key. */
const echo = (key: string) => fc.oneof(
  fc.constant(key),
  fc.integer({ min: 4, max: 8 }).map((n) => key.slice(0, n)),
  fc.integer({ min: 4, max: 8 }).map((n) => key.slice(-n)),
  fc.integer({ min: 4, max: 8 }).map((n) => `...${key.slice(-n)}`),
  fc.integer({ min: 4, max: 8 }).map((n) => `${key.slice(0, 4)}${"*".repeat(n)}${key.slice(-4)}`),
  fc.integer({ min: 1, max: 6 }).map((n) => `${key.slice(0, 3 + n)}…`),
);

const errorBody = apiKey.chain((key) => fc.tuple(
  fc.constant(key),
  echo(key),
  fc.constantFrom("Incorrect API key provided: ", "Invalid key ", "Unauthorized (", "bad token="),
  fc.constantFrom("", ".", ". Check it.", ") for this project"),
));

function fourGrams(key: string): string[] {
  return Array.from({ length: key.length - 3 }, (_, index) => key.slice(index, index + 4));
}

async function publishedError(key: string, message: string): Promise<string | undefined> {
  const catalog = new CodexModelProviderCatalog({
    resolveProviders: () => [provider],
    resolveKeys: async () => ({ mathos: key }),
    fetch: async () => new Response(JSON.stringify({ error: { message } }), { status: 401 }),
  });
  await catalog.listModelOptions();
  return catalog.catalogStates()[0].error;
}

describe("Codex model provider error redaction", () => {
  it("publishes no 4-character run of the provider's key, whatever form the endpoint echoes", async () => {
    await fc.assert(fc.asyncProperty(errorBody, async ([key, echoed, before, after]) => {
      const error = await publishedError(key, `${before}${echoed}${after}`);
      expect(error).toBeDefined();
      for (const gram of fourGrams(key)) expect(error).not.toContain(gram);
      expect(error!.length).toBeLessThanOrEqual(200);
    }), { numRuns: 200 });
  });

  it("leaves ordinary error text readable", async () => {
    await expect(publishedError("ZQ7xK2vN9pW4mR8t", "Incorrect API key provided. Check it."))
      .resolves.toBe("HTTP 401: Incorrect API key provided. Check it.");
    await expect(publishedError("ZQ7xK2vN9pW4mR8t", "Incorrect API key provided: ZQ7x****mR8t"))
      .resolves.toBe("HTTP 401: Incorrect API key provided: [key]");
  });
});
