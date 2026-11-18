import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

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

test("desktop packaging requires Outpost validation and final success requires npm submission and verification", () => {
  assert.match(job("install-deps"), /needs:\n      - outpost-validate/);
  assert.match(job("outpost-validate"), /needs:\n      - release-preflight/);
  assert.match(job("outpost-validate"), /node: \["24"\]/);
  assert.match(job("outpost-validate"), /node packages\/pwragent\/scripts\/pack-check.mjs/);
  assert.match(job("outpost-publish"), /      - publish-release-notes/);
  assert.match(job("release-complete"), /      - outpost-validate/);
  assert.match(job("release-complete"), /      - publish-release-notes/);
  assert.match(job("release-complete"), /      - outpost-publish/);
  assert.match(job("release-complete"), /if: always\(\)/);
  assert.match(job("release-complete"), /SUBMISSION: \$\{\{ needs.outpost-publish.result \}\}/);
  assert.match(job("release-complete"), /OUTPOST_STATUS: \$\{\{ steps.verify.outputs.status \}\}/);
  assert.doesNotMatch(job("outpost-publish"), /continue-on-error|secrets\.|pnpm install|pnpm.*build/);
  assert.doesNotMatch(job("release-complete"), /continue-on-error|secrets\.|pnpm install|pnpm.*build/);
  assert.match(job("outpost-publish"), /environment: npm-pwragent/);
  assert.match(job("outpost-publish"), /permissions:\n      contents: read\n      actions: read\n      id-token: write/);
  assert.match(job("release-complete"), /permissions:\n      contents: read\n      actions: read\n      id-token: none/);
  assert.match(job("release-complete"), /node packages\/pwragent\/scripts\/publish.mjs --verify/);
  assert.match(job("outpost-publish"), /EXPECTED_INTEGRITY: \$\{\{ needs.outpost-validate.outputs.integrity \}\}/);
  assert.match(job("release-complete"), /EXPECTED_INTEGRITY: \$\{\{ needs.outpost-validate.outputs.integrity \}\}/);
  assert.match(job("release-preflight"), /OUTPOST_NPM_RELEASE_READY/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(job("outpost-publish"), /group: pwragent-npm-publication\n      queue: max\n      cancel-in-progress: false/);
  // Only the protected npm job may obtain an OIDC token. All source checkouts
  // use the event's immutable SHA, including workflow_dispatch retries.
  assert.equal(workflow.match(/id-token: write/g)?.length, 1);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github.event.inputs.tag \|\| github.ref \}\}/);
});

test("actual workflow steps gate verification on prerequisites and completion on verified npm evidence", (t) => {
  const steps = job("release-complete").split(/\n      - /);
  const shellFor = (name) => steps.find((step) => step.startsWith(`name: ${name}\n`)).split("        run: |\n")[1]
    .split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
  const root = mkdtempSync(path.join(tmpdir(), "release-complete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (shell, env, cwd) => spawnSync("bash", ["-e", "-c", shell], { encoding: "utf8", cwd,
    env: { ...process.env, ...env } });
  const summary = path.join(root, "summary.md");
  const prerequisite = shellFor("Require successful desktop publication and npm submission or recovery");

  // Submission success includes read-only recovery and only permits verification.
  const success = { PREFLIGHT: "success", PACKAGE: "success", DESKTOP: "success", SUBMISSION: "success" };
  assert.equal(run(prerequisite, success).status, 0);
  for (const name of Object.keys(success)) {
    for (const status of ["failure", "skipped", "cancelled", ""]) {
      const result = run(prerequisite, { ...success, [name]: status });
      assert.equal(result.status, 1, `${name}=${status}`);
      assert.match(result.stdout, /Shared release incomplete/);
    }
  }

  // Successful completion depends on the receipt status and on its upload.
  const pendingIndex = steps.findIndex((step) => step.startsWith("name: Retain pending npm receipt"));
  const verifiedIndex = steps.findIndex((step) => step.startsWith("name: Retain verified npm receipt"));
  const summaryIndex = steps.findIndex((step) => step.startsWith("name: Record shared release status"));
  assert.ok(pendingIndex >= 0 && verifiedIndex >= 0 && summaryIndex > pendingIndex && summaryIndex > verifiedIndex);
  assert.match(steps[pendingIndex], /outpost-release-pending-/);
  assert.match(steps[pendingIndex], /steps.verify.outputs.status == 'verification-pending'/);
  assert.match(steps[verifiedIndex], /steps.verify.outputs.status == 'verified-existing'/);
  const complete = shellFor("Record shared release status");
  const receipt = path.join(root, ".local", "outpost-release-receipt.json");
  mkdirSync(path.dirname(receipt));
  for (const status of ["verified-existing", "verification-pending", "accepted", "publish-uncertain", ""]) {
    writeFileSync(receipt, JSON.stringify({ status }));
    writeFileSync(summary, "");
    const result = run(complete, { OUTPOST_STATUS: status, GITHUB_STEP_SUMMARY: summary }, root);
    assert.equal(result.status, status === "verified-existing" ? 0 : 1, status);
    const report = readFileSync(summary, "utf8");
    assert.equal(report.includes("publication verified"), status === "verified-existing");
    assert.equal(report.includes("verification pending"), status === "verification-pending");
  }
});
