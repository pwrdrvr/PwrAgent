import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org";
const nativeRuntimeDependencies = { "node-pty": "1.2.0-beta.15" };

export function releaseMetadata(pkg, { tag, desktopVersion } = {}) {
  assert.equal(pkg.name, "pwragent");
  assert.equal(pkg.private, false);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=22");
  assert.equal(pkg.bin.pwragent, "bin/pwragent.js");
  assert.equal(pkg.repository.url, "git+https://github.com/pwrdrvr/PwrAgent.git");
  assert.equal(pkg.repository.directory, "packages/pwragent");
  assert.equal(pkg.publishConfig.registry, registry);
  assert.equal(pkg.publishConfig.access, "public");
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc|prerelease)\.(0|[1-9]\d*))?$/);
  assert.ok(!pkg.version.startsWith("0.0.0"), "The placeholder version cannot be released");
  const distTag = pkg.version.includes("-") ? "next" : "latest";
  assert.equal(pkg.publishConfig.tag, distTag, "publishConfig.tag must match the version channel");
  // JavaScript services are bundled by esbuild. The pinned native PTY package
  // must travel in the npm tarball, including its transitive native headers.
  assert.deepEqual(pkg.dependencies, nativeRuntimeDependencies, "Only the pinned native PTY dependency may ship");
  assert.deepEqual(pkg.bundleDependencies, ["node-pty"], "The native PTY dependency must be bundled in the tarball");
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.keys(pkg[field] || {}).length, 0, "Runtime dependencies must remain bundled");
  }
  if (tag !== undefined) assert.equal(tag, `v${pkg.version}`, "Desktop tag must match package version");
  if (desktopVersion !== undefined) assert.equal(pkg.version, desktopVersion, "Outpost must match the exact desktop version; run pnpm release:prepare");
  return { version: pkg.version, distTag };
}

function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc|prerelease)\.(\d+))?$/.exec(value);
    assert.ok(match, `Unsupported registry version ${value}; review the release policy`);
    return [Number(match[1]), Number(match[2]), Number(match[3]),
      match[4] ? ["alpha", "beta", "prerelease", "rc"].indexOf(match[4]) : 4, Number(match[5] || 0)];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function checkRegistry(metadata, document, expected, { verification = false } = {}) {
  assert.equal(document.name, "pwragent");
  assert.ok(document.maintainers?.some((owner) => owner.name === "huntharo"), "Expected npm owner huntharo; operator must resolve ownership");
  assert.ok(document.versions && typeof document.versions === "object", "Registry versions missing");
  const latest = document["dist-tags"]?.latest;
  assert.ok(latest && Object.hasOwn(document.versions, latest), "Registry latest version missing");
  const existing = document.versions[metadata.version];
  const pending = { status: "verification-pending", distTag: expected?.distTag ?? metadata.distTag };
  // A read after an attempted write cannot establish absence. Still reject
  // conflicting immutable identity and ownership before allowing any delay.
  if (verification && !existing) return pending;
  if (existing) {
    assert.ok(expected, "This immutable npm version is already published");
    assert.equal(existing.dist?.integrity, expected.integrity, "Occupied npm version has different bytes; restore the original tested artifact or cut a new desktop version");
    assert.deepEqual(existing.pwragentRelease, expected.source, "Occupied npm version has different source metadata");
    const predicateType = existing.dist?.attestations?.provenance?.predicateType;
    if (verification && !predicateType) return pending;
    assert.equal(predicateType, "https://slsa.dev/provenance/v1",
      "Published npm version is missing provenance; inspect npm before retrying");
  }
  if (verification && expected?.distTag) {
    const current = document["dist-tags"]?.[expected.distTag];
    if (!current || !Object.hasOwn(document.versions, current) || compareVersions(current, metadata.version) < 0) return pending;
    return { status: "verified-existing", distTag: expected.distTag };
  }
  let distTag = metadata.distTag;
  const train = metadata.version.split(".").slice(0, 2).join(".");
  const globalCurrent = document["dist-tags"]?.[distTag];
  // Maintenance trains must still ship, without rolling back a newer global
  // channel. Only a source validated against its matching maintenance branch
  // can use this channel; old commits on main cannot bypass rollback guards.
  if (!existing && expected?.branch === `releases/${train}`
      && [latest, globalCurrent].filter(Boolean).some((version) =>
        compareVersions(metadata.version, version) < 0 && !version.startsWith(`${train}.`))) {
    distTag = `release-${train}${metadata.distTag === "next" ? "-next" : ""}`;
  }
  const current = document["dist-tags"]?.[distTag];
  if (current) assert.ok(Object.hasOwn(document.versions, current), "Registry channel points to a missing version");
  if (existing) {
    const maintenanceTag = `release-${train}${metadata.distTag === "next" ? "-next" : ""}`;
    const maintenanceCurrent = document["dist-tags"]?.[maintenanceTag];
    if (expected.branch === `releases/${train}` && maintenanceCurrent && Object.hasOwn(document.versions, maintenanceCurrent)
        && compareVersions(maintenanceCurrent, metadata.version) >= 0) {
      return { status: "verified-existing", distTag: maintenanceTag };
    }
    if (verification && (!current || !Object.hasOwn(document.versions, current) || compareVersions(current, metadata.version) < 0)) return pending;
    assert.ok(current && Object.hasOwn(document.versions, current), "Published version has no valid channel; operator must reconcile npm channel state");
    assert.ok(compareVersions(current, metadata.version) >= 0, "Published version's npm channel was not advanced; operator must reconcile it");
    return { status: "verified-existing", distTag };
  }
  if (distTag === metadata.distTag) assert.ok(compareVersions(metadata.version, latest) > 0, "Release must advance the current latest version");
  if (current) assert.ok(compareVersions(metadata.version, current) > 0, "Release must advance its npm channel");
  return { status: "unpublished", distTag };
}

