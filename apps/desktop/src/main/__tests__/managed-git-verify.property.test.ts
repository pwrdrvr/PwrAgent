import fc from "fast-check";
import { expect, it } from "vitest";
import bundled from "../../../custom-git-runtime.json";
import { parseCustomGitCatalog } from "../managed-git-verify";

it("bases runtime compatibility on the manifest schema for every packaging script hash", () => {
  const parse = (catalog: typeof bundled) => parseCustomGitCatalog(JSON.stringify(catalog), {
    platform: "darwin",
    arch: "arm64",
  });
  const bundledAsset = parse(bundled).asset;
  fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
    const catalog = { ...bundled, consumer_sha256: Buffer.from(bytes).toString("hex") };
    expect(parse(catalog).asset).toEqual(bundledAsset);
    expect(() => parse({ ...catalog, schema: 2 })).toThrow(/manifest schema 2 requires a newer PwrAgent/);
  }));
});
