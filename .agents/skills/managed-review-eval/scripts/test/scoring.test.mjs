import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = fileURLToPath(new URL("../", import.meta.url));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function fixture(t, candidateCount = 1) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-eval-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "arbitrary-checkout");
  const results = path.join(tmp, "results");
  const scoring = path.join(tmp, "scoring");
  const cohort = path.join(tmp, "cohort.json");
  fs.mkdirSync(repo);
  fs.mkdirSync(results);
  const git = (...args) => execFileSync("git", [
    "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "example.txt"), "common\n");
  git("add", ".");
  git("commit", "-qm", "common");
  const common = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "example.txt"), "common\nbase_only_text\n");
  git("commit", "-qam", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "--detach", common);
  const headLines = ["common", ...Array.from({ length: 130 }, (_, i) =>
    `line_${i + 2} ${"x".repeat(32)}`)];
  fs.writeFileSync(path.join(repo, "example.txt"), `${headLines.join("\n")}\n`);
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  const finding = {
    title: "Problem on line 120", body: '🙂 "s".'.repeat(45), priority: 2,
    code_location: { absolute_file_path: path.join(repo, "example.txt"), line_range: { start: 120, end: 120 } },
  };
  const baselineItem = {
    id: "baseline-finding", title: finding.title, body: finding.body,
    status: "addressed", priority: 2, file: "example.txt", startLine: 120, endLine: 120,
  };
  write(cohort, { blind: false, cases: [{
    id: "fixture", pr: 1, backend: "codex", baseline: {
      baseCommit: base, headCommit: head, reviewedRangeVerified: true,
      counts: { total: 1, addressed: 1, declined: 0 },
      items: Array.from({ length: 9 }, () => baselineItem),
    },
  }] });
  const cell = path.join(results, "fixture--codex.json");
  const record = {
    status: "completed", structured: true, findings: Array.from({ length: candidateCount }, () => finding),
    findingsCount: candidateCount, overallExplanation: "Identifies the candidate.",
  };
  write(cell, record);
  const run = (name, ...args) => spawnSync(process.execPath, [
    path.join(scripts, name), "--cohort", cohort, "--results", results, ...args,
  ], { encoding: "utf8" });
  return {
    cell, record, cohort, scoring, repo, git, tmp, base, head,
    prepare: (...extra) => run("prepare-scoring-batches.mjs", "--repo", repo, "--out", scoring, "--arms", "codex", ...extra),
    aggregate: () => run("aggregate-eval-scores.mjs", "--scoring", scoring, "--out", path.join(tmp, "summary")),
  };
}

test("precision evidence is from Git's reviewed range and includes the finding in a long hunk", (t) => {
  const f = fixture(t);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const manifest = read(path.join(f.scoring, "chunks-manifest.json"));
  const item = read(manifest.precision[0].file)[0];
  const expectedDiff = f.git("diff", `${f.base}...${f.head}`, "--", "example.txt");
  assert.match(expectedDiff, /\+line_120 /);
  assert.match(item.diff, /\+line_120 /);
  assert.doesNotMatch(item.diff, /base_only_text/);
});

test("all scoring inputs use the recorded reviewer workspace for absolute finding paths", (t) => {
  const f = fixture(t);
  const workspacePath = path.join(f.tmp, "matrix-run", "workspaces", "fixture--codex");
  const record = read(f.cell);
  // Archived results can be scored after the reviewer workspace is removed.
  record.workspacePath = workspacePath;
  record.findings[0].code_location.absolute_file_path = path.join(workspacePath, "example.txt");
  write(f.cell, record);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const manifest = read(path.join(f.scoring, "chunks-manifest.json"));
  const item = read(manifest.precision[0].file)[0];
  assert.equal(item.finding.loc, "example.txt:120");
  assert.match(item.diff, /\+line_120 /);
  assert.match(read(manifest.recall[0].file)[0].candidate_findings, /example\.txt:120/);
  assert.match(read(manifest.holistic[0].file)[1].findings, /example\.txt:120/);
});

test("holistic inputs do not identify the baseline or include candidate-only fields", (t) => {
  const f = fixture(t);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const manifest = read(path.join(f.scoring, "chunks-manifest.json"));
  const [baseline, candidate] = read(manifest.holistic[0].file);
  assert.deepEqual(Object.keys(baseline), Object.keys(candidate));
  for (const input of [baseline, candidate]) {
    assert.doesNotMatch(JSON.stringify(input), /baseline review|Identifies the candidate/);
  }
});

test("a failed empty cell cannot be scored as a clean review", (t) => {
  const f = fixture(t);
  write(f.cell, { ...f.record, status: "failed", structured: false, findings: [] });
  const result = f.prepare();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete/i);
});

test("serialized chunks fit the byte limit with multibyte and escaped findings", (t) => {
  const f = fixture(t, 18);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const manifest = read(path.join(f.scoring, "chunks-manifest.json"));
  for (const type of ["recall", "precision", "holistic"]) {
    let offset = 0;
    for (const chunk of manifest[type]) {
      assert.equal(chunk.start, offset);
      assert.equal(chunk.bytes, fs.statSync(chunk.file).size);
      assert.ok(chunk.bytes <= 37 * 1024, `${type} chunk uses ${chunk.bytes} bytes`);
      offset += chunk.count;
    }
  }
});

test("a single oversized input requires an explicit evidence decision", (t) => {
  const f = fixture(t);
  const data = read(f.cohort);
  data.cases[0].baseline.prTitle = "🙂".repeat(11_000);
  write(f.cohort, data);
  const result = f.prepare();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds the 37 KiB scoring chunk budget on its own/);
  assert.equal(fs.existsSync(path.join(f.scoring, "chunks-manifest.json")), false);
});

