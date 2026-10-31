import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
const validation = readFileSync(new URL("../../../.github/workflows/publish-headless.yml", import.meta.url), "utf8");
const job = (name) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] || "";

test("ordinary pushes and PR/fork checks have no npm publication path", () => {
  assert.doesNotMatch(validation, /workflow_dispatch:|id-token: write|environment: npm-pwragent|npm publish/);
  assert.doesNotMatch(workflow, /^  pull_request(?:_target)?:|^  workflow_run:/m);
  const trigger = workflow.split("\n  push:\n")[1].split("\n  workflow_dispatch:")[0];
  assert.match(trigger, /tags:/);
  assert.doesNotMatch(trigger, /branches:/);
  const expression = job("outpost-publish").match(/^    if: (.+)$/m)?.[1];
  assert.ok(expression, "publish must have an explicit trusted-tag condition");
  const evaluate = (event, ref, repository = "pwrdrvr/PwrAgent") => runInNewContext(expression, {
    github: { event_name: event, ref, repository }, startsWith: (a, b) => a.startsWith(b),
  });
  assert.equal(evaluate("push", "refs/tags/v1.3.7"), true);
  assert.equal(evaluate("workflow_dispatch", "refs/tags/v1.3.7"), true);
  for (const event of ["pull_request", "pull_request_target", "workflow_run"]) assert.equal(evaluate(event, "refs/tags/v1.3.7"), false);
  assert.equal(evaluate("push", "refs/heads/main"), false);
  assert.equal(evaluate("push", "refs/tags/v1.3.7", "fork/PwrAgent"), false);
});

test("desktop packaging requires Outpost validation and final success requires npm publication", () => {
  assert.match(job("install-deps"), /needs:\n      - outpost-validate/);
  assert.match(job("outpost-validate"), /needs:\n      - release-preflight/);
  assert.match(job("outpost-validate"), /node: \["22", "24"\]/);
  assert.match(job("outpost-validate"), /node packages\/pwragent\/scripts\/pack-check.mjs/);
  assert.match(job("outpost-publish"), /      - publish-release-notes/);
  assert.match(job("release-complete"), /      - outpost-publish/);
  assert.match(job("release-complete"), /if: always\(\)/);
  assert.match(job("release-complete"), /needs.outpost-publish.result/);
  assert.doesNotMatch(job("outpost-publish"), /continue-on-error|secrets\.|pnpm install|pnpm.*build/);
  assert.match(job("outpost-publish"), /environment: npm-pwragent/);
  assert.match(job("outpost-publish"), /contents: read\n      id-token: write/);
  assert.match(job("outpost-publish"), /EXPECTED_INTEGRITY: \$\{\{ needs.outpost-validate.outputs.integrity \}\}/);
  assert.match(job("release-preflight"), /OUTPOST_NPM_RELEASE_READY/);
  assert.match(workflow, /cancel-in-progress: false/);
  // Only the protected npm job may obtain an OIDC token. All source checkouts
  // use the event's immutable SHA, including workflow_dispatch retries.
  assert.equal(workflow.match(/id-token: write/g)?.length, 1);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github.event.inputs.tag \|\| github.ref \}\}/);
});
