import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { requiresReadOnlyRecovery } from "./release-context.mjs";
import { checkedTarballIntegrity, retainedPackageArtifacts } from "./tested-package.mjs";

const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
const validation = readFileSync(new URL("../../../.github/workflows/publish-headless.yml", import.meta.url), "utf8");
const job = (name) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] || "";

test("a failed history lookup leaves the rerun eligible for read-only verification", (t) => {
  const restore = job("outpost-publish").split(/\n      - /)
    .find((step) => /^name: Restore any prior npm publication attempt/m.test(step));
  const shell = restore.split("        run: |\n")[1].split("\n")
    .filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
  const root = mkdtempSync(path.join(tmpdir(), "npm-history-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "packages/pwragent/scripts");
  mkdirSync(scripts, { recursive: true });
  const output = path.join(root, "output");
  const history = path.join(scripts, "check-npm-submission-history.mjs");
  writeFileSync(path.join(scripts, "restore-publication-receipt.mjs"), "");

  for (const exitCode of [0, 1, 2, 127]) {
    writeFileSync(output, "");
    writeFileSync(history, exitCode === 0
      ? 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.GITHUB_OUTPUT, "prior-submissions-skipped=true\\n");'
      : `process.exit(${exitCode});`);
    const result = spawnSync("bash", ["-c", shell], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, `history command exit ${exitCode}`);
    const proof = readFileSync(output, "utf8").includes("prior-submissions-skipped=true");
    assert.equal(requiresReadOnlyRecovery("push", "2", proof), exitCode !== 0);
    if (exitCode !== 0) assert.match(result.stdout, /warning.*read-only recovery/i);
  }
});

test("ordinary pushes and PR/fork checks have no npm publication path", () => {
  assert.doesNotMatch(validation, /workflow_dispatch:|id-token: write|environment: npm-pwragent|npm publish/);
  assert.doesNotMatch(workflow, /^  (?:pull_request(?:_target)?|workflow_run|workflow_dispatch):/m);
  const trigger = workflow.split("\n  push:\n")[1].split("\npermissions:")[0];
  assert.match(trigger, /tags:/);
  assert.doesNotMatch(trigger, /branches:/);
  const expression = job("outpost-publish").match(/^    if: (.+)$/m)?.[1];
  assert.ok(expression, "publish must have an explicit trusted-tag condition");
  const evaluate = (event, ref, repository = "pwrdrvr/PwrAgent") => runInNewContext(expression, {
    github: { event_name: event, ref, repository }, startsWith: (a, b) => a.startsWith(b),
  });
  assert.equal(evaluate("push", "refs/tags/v1.3.7"), true);
  assert.equal(evaluate("workflow_dispatch", "refs/tags/v1.3.7"), false);
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
  assert.match(job("outpost-publish"), /PRIOR_NPM_SUBMISSIONS_SKIPPED: \$\{\{ steps.restore-submission.outputs.prior-submissions-skipped \}\}/);
  assert.match(job("release-complete"), /EXPECTED_INTEGRITY: \$\{\{ needs.outpost-validate.outputs.integrity \}\}/);
  assert.match(job("release-preflight"), /OUTPOST_NPM_RELEASE_READY/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(job("outpost-publish"), /group: pwragent-npm-publication\n      queue: max\n      cancel-in-progress: false/);
  // Only the protected npm job may obtain an OIDC token. All source checkouts
  // use the event's immutable SHA, including reruns of the original tag push.
  assert.equal(workflow.match(/id-token: write/g)?.length, 1);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github.event.inputs.tag \|\| github.ref \}\}/);
});

test("packaging recovery leaves registry reads to completion and cannot replace the tested artifact", () => {
  const packing = readFileSync(new URL("./pack-check.mjs", import.meta.url), "utf8");
  assert.match(packing, /if \(!requiresReadOnlyRecovery\(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_RUN_ATTEMPT\)\) \{\s*await checkPublicRegistry\(/);
  const validate = job("outpost-validate");
  assert.match(validate, /name: headless-npm-package/);
  assert.doesNotMatch(validate, /overwrite: true/);
});

test("the original run restores both retained artifacts and preserves the independent byte identity", () => {
  const pkg = { name: "headless-npm-package", id: 17, expired: false };
  const digest = { name: "headless-npm-integrity", id: 16, expired: false };
  const unrelated = { name: "signing-evidence", id: 18, expired: true };
  assert.deepEqual(retainedPackageArtifacts([unrelated]), {});
  assert.deepEqual(retainedPackageArtifacts([digest]), { integrity: "16" });
  assert.deepEqual(retainedPackageArtifacts([pkg, unrelated, digest]), { package: "17", integrity: "16" });
  for (const evidence of [[pkg], [pkg, { ...digest, expired: true }], [{ ...pkg, expired: true }, digest], [pkg, pkg, digest]]) {
    assert.throws(() => retainedPackageArtifacts(evidence));
  }

  const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const original = Buffer.from("tested");
  const changed = Buffer.from("rebuilt");
  assert.equal(checkedTarballIntegrity({ integrity: integrityOf(original) }, original, integrityOf(original)), integrityOf(original));
  assert.throws(() => checkedTarballIntegrity({ integrity: integrityOf(changed) }, changed, integrityOf(original)), /retained integrity/);
  assert.throws(() => checkedTarballIntegrity({ integrity: integrityOf(original) }, changed, integrityOf(original)), /pack manifest/);

  const steps = job("outpost-validate").split(/\n      - /);
  for (const name of ["Install pinned build dependencies", "Outpost and release tests", "Pack, validate and smoke-test", "Retain tested tarball"]) {
    assert.match(steps.find((step) => step.startsWith(`name: ${name}`)), /if: steps.retained.outputs.package == ''/);
  }
  assert.match(steps.find((step) => step.startsWith("name: Restore the original tested package")),
    /artifact-ids: \$\{\{ steps.retained.outputs.package \}\}/);
  assert.match(steps.find((step) => step.startsWith("name: Restore the independent tested integrity")),
    /artifact-ids: \$\{\{ steps.retained.outputs.integrity \}\}/);
  assert.match(steps.find((step) => step.startsWith("name: Retain the independent tested integrity")),
    /if: steps.retained.outputs.integrity == ''/);
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
