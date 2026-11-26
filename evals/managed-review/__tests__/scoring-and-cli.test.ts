import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectDecisionFileBatches } from "../drivers/decision-file-batches.mjs";

const execFileAsync = promisify(execFile);

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driversDir = path.join(suiteDir, "drivers");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createScoringFixture({ blind = false } = {}) {
  const tmp = makeTempDir("pwragent-eval-score-");
  const repo = path.join(tmp, "repo");
  const runDir = path.join(tmp, "run");
  const results = path.join(runDir, "results");
  const scoring = path.join(runDir, "scoring");
  const cohort = path.join(tmp, "cohort.json");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(results, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", [
    "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "-q");
  fs.writeFileSync(path.join(repo, "example.ts"), "export const x = 1;\n");
  git("add", ".");
  git("commit", "-qm", "common");
  const common = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "example.ts"), "export const x = 1;\nexport const base = true;\n");
  git("commit", "-qam", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "--detach", common);
  fs.writeFileSync(path.join(repo, "example.ts"), "export const x = 2;\nexport const buggy = true;\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");

  fs.writeFileSync(cohort, JSON.stringify({
    name: blind ? "synthetic-blind" : "synthetic-dev",
    blind,
    cases: [{
      id: "case-secret-alpha",
      pr: 42,
      backend: "codex",
      bucket: "medium-findings",
      baseline: {
        baseCommit: base,
        headCommit: head,
        reviewedRangeVerified: true,
        reviewMode: "codex-native",
        rangeEvidence: "codex-pr-snapshot",
        counts: { total: 1, addressed: 1, declined: 0 },
        items: [{
          id: "b1",
          title: "Buggy flag set",
          body: "buggy should be false",
          status: "addressed",
          priority: 2,
          file: "example.ts",
          startLine: 2,
          endLine: 2,
        }],
      },
    }],
  }));

  fs.writeFileSync(path.join(results, "case-secret-alpha--codex.json"), JSON.stringify({
    status: "completed",
    structured: true,
    elapsedSec: 32,
    approvals: 0,
    abortedOnApproval: false,
    baseCommit: base,
    headCommit: head,
    mergeBaseCommit: common,
    workspacePath: repo,
    findingsCount: 2,
    findings: [
      {
        title: "Buggy flag set",
        body: "buggy should be false",
        priority: 2,
        code_location: { absolute_file_path: path.join(repo, "example.ts"), line_range: { start: 2, end: 2 } },
      },
      {
        title: "Extra unverified nit",
        body: "Speculative comment",
        priority: 3,
        code_location: { absolute_file_path: path.join(repo, "example.ts"), line_range: { start: 1, end: 1 } },
      },
    ],
    ledger: { total: 3, keep: 2, drop: 1, pending: 0 },
    usage: {
      source: "ledger",
      lineCount: 1,
      pricedLineCount: 1,
      unpricedLineCount: 0,
      uncachedInputTokens: 4000,
      cachedInputTokens: 16_000,
      cacheWriteInputTokens: 0,
      inputTokens: 20_000,
      outputTokens: 1200,
      reasoningOutputTokens: 400,
      totalTokens: 21_200,
      replayObserved: true,
      coldReplayCount: 1,
      hotReplayCount: 5,
      totalReplayCount: 6,
      peakContextTokens: 19_000,
      finalContextTokens: 17_500,
      totalCostMicros: 25_000,
      estimatedCostUsd: 0.025,
      currency: "USD",
    },
  }));

  return { tmp, repo, runDir, results, scoring, cohort };
}

