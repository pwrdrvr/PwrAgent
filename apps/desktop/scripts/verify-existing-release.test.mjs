import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyPublishedRelease } from "./verify-existing-release.mjs";

it("accepts a previously completed release only with the original byte inventory and notes", () => {
  const tag = "v1.4.21";
  const notes = "Release notes";
  const release = { tag_name: tag, name: tag, prerelease: true, draft: false, body: notes };
  const assets = ["installer", "metadata", "debug"].map((name, index) => ({
    name, state: "uploaded", size: index + 1, digest: `sha256:${String(index).repeat(64)}`,
  }));
  const expected = new Map(assets.map(({ name, size, digest }) => [name, { size, digest }]));
  expect(() => verifyPublishedRelease(release, assets.toReversed(), { tag, notes, expected })).not.toThrow();
  for (const asset of assets) {
    const others = assets.filter(({ name }) => name !== asset.name);
    expect(() => verifyPublishedRelease(release, others, { tag, notes, expected })).toThrow(/inventory/);
    for (const change of [{ size: 0 }, { digest: undefined }, { digest: "different" }, { state: "starter" }, { name: "other" }]) {
      expect(() => verifyPublishedRelease(release, [{ ...asset, ...change }, ...others], { tag, notes, expected })).toThrow();
    }
  }
  for (const change of [{ body: "" }, { draft: true }, { prerelease: false }, { tag_name: "v1.4.20" }]) {
    expect(() => verifyPublishedRelease({ ...release, ...change }, assets, { tag, notes, expected })).toThrow();
  }
});

it("checks existing release evidence on retries before reaching release creation", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
  const script = workflow.split("      - name: Create release and publish all platform assets")[1]
    .split("      - name: Upload assembled release artifacts")[0];
  expect(script).toMatch(/GITHUB_RUN_ATTEMPT" -gt 1[\s\S]*?FETCH_HEAD\^\{commit\}[\s\S]*?verify-existing-release\.mjs/);
  expect(script).toMatch(/verify-existing-release\.mjs[^\n]+; then\n\s+exit 0[\s\S]*?existing_status" -ne 4[\s\S]*?gh release create/);
});
