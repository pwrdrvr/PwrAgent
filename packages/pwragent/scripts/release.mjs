import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org";

export function releaseMetadata(pkg, { tag, confirmation } = {}) {
  assert.equal(pkg.name, "pwragent");
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=22");
  assert.equal(pkg.bin.pwragent, "bin/pwragent.js");
  assert.equal(pkg.repository.url, "git+https://github.com/pwrdrvr/PwrAgent.git");
  assert.equal(pkg.repository.directory, "packages/pwragent");
  assert.equal(pkg.publishConfig.registry, registry);
  assert.equal(pkg.publishConfig.access, "public");
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/);
  assert.ok(!pkg.version.startsWith("0.0.0"), "The placeholder version cannot be released");
  const distTag = pkg.version.includes("-") ? "next" : "latest";
  assert.equal(pkg.publishConfig.tag, distTag, "publishConfig.tag must match the version channel");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.keys(pkg[field] || {}).length, 0, "Runtime dependencies must remain bundled");
  }
  if (tag !== undefined) assert.equal(tag, `pwragent-v${pkg.version}`, "CLI tag must match package version");
  if (confirmation !== undefined) assert.equal(confirmation, `publish pwragent@${pkg.version}`, "Explicit publish confirmation required");
  return { version: pkg.version, distTag };
}

function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(value);
    assert.ok(match, `Unsupported registry version ${value}; review the release policy`);
    return [Number(match[1]), Number(match[2]), Number(match[3]),
      match[4] ? ["alpha", "beta", "rc"].indexOf(match[4]) : 3, Number(match[5] || 0)];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function checkRegistry(metadata, document) {
  assert.equal(document.name, "pwragent");
  assert.ok(document.maintainers?.some((owner) => owner.name === "huntharo"), "Expected npm owner huntharo; operator must resolve ownership");
  assert.ok(document.versions && typeof document.versions === "object", "Registry versions missing");
  assert.ok(!Object.hasOwn(document.versions, metadata.version), "This immutable npm version is already published");
  const latest = document["dist-tags"]?.latest;
  assert.ok(latest && Object.hasOwn(document.versions, latest), "Registry latest version missing");
  assert.ok(compareVersions(metadata.version, latest) > 0, "Release must advance the current latest version");
  const current = document["dist-tags"]?.[metadata.distTag];
  if (current) assert.ok(compareVersions(metadata.version, current) > 0, "Release must advance its npm channel");
}

export async function checkPublicRegistry(metadata) {
  const response = await fetch(`${registry}/pwragent`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, "npm ownership/version lookup failed; do not assume an absent package");
  checkRegistry(metadata, await response.json());
}

export function checkEnvironment(environment, policies) {
  assert.equal(environment.name, "npm-pwragent");
  assert.ok(environment.protection_rules?.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0),
    "npm-pwragent must require reviewer approval before publishing");
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true,
    "npm-pwragent must restrict deployment branches");
  assert.deepEqual(policies.branch_policies?.map(({ name, type }) => ({ name, type })), [{ name: "main", type: "branch" }],
    "npm-pwragent must allow only the main branch");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const metadata = releaseMetadata(pkg, { tag: process.env.RELEASE_TAG, confirmation: process.env.RELEASE_CONFIRMATION });
  if (process.env.RELEASE_TAG) await checkPublicRegistry(metadata);
  console.log(JSON.stringify(metadata));
}