describe("managed-review scoring (Jev / local / default) and CLI guards", () => {
  it("defaults --judge-provider to jev, supports local/default, and aggregates tokens, replays, cost, and summary.md", () => {
    const f = createScoringFixture({ blind: false });

    const prep = spawnSync(process.execPath, [
      path.join(driversDir, "prepare-scoring-batches.mjs"),
      "--repo", f.repo,
      "--cohort", f.cohort,
      "--results", f.results,
      "--out", f.scoring,
      "--arms", "codex",
    ], { encoding: "utf8" });
    expect(prep.status, prep.stderr).toBe(0);

    const defs = JSON.parse(fs.readFileSync(path.join(f.scoring, "scoring-definitions.json"), "utf8"));
    expect(defs.recall.provider).toBe("jev");
    expect(defs.precision.provider).toBe("jev");
    expect(defs.holistic.provider).toBe("jev");

    const plan = collectDecisionFileBatches(f.scoring, false) as {
      pending: Array<{
        batchType: string;
        count: number;
        arguments: { outputFile: string; definition: { provider: string } };
      }>;
    };
    expect(plan.pending.length).toBe(3);

    for (const entry of plan.pending) {
      const results = Array.from({ length: entry.count }, (_, index) => {
        if (entry.batchType === "recall") {
          return {
            index,
            ok: true,
            answers: [
              { name: "same_root_cause", type: "predicate", probability: 0.95 },
              { name: "match_grade", type: "choice", choice: "exact_match", confidence: 0.95 },
            ],
          };
        }
        if (entry.batchType === "precision") {
          const isConcrete = index === 0;
          return {
            index,
            ok: true,
            answers: [
              { name: "matches_baseline", type: "predicate", probability: isConcrete ? 0.9 : 0.05 },
              { name: "concrete_defect", type: "predicate", probability: isConcrete ? 0.9 : 0.1 },
              {
                name: "defect_value",
                type: "score",
                score: isConcrete ? 3 : 0,
                probabilities: [{ label: isConcrete ? "solid_p2" : "noise", probability: 0.9 }],
              },
            ],
          };
        }
        return {
          index,
          ok: true,
          answers: [
            { name: "signal_to_noise", type: "score", score: 3 },
            { name: "actionability", type: "score", score: 3 },
            { name: "overall_quality", type: "score", score: 3 },
          ],
        };
      });
      fs.mkdirSync(path.dirname(entry.arguments.outputFile), { recursive: true });
      fs.writeFileSync(entry.arguments.outputFile, JSON.stringify({
        state: "completed",
        batchId: `jev-batch-${entry.batchType}`,
        provider: "jev",
        count: entry.count,
        succeeded: entry.count,
        failed: 0,
        usage: { estimatedCostUsd: 0.001 },
        results,
      }));
    }

    const recorded = collectDecisionFileBatches(f.scoring, true);
    expect(recorded.recorded).toBe(true);

    const agg = spawnSync(process.execPath, [
      path.join(driversDir, "aggregate-eval-scores.mjs"),
      "--cohort", f.cohort,
      "--results", f.results,
      "--scoring", f.scoring,
      "--out", f.runDir,
    ], { encoding: "utf8" });
    expect(agg.status, agg.stderr).toBe(0);

    const summary = JSON.parse(fs.readFileSync(path.join(f.runDir, "eval-matrix-summary.json"), "utf8"));
    expect(summary.decisionScoring.provider).toBe("jev");
    expect(summary.decisionScoring.model).toBe("jev-latest");
    expect(summary.aggregates.all.codex.precision.concrete).toBe(1);
    expect(summary.aggregates.all.codex.precision.unverifiedOrInvalid).toBe(1);
    expect(summary.aggregates.all.codex.usage.totalTokens).toBe(21_200);
    expect(summary.aggregates.all.codex.usage.totalReplayCount).toBe(6);
    expect(summary.aggregates.all.codex.usage.estimatedCostUsd).toBe(0.025);

    const summaryMd = fs.readFileSync(path.join(f.runDir, "summary.md"), "utf8");
    expect(summaryMd).toContain("21.2k");
    expect(summaryMd).toContain("$0.025");
    expect(summaryMd).toContain("6 (1/5)");
  });

  it("supports --judge-provider default (omitting provider so PwrAgent proxy picks Settings default) and local", () => {
    const f = createScoringFixture({ blind: false });
    const prep = spawnSync(process.execPath, [
      path.join(driversDir, "prepare-scoring-batches.mjs"),
      "--repo", f.repo,
      "--cohort", f.cohort,
      "--results", f.results,
      "--out", f.scoring,
      "--arms", "codex",
      "--judge-provider", "default",
    ], { encoding: "utf8" });
    expect(prep.status, prep.stderr).toBe(0);
    const defs = JSON.parse(fs.readFileSync(path.join(f.scoring, "scoring-definitions.json"), "utf8"));
    expect(defs.recall.provider).toBeUndefined();
    expect(defs.precision.provider).toBeUndefined();
    expect(defs.holistic.provider).toBeUndefined();
  });

  it("routes blind cohorts to isolated mode in run.mjs --dry-run and rejects --neon-mode auto without isolation", () => {
    const outDir = makeTempDir("pwragent-eval-dry-");
    const blindDry = spawnSync(process.execPath, [
      path.join(suiteDir, "run.mjs"),
      "--cohort", "test-1",
      "--out", outDir,
      "--arms", "codex,codex-native,neon",
      "--dry-run",
    ], { encoding: "utf8" });
    expect(blindDry.status, blindDry.stderr).toBe(0);
    const parsed = JSON.parse(blindDry.stdout);
    expect(parsed.blind).toBe(true);
    expect(parsed.useIsolated).toBe(true);
    expect(parsed.arms).toEqual(["codex", "codex-native", "neon"]);

    const unsafeAuto = spawnSync(process.execPath, [
      path.join(suiteDir, "run.mjs"),
      "--cohort", "dev-1",
      "--out", outDir,
      "--neon-mode", "auto",
      "--dry-run",
    ], { encoding: "utf8" });
    expect(unsafeAuto.status).not.toBe(0);
    expect(unsafeAuto.stderr).toMatch(/OS-enforced isolation/i);
  });

  it("executes direct System One (local/jev) scoring against a local loopback server, forwards --decision-model, and avoids fabricating $0 cost", async () => {
    const f = createScoringFixture({ blind: false });
    const prep = spawnSync(process.execPath, [
      path.join(driversDir, "prepare-scoring-batches.mjs"),
      "--repo", f.repo,
      "--cohort", f.cohort,
      "--results", f.results,
      "--out", f.scoring,
      "--arms", "codex",
      "--judge-provider", "local",
    ], { encoding: "utf8" });
    expect(prep.status, prep.stderr).toBe(0);

    const seenModels: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          model?: string;
          questions: Record<string, { type: string; criteria: Record<string, unknown> }>;
        };
        if (parsed.model) seenModels.push(parsed.model);
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(parsed.questions)) {
          if (q.type === "noul") {
            answers[key] = { noul: 0.9 };
          } else {
            const firstChoice = Object.keys(q.criteria)[0]!;
            answers[key] = {
              choice: firstChoice,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k, idx) => [k, idx === 0 ? 1 : 0]),
              ),
            };
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const distOut = makeTempDir("pwragent-eval-direct-dist-");
      const build = spawnSync(process.execPath, [
        path.join(driversDir, "build-driver.mjs"),
        "--out", distOut,
      ], { encoding: "utf8" });
      expect(build.status, build.stderr).toBe(0);

      const scorerBundle = fs.realpathSync(path.join(distOut, "direct-decision-scorer.js"));
      const { stdout } = await execFileAsync(process.execPath, [
        scorerBundle,
        "--scoring", f.scoring,
        "--decision-endpoint", `http://127.0.0.1:${port}`,
        "--decision-model", "clef-custom-v2",
        "--concurrency", "2",
      ], { encoding: "utf8" });
      expect(JSON.parse(stdout).executed).toBe(3);
      expect(seenModels.length).toBeGreaterThan(0);
      expect(seenModels.every((m) => m === "clef-custom-v2")).toBe(true);

      const recorded = collectDecisionFileBatches(f.scoring, true);
      expect(recorded.complete).toBe(3);
      expect(recorded.recorded).toBe(true);

      const agg = spawnSync(process.execPath, [
        path.join(driversDir, "aggregate-eval-scores.mjs"),
        "--cohort", f.cohort,
        "--results", f.results,
        "--scoring", f.scoring,
        "--out", f.runDir,
      ], { encoding: "utf8" });
      expect(agg.status, agg.stderr).toBe(0);

      const summary = JSON.parse(fs.readFileSync(path.join(f.runDir, "eval-matrix-summary.json"), "utf8"));
      expect(summary.decisionScoring.model).toBe("clef-custom-v2");
      expect(summary.decisionScoring.totalCostUsd).toBeNull();

      // OpenAI direct mode also honors --decision-model and records actual model.
      const openaiFixture = createScoringFixture({ blind: false });
      const prepOpenAi = spawnSync(process.execPath, [
        path.join(driversDir, "prepare-scoring-batches.mjs"),
        "--repo", openaiFixture.repo,
        "--cohort", openaiFixture.cohort,
        "--results", openaiFixture.results,
        "--out", openaiFixture.scoring,
        "--arms", "codex",
        "--judge-provider", "openai",
      ], { encoding: "utf8" });
      expect(prepOpenAi.status, prepOpenAi.stderr).toBe(0);

      const openAiModels: string[] = [];
      const openAiServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body) as {
            model?: string;
            questions: Array<{ name: string; type: string; choices?: Array<{ value: string }> }>;
          };
          if (parsed.model) openAiModels.push(parsed.model);
          const answers = parsed.questions.map((q) => {
            if (q.type === "predicate") return { name: q.name, type: "predicate", probability: 0.9 };
            if (q.type === "choice") {
              return { name: q.name, type: "choice", choice: q.choices?.[0]?.value ?? "exact_match", confidence: 0.9 };
            }
            return { name: q.name, type: "score", score: 2 };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ model: parsed.model, answers }));
        });
      });
      await new Promise<void>((resolve) => openAiServer.listen(0, "127.0.0.1", () => resolve()));
      const openAiAddr = openAiServer.address();
      const openAiPort = typeof openAiAddr === "object" && openAiAddr ? openAiAddr.port : 0;
      try {
        const openAiRun = await execFileAsync(process.execPath, [
          scorerBundle,
          "--scoring", openaiFixture.scoring,
          "--decision-endpoint", `http://127.0.0.1:${openAiPort}`,
          "--decision-model", "gpt-6-luna-custom",
          "--concurrency", "2",
        ], {
          encoding: "utf8",
          env: { ...process.env, OPENAI_DECISIONS_API_KEY: "test-key" },
        });
        expect(JSON.parse(openAiRun.stdout).executed).toBe(3);
        expect(openAiModels.every((m) => m === "gpt-6-luna-custom")).toBe(true);
      } finally {
        await new Promise<void>((resolve) => openAiServer.close(() => resolve()));
      }

      // Direct mode rejects --judge-provider default instead of silently misrouting to jev.
      const defaultDirect = spawnSync(process.execPath, [
        path.join(suiteDir, "score.mjs"),
        "--run", f.runDir,
        "--cohort", f.cohort,
        "--mode", "direct",
        "--judge-provider", "default",
      ], { encoding: "utf8" });
      expect(defaultDirect.status).not.toBe(0);
      expect(defaultDirect.stderr).toMatch(/--judge-provider default.*--mode mcp/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("honors run-meta.json --cases subsets end-to-end in score.mjs and rejects --cases on blind cohorts", () => {
    const f = createScoringFixture({ blind: false });
    const parsedCohort = JSON.parse(fs.readFileSync(f.cohort, "utf8"));
    // Add a second unrun case to the cohort to reproduce the Quick Start --cases subset scenario.
    parsedCohort.cases.push({
      ...parsedCohort.cases[0],
      id: "case-unrun-beta",
      pr: 99,
    });
    fs.writeFileSync(f.cohort, JSON.stringify(parsedCohort));
    fs.writeFileSync(path.join(f.runDir, "run-meta.json"), JSON.stringify({
      cohortPath: f.cohort,
      arms: ["codex"],
      cases: "case-secret-alpha",
    }));

    const firstScore = spawnSync(process.execPath, [
      path.join(suiteDir, "score.mjs"),
      "--run", f.runDir,
      "--repo", f.repo,
      "--judge-provider", "jev",
    ], { encoding: "utf8" });
    expect(firstScore.status, firstScore.stderr).toBe(0);
    const pendingPayload = collectDecisionFileBatches(f.scoring, false) as {
      pending: Array<{
        batchType: string;
        count: number;
        arguments: { outputFile: string };
      }>;
    };
    expect(pendingPayload.pending.length).toBe(3);

    for (const entry of pendingPayload.pending) {
      const results = Array.from({ length: entry.count }, (_, index) => {
        if (entry.batchType === "recall") {
          return {
            index,
            ok: true,
            answers: [
              { name: "same_root_cause", type: "predicate", probability: 0.9 },
              { name: "match_grade", type: "choice", choice: "exact_match", confidence: 0.9 },
            ],
          };
        }
        if (entry.batchType === "precision") {
          return {
            index,
            ok: true,
            answers: [
              { name: "matches_baseline", type: "predicate", probability: 0.8 },
              { name: "concrete_defect", type: "predicate", probability: 0.85 },
              { name: "defect_value", type: "score", score: 3 },
            ],
          };
        }
        return {
          index,
          ok: true,
          answers: [
            { name: "signal_to_noise", type: "score", score: 3 },
            { name: "actionability", type: "score", score: 3 },
            { name: "overall_quality", type: "score", score: 3 },
          ],
        };
      });
      fs.mkdirSync(path.dirname(entry.arguments.outputFile), { recursive: true });
      fs.writeFileSync(entry.arguments.outputFile, JSON.stringify({
        state: "completed",
        batchId: `subset-batch-${entry.batchType}`,
        provider: "jev",
        count: entry.count,
        succeeded: entry.count,
        failed: 0,
        usage: { estimatedCostUsd: 0.002 },
        results,
      }));
    }

    const secondScore = spawnSync(process.execPath, [
      path.join(suiteDir, "score.mjs"),
      "--run", f.runDir,
      "--repo", f.repo,
      "--judge-provider", "jev",
      "--skip-prepare",
    ], { encoding: "utf8" });
    expect(secondScore.status, secondScore.stderr).toBe(0);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runDir, "eval-matrix-summary.json"), "utf8"));
    expect(summary.aggregates.all.codex.cases).toBe(1);

    // Blind cohorts must reject --cases subsets.
    const blindFixture = createScoringFixture({ blind: true });
    const blindSubset = spawnSync(process.execPath, [
      path.join(driversDir, "prepare-scoring-batches.mjs"),
      "--repo", blindFixture.repo,
      "--cohort", blindFixture.cohort,
      "--results", blindFixture.results,
      "--out", blindFixture.scoring,
      "--arms", "codex",
      "--cases", "case-secret-alpha",
    ], { encoding: "utf8" });
    expect(blindSubset.status).not.toBe(0);
    expect(blindSubset.stderr).toMatch(/Blind holdout cohorts cannot be scored with a --cases subset/i);
  });
});
