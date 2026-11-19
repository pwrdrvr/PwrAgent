import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function priorNpmSubmissionsSkipped(runAttempt, readPages) {
  assert.match(runAttempt, /^[1-9]\d*$/);
  const currentAttempt = Number(runAttempt);
  assert.ok(Number.isSafeInteger(currentAttempt) && currentAttempt > 1);

  for (let attempt = 1; attempt < currentAttempt; attempt++) {
    const pages = readPages(attempt);
    if (!Array.isArray(pages) || pages.length === 0
      || !pages.every((page) => Array.isArray(page?.jobs))) return false;
    const jobs = pages.flatMap((page) => page.jobs);
    if (!pages.every((page) => page.total_count === jobs.length)
      || !jobs.every((job) => Number.isSafeInteger(job?.id) && typeof job.name === "string")
      || new Set(jobs.map((job) => job.id)).size !== jobs.length) return false;

    // Missing history, or any job that might have reached npm, cannot
    // authorize a write even when the receipt is absent.
    const submissions = jobs.filter((job) => job.name === "Submit matching Outpost to npm");
    if (submissions.length !== 1 || submissions[0].status !== "completed"
      || submissions[0].conclusion !== "skipped" || submissions[0].steps?.length !== 0
      || !Array.isArray(submissions[0].steps)) return false;
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  assert.equal(env.GITHUB_REPOSITORY, "pwrdrvr/PwrAgent");
  assert.match(env.GITHUB_RUN_ID, /^[1-9]\d*$/);
  const run = `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const skipped = priorNpmSubmissionsSkipped(env.GITHUB_RUN_ATTEMPT, (attempt) =>
    JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `${run}/attempts/${attempt}/jobs?per_page=100`],
      { encoding: "utf8" })));
  appendFileSync(env.GITHUB_OUTPUT, `prior-submissions-skipped=${skipped}\n`);
  console.log(skipped
    ? "GitHub reports that every earlier npm submission job was skipped."
    : "GitHub history does not establish an unused npm submission. Continuing with read-only recovery.");
}
