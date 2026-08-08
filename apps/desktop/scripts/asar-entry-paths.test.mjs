import { describe, expect, it } from "vitest";
import { normalizeAsarListing } from "./asar-entry-paths.mjs";

describe("ASAR entry paths", () => {
  it("normalizes Windows separators for platform-independent checks", () => {
    const listing = normalizeAsarListing([
      "\\out\\main\\index.js",
      "\\node_modules\\example\\src\\index.ts",
    ]);

    expect(listing).toEqual([
      "/out/main/index.js",
      "/node_modules/example/src/index.ts",
    ]);
  });

  it("preserves POSIX entry paths", () => {
    const listing = normalizeAsarListing([
      "/out/main/index.js",
    ]);

    expect(listing).toEqual([
      "/out/main/index.js",
    ]);
  });
});
