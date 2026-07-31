import { describe, expect, it } from "vitest";
import { normalizeAsarListing } from "./asar-entry-paths.mjs";

describe("ASAR entry paths", () => {
  it("normalizes Windows separators for platform-independent checks", () => {
    const listing = normalizeAsarListing([
      "\\out\\grok-app-server\\index.mjs",
      "\\node_modules\\example\\src\\index.ts",
    ]);

    expect(listing).toEqual([
      "/out/grok-app-server/index.mjs",
      "/node_modules/example/src/index.ts",
    ]);
  });

  it("preserves POSIX entry paths", () => {
    const listing = normalizeAsarListing([
      "/out/grok-app-server/index.mjs",
    ]);

    expect(listing).toEqual([
      "/out/grok-app-server/index.mjs",
    ]);
  });
});
