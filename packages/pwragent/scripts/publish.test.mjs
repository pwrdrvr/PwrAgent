import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publishRelease } from "./publish.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = { tag: "v1.3.7", commit: "a".repeat(40) };
const bytes = Buffer.from("tested tarball fixture");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const input = () => ({ pkg: { ...structuredClone(pkg), version: "1.3.7", publishConfig: { ...pkg.publishConfig, tag: "latest" } },
  desktopVersion: "1.3.7", source, bytes, expectedIntegrity: integrity, npmVersion: "11.5.1",
  packed: { filename: "pwragent-1.3.7.tgz", version: "1.3.7", integrity, release: source },
  manifest: { ...structuredClone(pkg), version: "1.3.7", publishConfig: { ...pkg.publishConfig, tag: "latest" }, pwragentRelease: source } });
const registry = () => ({ name: "pwragent", maintainers: [{ name: "huntharo" }],
  versions: { "0.0.0": {} }, "dist-tags": { latest: "0.0.0" } });
const published = () => ({ ...registry(), "dist-tags": { latest: "1.3.7" }, versions: { "0.0.0": {}, "1.3.7": {
  pwragentRelease: source, dist: { integrity, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
} } });

test("publishes the tested bytes once and verifies registry postconditions before reporting success", async () => {
  let reads = 0;
  const calls = [];
  const result = await publishRelease(input(), {
    readRegistry: async () => ++reads === 1 ? registry() : published(),
    publish: async (filename, tag) => calls.push([filename, tag]),
  });
  assert.deepEqual(calls, [["pwragent-1.3.7.tgz", "latest"]]);
  assert.equal(result.status, "published");
  assert.equal(result.integrity, integrity);
  assert.equal(result.commit, source.commit);
});

test("an identical published version is a verified retry without any npm mutation", async () => {
  const result = await publishRelease(input(), { readRegistry: async () => published(),
    publish: async () => assert.fail("must not republish immutable version") });
  assert.equal(result.status, "verified-existing");
});

test("source, artifact, ownership, channel and OIDC prerequisites fail before publishing", async () => {
  for (const change of [{ bytes: Buffer.from("tampered") }, { expectedIntegrity: "sha512-other" },
    { desktopVersion: "1.3.8" }, { npmVersion: "11.5.0" },
    { packed: { ...input().packed, release: { ...source, commit: "b".repeat(40) } } },
    { manifest: { ...input().manifest, pwragentRelease: undefined } }]) {
    await assert.rejects(publishRelease({ ...input(), ...change }, { readRegistry: async () => registry(),
      publish: async () => assert.fail("invalid input published") }));
  }
  for (const change of [{ maintainers: [] }, { "dist-tags": {} },
    { versions: { "0.0.0": {}, "1.3.7": { pwragentRelease: source, dist: { integrity: "wrong" } } } }]) {
    await assert.rejects(publishRelease(input(), { readRegistry: async () => ({ ...registry(), ...change }),
      publish: async () => assert.fail("invalid registry published") }));
  }
});

test("an occupied version with different source or no provenance is never accepted as success", async () => {
  for (const change of [{ pwragentRelease: { ...source, commit: "b".repeat(40) } },
    { dist: { integrity } }, { dist: { integrity: "wrong", attestations: {} } }]) {
    const document = published();
    Object.assign(document.versions["1.3.7"], change);
    await assert.rejects(publishRelease(input(), { readRegistry: async () => document,
      publish: async () => assert.fail("must not overwrite") }));
  }
});

test("publish failure and an unconfirmed registry write reject without a success receipt", async () => {
  await assert.rejects(publishRelease(input(), { readRegistry: async () => registry(),
    publish: async () => { throw new Error("npm publish failed"); } }), /npm publish failed/);
  await assert.rejects(publishRelease(input(), { readRegistry: async () => registry(), publish: async () => {} }), /not visible/);
});
