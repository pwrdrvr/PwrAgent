import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkEnvironment, checkRegistry, releaseMetadata } from "./release.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const candidate = (version) => ({ ...structuredClone(pkg), version,
  publishConfig: { ...pkg.publishConfig, tag: version.includes("-") ? "next" : "latest" } });
const registry = () => ({ name: "pwragent", maintainers: [{ name: "huntharo" }],
  "dist-tags": { latest: "0.0.0" }, versions: { "0.0.0": {} } });

test("Outpost uses the exact desktop version and desktop tag", () => {
  assert.deepEqual(releaseMetadata(candidate("0.1.0-alpha.1"), {
    tag: "v0.1.0-alpha.1", desktopVersion: "0.1.0-alpha.1",
  }), { version: "0.1.0-alpha.1", distTag: "next" });
  assert.equal(releaseMetadata(candidate("0.1.0")).distTag, "latest");
  for (const version of ["0.0.0", "0.0.0-alpha.1", "01.1.0", "1.0", "1.0.0-dev", "1.0.0-alpha.01", "1.0.0+build"]) {
    assert.throws(() => releaseMetadata(candidate(version)));
  }
  assert.equal(releaseMetadata(candidate("1.3.7-prerelease.1")).distTag, "next");
  assert.throws(() => releaseMetadata(pkg, { tag: `pwragent-v${pkg.version}` }));
  assert.throws(() => releaseMetadata(pkg, { desktopVersion: "99.0.0" }), /desktop version/);
  for (const version of ["0.1.0-alpha.1", "0.1.0"]) {
    const valid = candidate(version);
    const wrongTag = valid.publishConfig.tag === "next" ? "latest" : "next";
    assert.throws(() => releaseMetadata({ ...valid, publishConfig: { ...valid.publishConfig, tag: wrongTag } }));
  }
});

test("publishing requires the reviewed desktop-tag environment with admin bypass disabled", () => {
  const environment = { name: "npm-pwragent", protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true } };
  const policies = { branch_policies: [{ name: "v*", type: "tag" }] };
  checkEnvironment(environment, policies);
  assert.throws(() => checkEnvironment({ ...environment, protection_rules: [] }, policies));
  assert.throws(() => checkEnvironment({ ...environment, protection_rules: [{ type: "required_reviewers", reviewers: [] }] }, policies));
  assert.throws(() => checkEnvironment({ ...environment, deployment_branch_policy: null }, policies));
  assert.throws(() => checkEnvironment(environment, { branch_policies: [{ name: "*", type: "branch" }] }));
  assert.throws(() => checkEnvironment(environment, { branch_policies: [{ name: "main", type: "branch" }] }));
  assert.throws(() => checkEnvironment({ ...environment, can_admins_bypass: true }, policies));
  assert.throws(() => checkEnvironment(environment, { branch_policies: [...policies.branch_policies, { name: "*", type: "tag" }] }));
});

test("release validation permits only the pinned native PTY dependency and bundled JavaScript", () => {
  for (const change of [{ name: "other" }, { private: true }, { license: "UNLICENSED" },
    { engines: { node: ">=20" } }, { bin: { pwragent: "src/cli.js" } },
    { repository: { url: "https://example.com", directory: "packages/pwragent" } },
    { dependencies: { "@pwragent/federation": "workspace:*" } },
    { dependencies: {} }, { dependencies: undefined },
    { dependencies: { "node-pty": "*" } }, { dependencies: { "node-pty": "^1.2.0-beta.15" } },
    { dependencies: { "node-pty": "1.2.0-beta.14" } },
    { dependencies: { "node-pty": "1.2.0-beta.16" } },
    { dependencies: { ...pkg.dependencies, ws: "8.22.0" } },
    { bundleDependencies: undefined }, { bundleDependencies: [] },
    { bundleDependencies: ["node-pty", "ws"] },
    { optionalDependencies: { ws: "*" } }, { peerDependencies: { ws: "*" } }]) {
    assert.throws(() => releaseMetadata({ ...pkg, ...change }));
  }
});

test("registry preflight fails closed on ownership, incomplete metadata, duplicate versions and channel rollback", () => {
  const metadata = releaseMetadata(candidate("0.1.0-alpha.2"));
  checkRegistry(metadata, registry());
  for (const change of [{ name: "other" }, { maintainers: [{ name: "other" }] },
    { versions: undefined }, { versions: { "0.0.0": {}, [metadata.version]: {} } },
    { "dist-tags": {} }, { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } },
    { "dist-tags": { latest: "0.0.0", next: "0.1.0-alpha.3" } },
    { "dist-tags": { latest: "0.0.0", next: "0.1.0-beta.1" } }]) {
    assert.throws(() => checkRegistry(metadata, { ...registry(), ...change }));
  }
  checkRegistry(releaseMetadata(candidate("0.1.0-alpha.10")), {
    ...registry(), "dist-tags": { latest: "0.0.0", next: "0.1.0-alpha.9" },
    versions: { "0.0.0": {}, "0.1.0-alpha.9": {} },
  });
});

test("a maintenance branch publishes its matching version without rolling back newer global channels", () => {
  const metadata = releaseMetadata(candidate("1.2.3"));
  const document = { ...registry(), "dist-tags": { latest: "1.3.6" }, versions: { "1.3.6": {} } };
  assert.throws(() => checkRegistry(metadata, document), /advance/);
  assert.deepEqual(checkRegistry(metadata, document, { branch: "releases/1.2" }),
    { status: "unpublished", distTag: "release-1.2" });
  assert.deepEqual(checkRegistry(releaseMetadata(candidate("1.2.4-prerelease.1")), document, { branch: "releases/1.2" }),
    { status: "unpublished", distTag: "release-1.2-next" });
  assert.throws(() => checkRegistry(metadata, { ...document, versions: { ...document.versions, "1.2.4": {} },
    "dist-tags": { ...document["dist-tags"], "release-1.2": "1.2.4" } },
    { branch: "releases/1.2" }), /advance/);
});
