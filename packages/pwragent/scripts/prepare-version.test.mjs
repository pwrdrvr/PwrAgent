import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareReleasePackages, releasePackageText } from "../../../scripts/prepare-release-version.mjs";

const desktop = JSON.parse(readFileSync(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"));
const outpost = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("version preparation changes only desktop/Outpost versions and the npm channel", () => {
  for (const version of ["1.3.7", "1.4.0-alpha.1", "1.4.0-beta.3", "1.3.7-prerelease.2", "1.3.7-rc.1"]) {
    const prepared = prepareReleasePackages(desktop, outpost, version);
    assert.deepEqual(prepared.desktop, { ...desktop, version });
    assert.deepEqual(prepared.outpost, { ...outpost, version,
      publishConfig: { ...outpost.publishConfig, tag: version.includes("-") ? "next" : "latest" } });
    assert.deepEqual(prepareReleasePackages(prepared.desktop, prepared.outpost), prepared);
  }
  assert.throws(() => prepareReleasePackages(desktop, outpost, "1.3.7-alpha.01"));
  assert.throws(() => prepareReleasePackages(desktop, outpost, "1.3.7+build"));
});

test("checked-in Outpost metadata matches the desktop authority", () => {
  assert.deepEqual(prepareReleasePackages(desktop, outpost), { desktop, outpost });
});

test("preparation preserves adjacent metadata and JSON escapes", () => {
  const text = '{\n  "version": "1.3.6",\n  "copyright": "Copyright \\u00a9",\n  "publishConfig": {\n    "tag": "latest"\n  }\n}\n';
  assert.equal(releasePackageText(text, { version: "1.4.0-alpha.1", publishConfig: { tag: "next" } }),
    text.replace('"1.3.6"', '"1.4.0-alpha.1"').replace('"latest"', '"next"'));
});
