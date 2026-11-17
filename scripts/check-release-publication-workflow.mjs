#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Static oracle for the publication critical path, not a general YAML parser.
// Fail closed on layout changes so a new step cannot escape the budget model.
function jobBody(workflow, name) {
  const body = workflow.split(`\n  ${name}:\n`)[1];
  assert(body, `Missing job: ${name}`);
  return body.split(/\n  [\w-]+:\n/)[0];
}

function scalar(body, indent, key) {
  return body.match(new RegExp(`^ {${indent}}${key}: ([^\\n]+)$`, "m"))?.[1];
}

function steps(body, indent) {
  const headers = [...body.matchAll(new RegExp(`^ {${indent}}- `, "gm"))];
  return headers.map((header, index) => {
    const text = body.slice(header.index, headers[index + 1]?.index ?? body.length);
    return {
      text,
      name: text.match(new RegExp(`^ {${indent}}- name: ([^\\n]+)`))?.[1],
      value: (key) => scalar(text, indent + 2, key),
    };
  });
}

function timeout(value, label) {
  assert(/^[1-9]\d*$/.test(value ?? ""), `${label} needs a finite positive timeout`);
  return Number(value);
}

export function checkReleasePublicationWorkflow(workflow) {
  const job = jobBody(workflow, "publish-release-assets");
  const jobMinutes = timeout(scalar(job, 4, "timeout-minutes"), "Publication job");
  assert(jobMinutes >= 45, "Publication job needs at least 45 minutes");
  assert.equal(scalar(job, 4, "continue-on-error"), undefined);
  const plan = steps(job.split("\n    steps:\n")[1] ?? "", 6);
  assert.deepEqual(plan.map((step) => step.name ?? "parallel"), [
    "Set up Node.js runtime only",
    "Checkout repository",
    "parallel",
    "Verify debug artifact targets, identities, and checksums",
    "Verify Linux packages and generate checksums",
    "Name Windows checksum manifest",
    "Verify updater channel files",
    "Create release and publish all platform assets",
    "Upload assembled release artifacts (debug retention)",
    "Wait for required release publication",
  ], "Update the budget oracle when publication steps change");

  const downloads = steps(plan[2].text, 10);
  assert.match(plan[2].text, /^ {6}- parallel:\n/);
  for (const key of ["if", "continue-on-error", "background"]) {
    assert.equal(plan[2].value(key), undefined, "Download group must join and propagate failures");
  }
  assert.deepEqual(downloads.map((step) => step.name), [
    "Download macOS release artifacts",
    "Download Windows installer artifact",
    "Download Linux package artifacts",
    "Download exact-build debug artifacts",
  ]);
  assert.deepEqual(downloads.map((step) => scalar(step.text, 14, "path")), [
    "mac-dist", "windows-dist", "linux-dist", "debug-dist",
  ], "Parallel downloads must have independent destinations");

  const publication = plan[7];
  const retention = plan[8];
  const join = plan[9];
  const required = [...plan.slice(0, 2), ...downloads, ...plan.slice(3, 8)];
  for (const step of required) {
    assert.equal(step.value("continue-on-error"), undefined, `${step.name} must remain required`);
    assert.equal(step.value("if"), undefined, `${step.name} must use the success gate`);
    assert.equal(step.value("background"), step === publication ? "true" : undefined);
  }
  assert.equal(publication.value("id"), "publish_assets");
  assert.equal(join.value("wait"), "publish_assets", "Publication must be joined and failure must propagate");
  assert.equal(join.value("continue-on-error"), undefined);
  assert.equal(join.value("if"), undefined);
  assert.equal(retention.value("background"), undefined, "Only two uploads may overlap");
  assert.equal(retention.value("continue-on-error"), "true");
  assert.equal(retention.value("if"), "${{ !cancelled() }}");
  assert.equal(scalar(retention.text, 10, "name"), "release-publish-artifacts");
  assert.equal(scalar(retention.text, 10, "retention-days"), "90");
  assert.equal(scalar(retention.text, 10, "compression-level"), "0");
  const retentionMinutes = timeout(retention.value("timeout-minutes"), "Optional retention");
  assert(retentionMinutes <= 5, "Optional retention must finish or time out within five minutes");

  // The native parallel group joins before validation. After validation,
  // publication runs in the background while retention runs in the foreground.
  // Every possible duration up to these caps is bounded by this longest path.
  const minutes = (step) => timeout(step.value("timeout-minutes"), step.name);
  const beforeUpload = [...plan.slice(0, 2), ...plan.slice(3, 7)].reduce((sum, step) => sum + minutes(step), 0)
    + Math.max(...downloads.map(minutes));
  const criticalPath = beforeUpload + Math.max(minutes(publication), retentionMinutes);
  assert(criticalPath + 3 <= jobMinutes,
    `Publication/retention path (${criticalPath}m) must leave three minutes for runner overhead and cleanup`);

  // Notes, and transitively npm, depend on the successful publication job.
  assert.match(jobBody(workflow, "publish-release-notes"), /^    needs:\n      - publish-release-assets\n/m);
  assert.match(jobBody(workflow, "outpost-publish"), /^      - publish-release-notes$/m);
  return { jobMinutes, criticalPath, retentionMinutes, overheadMinutes: jobMinutes - criticalPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2] ?? new URL("../.github/workflows/release.yml", import.meta.url);
    console.log(JSON.stringify(checkReleasePublicationWorkflow(readFileSync(path, "utf8"))));
  } catch (error) {
    console.error(`Release publication contract: ${error.message}`);
    process.exitCode = 1;
  }
}
