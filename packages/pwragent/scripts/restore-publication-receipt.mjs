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
const ids = gh("api", "--paginate", `${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`,
  "--jq", `.artifacts[] | select(.name == "${name}" and .expired == false) | .id`).trim().split(/\s+/).filter(Boolean);
assert.ok(ids.length <= 1, "Ambiguous publication receipts; refusing recovery");
if (ids.length === 1) {
  assert.match(ids[0], /^\d+$/);
  const zip = path.join(process.env.RUNNER_TEMP, `${name}.zip`);
  writeFileSync(zip, execFileSync("gh", ["api", `${repo}/actions/artifacts/${ids[0]}/zip`]));
  writeFileSync(`.local/${name}.json`, execFileSync("unzip", ["-p", zip, `${name}.json`]));
}

