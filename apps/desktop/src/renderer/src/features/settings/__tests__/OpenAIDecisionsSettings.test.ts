import { expect, it } from "vitest";
import { openAIDecisionsKeyLabel } from "../OpenAIDecisionsSettings";

it("does not call a key from the environment a saved key", () => {
  expect(openAIDecisionsKeyLabel({ configured: false, source: "unset", writable: true })).toBe("No API key");
  expect(openAIDecisionsKeyLabel({ configured: true, source: "env", writable: false, overriddenByEnv: true }))
    .toBe("Key from environment");
  expect(openAIDecisionsKeyLabel({ configured: true, source: "keychain", writable: true })).toBe("Key saved");
});
