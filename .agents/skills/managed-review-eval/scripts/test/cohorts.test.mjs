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
  const collection = path.join(temp, "collection");
  const results = path.join(collection, "results");
  const state = path.join(collection, "pwragent-home", "profiles", "eval", "state");
  fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(path.join(state, "claude"), { recursive: true });
  const collectionDb = new DatabaseSync(path.join(state, "state.db"));
  const schema = "CREATE TABLE thread_reviews (backend TEXT, status TEXT, updated_at INTEGER, payload TEXT)";
  for (const connection of [fixtureDb, collectionDb]) connection.exec(schema);
  function add(pr, backend, statuses, overrides = {}) {
    git("update-ref", `refs/pull/${pr}/head`, headCommit);
    const threadId = `00000000-0000-4000-8000-${String(pr).padStart(12, "0")}`;
    const payload = {
      origin: "automatic", backend, threadId, createdAt: pr + 10,
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
    if (backend === "claude") {
      fixtureDb.prepare("INSERT INTO thread_reviews VALUES (?, 'handled', ?, ?)")
        .run(backend, pr, JSON.stringify(payload));
      // The native artifact can have only generic workspace context. A
      // receipt for this provider turn must carry the immutable evidence.
      payload.context = { workspacePath: payload.context.workspacePath };
      const turnId = `turn-${pr}`;
      const command = `/code-review high ${baseCommit}..${headCommit}`;
      fs.writeFileSync(path.join(results, `case-${pr}--claude-native.json`), JSON.stringify({
        arm: "claude-native", backend, status: "completed", structured: true,
        parentThreadId: threadId, reviewThreadId: threadId, turnId,
        prNumber: pr, workspacePath: payload.context.workspacePath,
        mergeBaseCommit: baseCommit, headCommit, reasoningEffort: "high",
        nativeClaude: {
          sourceKey: payload.sourceKey, dispatchedAt: pr, command,
        },
      }));
      const entries = [
        { type: "message", role: "user", text: command, createdAt: pr + 1, turn: { id: turnId } },
        { type: "review", id: payload.sourceKey, reviewer: { backend }, output: { findings: [] },
          createdAt: pr + 10, turn: { id: turnId } },
        { turnId, status: "completed" },
      ];
      fs.writeFileSync(path.join(state, "claude", `${threadId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n"));
    }
    const owner = backend === "claude" ? collectionDb : fixtureDb;
    owner.prepare("INSERT INTO thread_reviews VALUES (?, 'handled', ?, ?)").run(backend, pr, JSON.stringify(payload));
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
  fixtureDb.close();
  collectionDb.close();
  const extract = (...args) => spawnSync(process.execPath, [
    script, "--repo", temp, "--db", db, "--out", out, "--exclude-cohorts", existing, ...args,
  ], { encoding: "utf8" });
  const withoutEvidence = extract("--inventory");
  assert.equal(withoutEvidence.status, 0, withoutEvidence.stderr);
  assert.equal(JSON.parse(withoutEvidence.stdout).shortages["claude-findings"], 9);
  const planFile = path.join(temp, "private-plan.json");
  const planning = extract("--plan-claude", planFile, "--plan-count", "4");
  assert.equal(planning.status, 0, planning.stderr);
  assert.equal(JSON.parse(planning.stdout).planned, 4);
  assert.doesNotMatch(planning.stdout, /PR #\d|pr\d{4}/);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  assert.equal(plan.blind, true);
  assert.ok(plan.cases.every((c) => c.pr >= 8118 && !Object.hasOwn(c.baseline, "items")));
  const result = extract("--claude-captures", collection);
  assert.equal(result.status, 0, result.stderr);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  const selected = ["dev-3.json", "test-3.json", "test-4.json"].flatMap((name) => read(name).cases);
  assert.equal(selected.length, 30);
  assert.equal(selected.some((c) => c.pr < 8100), false, "reserved or unverified PR entered the draw");
  const verified = extract("--verify-staged");
  assert.equal(verified.status, 0, verified.stderr);
  assert.doesNotMatch(verified.stdout, /PR #\d|pr\d{4}/);
  const finding = selected.flatMap((c) => c.baseline.items)[0];
  assert.equal(finding.file, "example.ts");
  assert.equal(finding.startLine, 9);
  assert.equal(finding.endLine, 10);
  assert.equal(finding.body.includes("Fixture User"), false);
  // The verifier must inspect the actual decoded string, not the escaped JSON.
  const dev = read("dev-3.json");
  dev.cases[0].baseline.prTitle = "Path \\n `C:\\Users\\Someone\\example.txt`";
  fs.writeFileSync(path.join(out, "dev-3.json"), JSON.stringify(dev));
  const verification = spawnSync(process.execPath, [script, "--verify", "--repo", temp, "--out", out], { encoding: "utf8" });
  assert.notEqual(verification.status, 0);
  assert.match(verification.stderr, /machine-local/);
  const cell = JSON.parse(fs.readFileSync(path.join(results, "case-8118--claude-native.json"), "utf8"));
  const transcript = path.join(state, "claude", cell.parentThreadId + ".jsonl");
  const entries = fs.readFileSync(transcript, "utf8").split("\n").map(JSON.parse);
  entries[0].text = "/code-review high 8118";
  fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const movingTarget = extract("--claude-captures", collection, "--inventory");
  assert.equal(movingTarget.status, 0, movingTarget.stderr);
  assert.equal(JSON.parse(movingTarget.stdout).shortages["claude-findings"], 1);
});
