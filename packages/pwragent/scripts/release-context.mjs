import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkEnvironment, releaseMetadata } from "./release.mjs";

export function releaseSource(context, ancestors) {
  assert.equal(context.repository, "pwrdrvr/PwrAgent", "Only the upstream repository may publish");
  assert.ok(["push", "workflow_dispatch"].includes(context.eventName), "Only desktop release events may publish");
  const tag = `v${context.version}`;
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc|prerelease)\.(0|[1-9]\d*))?$/);
  assert.equal(context.ref, `refs/tags/${tag}`, "Dispatch release.yml on the exact desktop tag, never a branch or arbitrary ref");
  assert.equal(context.refProtected, "true", "Desktop release tags must be protected against unauthorized creation/replacement/deletion");
  assert.equal(context.workflowRef, `pwrdrvr/PwrAgent/.github/workflows/release.yml@refs/tags/${tag}`,
    "npm provenance must identify release.yml at the exact desktop tag");
  if (context.tag !== undefined && context.tag !== "") assert.equal(context.tag, tag, "Dispatch input must match its tag ref");
  assert.match(context.sha, /^[0-9a-f]{40}$/);
  assert.equal(context.workflowSha, context.sha, "Release workflow source must match the tagged application source SHA");
  assert.equal(context.head, context.sha, "Checkout must match the event's source SHA");
  assert.equal(context.tagCommit, context.sha, "Desktop tag moved or does not match the source SHA");
  const train = context.version.split(".").slice(0, 2).join(".");
  const maintenance = `releases/${train}`;
  const branch = ancestors.includes(maintenance) ? maintenance : "main";
  assert.ok(ancestors.includes(branch), "Desktop tag must belong to an approved release branch (main or matching releases/N.N)");
  return { tag, commit: context.sha, branch };
}

export function currentReleaseSource() {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const pkg = read("../package.json");
  const desktop = read("../../../apps/desktop/package.json");
  releaseMetadata(pkg, { desktopVersion: desktop.version });
  const env = process.env;
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const train = pkg.version.split(".").slice(0, 2).join(".");
  const branches = ["main", `releases/${train}`];
  const ancestors = branches.filter((branch) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${branch}`]);
    return result.status === 0;
  });
  return releaseSource({ repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF, refProtected: env.GITHUB_REF_PROTECTED, workflowRef: env.GITHUB_WORKFLOW_REF,
    sha: env.GITHUB_SHA, workflowSha: env.GITHUB_WORKFLOW_SHA,
    head: git("rev-parse", "HEAD"), tagCommit: git("rev-parse", `refs/tags/v${pkg.version}^{commit}`),
    tag: env.RELEASE_TAG, version: pkg.version }, ancestors);
}

export function releasePrerequisites(readiness, environment, policies) {
  assert.equal(readiness, "release.yml/npm-pwragent",
    "Operator must migrate npm trusted publishing to release.yml/npm-pwragent and set OUTPOST_NPM_RELEASE_READY; see docs/headless-npm-release.md");
  checkEnvironment(environment, policies);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = currentReleaseSource();
  if (process.argv.includes("--preflight")) {
    const read = (name) => JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/${name}`, "utf8"));
    releasePrerequisites(process.env.OUTPOST_NPM_RELEASE_READY, read("npm-environment.json"), read("npm-branches.json"));
  }
  console.log(JSON.stringify(source));
}
