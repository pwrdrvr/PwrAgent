import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const script = fileURLToPath(new URL("../extract-cohorts.mjs", import.meta.url));

test("cohort mining excludes existing splits and accepts only provenance-backed captured ranges", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-cohort-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-C", temp, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(temp, "example.ts"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(temp, "example.ts"), "head\n");
  git("commit", "-qam", "head");
  const headCommit = git("rev-parse", "HEAD");
  git("remote", "add", "origin", temp);
  git("update-ref", "refs/remotes/origin/main", baseCommit);
  const existing = path.join(temp, "existing");
  fs.mkdirSync(existing);
  const reserved = 8001;
  fs.writeFileSync(path.join(existing, "test-1.json"), JSON.stringify({ blind: true, cases: [{ pr: reserved }] }));
  const db = path.join(temp, "state.db");
  const out = path.join(temp, "out");
  const fixtureDb = new DatabaseSync(db);
  const sql = (text) => fixtureDb.exec(text);
  sql(`
    CREATE TABLE thread_reviews (review_id TEXT, thread_id TEXT, backend TEXT, status TEXT, updated_at INTEGER, payload TEXT);
    CREATE TABLE thread_sub_agents (thread_id TEXT, monitor_id TEXT, card TEXT);
  `);
  const rows = [];
  function add(pr, backend, statuses, overrides = {}) {
    git("update-ref", `refs/pull/${pr}/head`, headCommit);
    const payload = {
      origin: "automatic", backend,
      sourceKey: backend === "codex" ? "e002764c-9bc8-44d1-82d9-d4cdd16bc8c6" : "toolu_ClaudeFixture",
      context: {
        workspacePath: "C:\\Users\\Fixture User\\arbitrary-checkout",
        pullRequest: { url: `https://github.com/pwrdrvr/PwrAgent/pull/${pr}` },
        baseCommit, headCommit,
      },
      items: statuses.map((status, index) => ({
        id: `finding-${index}`, status, title: "Synthetic finding",
        body: "Evidence in `D:\\Users\\Fixture User\\secrets.txt`",
        codeLocation: {
          absolute_file_path: "C:\\Users\\Fixture User\\arbitrary-checkout\\example.ts",
          line_range: { start: 9, end: 10 },
        },
      })),
    };
    Object.assign(payload, overrides);
    rows.push(`INSERT INTO thread_reviews VALUES ('${pr}','fixture','${backend}','handled',${pr},'${JSON.stringify(payload).replace(/'/g, "''")}');`);
  }
  let pr = 8100;
  for (const [backend, statuses, count] of [
    ["codex", ["addressed", "addressed", "addressed"], 6],
    ["codex", ["addressed"], 6], ["codex", [], 6],
    ["claude", ["addressed", "addressed"], 9], ["claude", ["declined", "declined"], 3],
  ]) {
    for (let i = 0; i < count; i += 1) add(pr++, backend, statuses);
  }
  add(reserved, "codex", ["addressed"]);
  add(8002, "codex", ["addressed"], { sourceKey: "managed-review:turn-id:result" });
  add(8003, "codex", ["addressed"], {
    context: { headCommit, pullRequest: { url: "https://github.com/pwrdrvr/PwrAgent/pull/8003" } },
  });
  sql(rows.join("\n"));
  fixtureDb.close();
  const result = spawnSync(process.execPath, [
    script, "--repo", temp, "--db", db, "--out", out, "--exclude-cohorts", existing,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  const selected = ["dev-2.json", "test-1.json", "test-2.json"].flatMap((name) => read(name).cases);
  assert.equal(selected.length, 30);
  assert.equal(selected.some((c) => c.pr < 8100), false, "reserved or unverified PR entered the draw");
  const finding = selected.flatMap((c) => c.baseline.items)[0];
  assert.equal(finding.file, "example.ts");
  assert.equal(finding.startLine, 9);
  assert.equal(finding.endLine, 10);
  assert.equal(finding.body.includes("Fixture User"), false);
  // The verifier must inspect the actual decoded string, not the escaped JSON.
  const dev = read("dev-2.json");
  dev.cases[0].baseline.prTitle = "Path \\n `C:\\Users\\Someone\\example.txt`";
  fs.writeFileSync(path.join(out, "dev-2.json"), JSON.stringify(dev));
  const verification = spawnSync(process.execPath, [script, "--verify", "--repo", temp, "--out", out], { encoding: "utf8" });
  assert.notEqual(verification.status, 0);
  assert.match(verification.stderr, /machine-local/);
});