test("uncaptured baseline ranges cannot be used for blind validation", (t) => {
  const f = fixture(t);
  const data = read(f.cohort);
  data.cases[0].baseline.reviewedRangeVerified = false;
  write(f.cohort, data);
  assert.match(f.prepare().stderr, /without a verified original range/);
  assert.equal(f.prepare("--allow-legacy-baselines").status, 0);
  assert.equal(read(path.join(f.scoring, "chunks-manifest.json")).unverifiedBaselineCount, 1);
  write(f.cohort, { ...data, blind: true });
  const result = f.prepare("--allow-legacy-baselines");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /without a verified original range/);
});

test("cannot aggregate failed answers, missing chunks, or judgments for different inputs", (t) => {
  const f = fixture(t);
  const prepared = f.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const manifest = read(path.join(f.scoring, "chunks-manifest.json"));
  const answerSet = {
    recall: [{ name: "same_root_cause", probability: 0.9 }, { name: "match_grade", choice: "exact_match" }],
    precision: [{ name: "matches_baseline", probability: 0.9 }, { name: "concrete_defect", probability: 0.9 }, { name: "defect_value", score: 3 }],
    holistic: ["signal_to_noise", "actionability", "overall_quality"].map((name) => ({ name, score: 3 })),
  };
  function archive(fault) {
    const summary = Object.fromEntries(Object.entries(answerSet).map(([batchType, answers]) => {
      const chunks = manifest[batchType].map((chunk, chunkIndex) => {
        const resultsFile = path.join(f.scoring, `${batchType}-${chunkIndex}.jsonl`);
        const rows = Array.from({ length: chunk.count }, (_, index) => ({
          type: "item", index, ok: true, response: { answers },
        }));
        if (batchType === "recall" && chunkIndex === 0 && fault === "failed") rows[0].ok = false;
        const batchId = `batch_${batchType}-${chunkIndex}`;
        fs.writeFileSync(resultsFile, [
          { type: "batch", batchId, count: chunk.count }, ...rows,
        ].map((row) => JSON.stringify(row)).join("\n"));
        return {
          batchType, chunkIndex, count: chunk.count, start: chunk.start, resultsFile,
          batchId, succeeded: chunk.count, failed: 0,
          definitionSha256: manifest.definitionSha256,
          inputsSha256: fault === "stale" ? "stale" : chunk.inputsSha256,
        };
      });
      return [batchType, batchType === "recall" && fault === "missing" ? chunks.slice(1) : chunks];
    }));
    write(path.join(f.scoring, "decision-batches-summary.json"), summary);
    return f.aggregate();
  }
  const complete = archive(null);
  assert.equal(complete.status, 0, complete.stderr);
  for (const fault of ["failed", "missing", "stale"]) {
    const result = archive(fault);
    assert.notEqual(result.status, 0, `Unexpected scorecard for ${fault} Decision results`);
    assert.match(result.stderr, /incomplete|different inputs/i);
  }
});

test("file-backed Decision batches round trip without inline evidence and are keyed by content", (t) => {
  const f = fixture(t);
  const prepared = f.prepare("--judge-provider", "jev");
  assert.equal(prepared.status, 0, prepared.stderr);
  const plan = (...args) => spawnSync(process.execPath, [
    path.join(scripts, "decision-file-batches.mjs"), "--scoring", f.scoring, ...args,
  ], { encoding: "utf8" });
  const first = plan();
  assert.equal(first.status, 0, first.stderr);
  const { pending } = JSON.parse(first.stdout);
  assert.deepEqual([...new Set(pending.map(({ batchType }) => batchType))], ["recall", "precision", "holistic"]);
  assert.notEqual(plan("--record").status, 0);
  const compactAnswers = {
    recall: [{ name: "same_root_cause", probability: 0.9 }, { name: "match_grade", choice: "exact_match" }],
    precision: [{ name: "matches_baseline", probability: 0.9 }, { name: "concrete_defect", probability: 0.9 }, { name: "defect_value", score: 3 }],
    holistic: ["signal_to_noise", "actionability", "overall_quality"].map((name) => ({ name, score: 3 })),
  };
  for (const { batchType, chunkIndex, count, arguments: args } of pending) {
    assert.equal(args.definition.provider, "jev");
    assert.equal(args.inlineResults, false);
    assert.equal(Object.hasOwn(args, "inputs"), false);
    assert.equal(read(args.inputsFile).length, count);
    fs.mkdirSync(path.dirname(args.outputFile), { recursive: true });
    write(args.outputFile, {
      batchId: `batch_${batchType}-${chunkIndex}`, state: "completed", provider: "jev", count, succeeded: count, failed: 0,
      results: Array.from({ length: count }, (_, index) => ({ index, ok: true, answers: compactAnswers[batchType] })),
    });
  }
  const recorded = plan("--record");
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(plan().stdout), { complete: pending.length, pending: [] });
  const complete = f.aggregate();
  assert.equal(complete.status, 0, complete.stderr);
  const precision = pending.find(({ batchType }) => batchType === "precision").arguments.outputFile;
  const invalid = read(precision);
  invalid.results[0].answers[0] = { name: "matches_baseline", type: "refusal" };
  write(precision, invalid);
  assert.notEqual(plan("--record").status, 0);
  assert.notEqual(f.aggregate().status, 0);

  const changed = f.prepare("--judge-provider", "openai");
  assert.equal(changed.status, 0, changed.stderr);
  const regenerated = JSON.parse(plan().stdout);
  assert.equal(regenerated.complete, 0);
  assert.equal(regenerated.pending.length, pending.length);
  for (const [index, item] of regenerated.pending.entries()) {
    assert.notEqual(item.arguments.outputFile, pending[index].arguments.outputFile);
  }
});