export function registryRetryDelay(headers, now = Date.now()) {
  const control = headers.get("cache-control") || "";
  const maxAge = /(?:^|,)\s*s-maxage=(\d+)/i.exec(control) || /(?:^|,)\s*max-age=(\d+)/i.exec(control);
  const age = Number(headers.get("age")) || 0;
  const cacheDelay = maxAge ? Math.max(0, Number(maxAge[1]) - age) * 1000 : 0;
  const retry = headers.get("retry-after");
  const retryDelay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now) || 0;
  return Math.max(cacheDelay, retryDelay);
}

export async function readPublicRegistrySnapshot() {
  const response = await fetch(`${registry}/pwragent`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, "npm ownership/version lookup failed; do not assume an absent package");
  return { document: await response.json(), retryAfterMs: registryRetryDelay(response.headers) };
}

export async function readPublicRegistry() {
  return (await readPublicRegistrySnapshot()).document;
}

export async function checkPublicRegistry(metadata, expected) {
  return checkRegistry(metadata, await readPublicRegistry(), expected);
}

export function checkEnvironment(environment, policies) {
  assert.equal(environment.name, "npm-pwragent");
  assert.ok(environment.protection_rules?.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0),
    "npm-pwragent must require reviewer approval before publishing");
  assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true,
    "npm-pwragent must restrict deployment branches");
  assert.equal(policies.total_count ?? policies.branch_policies?.length, 1, "npm-pwragent must have exactly one deployment rule");
  assert.equal(environment.can_admins_bypass, false, "npm-pwragent must disable administrator bypass");
  assert.deepEqual(policies.branch_policies?.map(({ name, type }) => ({ name, type })), [{ name: "v*", type: "tag" }],
    "Operator migration required: npm-pwragent must allow only the v* tag rule, not main; see docs/headless-npm-release.md");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const desktop = JSON.parse(readFileSync(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"));
  const metadata = releaseMetadata(pkg, { tag: process.env.RELEASE_TAG, desktopVersion: desktop.version });
  console.log(JSON.stringify(metadata));
}
