import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

// Run-scoped artifact reads only. A missing/expired receipt is never permission
// to publish; publish.mjs treats all workflow retries as read-only recovery.
const name = process.argv[2];
assert.ok(["outpost-publication-attempt", "outpost-release-receipt"].includes(name));
assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
assert.equal(process.env.GITHUB_REPOSITORY, "pwrdrvr/PwrAgent");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const repo = `repos/${process.env.GITHUB_REPOSITORY}`;
const artifacts = gh("api", "--paginate", `${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`,
  "--jq", ".artifacts[] | select(.expired == false) | [.id, .name] | @tsv")
  .trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
let matching = artifacts.filter(([, artifact]) => artifact === name);
if (name === "outpost-release-receipt") {
  // Each pending result is immutable. A failed upload on a later attempt
  // leaves the earlier cache deadline available for read-only recovery.
  const pending = artifacts.flatMap(([id, artifact]) => {
    const attempt = /^outpost-release-pending-([1-9]\d*)$/.exec(artifact);
    return attempt ? [{ id, attempt: Number(attempt[1]) }] : [];
  });
  const latest = Math.max(0, ...pending.map(({ attempt }) => attempt));
  if (latest) matching = pending.filter(({ attempt }) => attempt === latest).map(({ id }) => [id]);
}
assert.ok(matching.length <= 1, "Ambiguous publication receipts; refusing recovery");
if (matching.length === 1) {
  const [[id]] = matching;
  assert.match(id, /^\d+$/);
  const zip = path.join(process.env.RUNNER_TEMP, `${name}.zip`);
  writeFileSync(zip, execFileSync("gh", ["api", `${repo}/actions/artifacts/${id}/zip`]));
  writeFileSync(`.local/${name}.json`, execFileSync("unzip", ["-p", zip, `${name}.json`]));
}
