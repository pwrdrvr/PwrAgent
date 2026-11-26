#!/usr/bin/env node
/**
 * Unified scoring CLI for the PwrAgent managed-review evaluation suite.
 *
 * Defaults to PwrAgent's built-in Jev decision provider (`--judge-provider jev`)
 * and supports all PwrAgent decision providers: `jev`, `local` (Cloudflare Clef),
 * `openai`, or `default` (operator's configured Settings default).
 *
 * Two execution modes:
 *   - `--mode mcp` (default): prepares file-backed batches for PwrAgent's
 *     `decisions_invoke` MCP proxy (caller needs NO API key; PwrAgent uses its
 *     saved Settings credentials). Once batches finish, re-running records and
 *     aggregates `eval-matrix-summary.json` + `summary.md`.
 *   - `--mode direct`: runs pending batches directly from the CLI via PwrAgent's
 *     System One (`jev`, `local`/Clef) or OpenAI Decisions client (supports
 *     `--decision-endpoint` for local Clef or custom proxies without an API key),
 *     then records and aggregates in a single command.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareRevisionBundle } from "../shared/revision-builder.mjs";
import { collectDecisionFileBatches } from "./drivers/decision-file-batches.mjs";
import { resolveCohortPath } from "./run.mjs";

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.resolve(suiteDir, "..");
const repoRoot = path.resolve(evalsDir, "..");
const driversDir = path.join(suiteDir, "drivers");
const callerCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();

function stripLeadingDoubleDash(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function runNode(scriptPath, args) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.exitCode = res.status ?? 1;
    return false;
  }
  return true;
}

function usage() {
  return [
    "Usage: pnpm eval:review:score -- --run <dir> [options]",
    "",
    "Options:",
    "  --run <dir>                   Run directory containing results/ and run-meta.json (required)",
    "  --cohort <name|path>          Override cohort path (default: read from run-meta.json)",
    "  --arms <list>                 Override arms list (default: read from run-meta.json)",
    "  --repo <dir>                  Repository checkout for git diffs (default: repo root)",
    "  --judge-provider <id>         Decision provider: jev (default), local, openai, or default",
    "  --mode <mcp|direct>           mcp = PwrAgent decisions_invoke proxy (no API key); direct = standalone CLI",
    "  --decision-endpoint <url>     Direct-mode endpoint override (for example http://127.0.0.1:8787)",
    "  --decision-model <id>         Direct-mode model override (for example jev-latest or clef-flash)",
    "  --concurrency <n>             Direct-mode batch concurrency (default: 8)",
    "  --allow-legacy-baselines      Allow scoring development cohorts with unverified baseline ranges",
    "  --allow-inspect-test          Permit per-case output on blind cohorts (keep off during tuning)",
    "  --skip-prepare                Reuse already prepared scoring/ chunks",
  ].join("\n");
}

function main() {
  const { values } = parseArgs({
    args: stripLeadingDoubleDash(process.argv.slice(2)),
    allowPositionals: false,
    options: {
      run: { type: "string" },
      cohort: { type: "string" },
      arms: { type: "string" },
      repo: { type: "string", default: repoRoot },
      "judge-provider": { type: "string", default: "jev" },
      mode: { type: "string", default: "mcp" },
      "decision-endpoint": { type: "string" },
      "decision-model": { type: "string" },
      concurrency: { type: "string", default: "8" },
      "allow-legacy-baselines": { type: "boolean", default: false },
      "allow-inspect-test": { type: "boolean", default: false },
      "skip-prepare": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.run) {
    throw new Error(`Missing required flag --run <dir>.\n\n${usage()}`);
  }
  if (values.mode !== "mcp" && values.mode !== "direct") {
    throw new Error("--mode must be mcp or direct.");
  }

  const runDir = path.resolve(callerCwd, values.run);
  const metaPath = path.join(runDir, "run-meta.json");
  const runMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};

  const cohortPath = values.cohort
    ? resolveCohortPath(values.cohort)
    : runMeta.cohortPath
      ? path.resolve(runMeta.cohortPath)
      : undefined;
  if (!cohortPath || !fs.existsSync(cohortPath)) {
    throw new Error("Could not resolve cohort file. Pass --cohort <name|path>.");
  }
  const arms = values.arms ?? (Array.isArray(runMeta.arms) ? runMeta.arms.join(",") : "codex,neon");
  const repoCwd = path.resolve(callerCwd, values.repo);
  const resultsDir = path.join(runDir, "results");
  const scoringDir = path.join(runDir, "scoring");

  if (!values["skip-prepare"]) {
    const prepArgs = [
      "--repo", repoCwd,
      "--cohort", cohortPath,
      "--results", resultsDir,
      "--out", scoringDir,
      "--arms", arms,
      "--judge-provider", values["judge-provider"],
    ];
    if (values["allow-legacy-baselines"]) prepArgs.push("--allow-legacy-baselines");
    if (!runNode(path.join(driversDir, "prepare-scoring-batches.mjs"), prepArgs)) return;
  }

  const status = collectDecisionFileBatches(scoringDir, false);
  if (status.pending.length > 0) {
    if (values.mode === "direct") {
      const bundle = prepareRevisionBundle({
        repoCwd,
        buildScriptPath: path.join(driversDir, "build-driver.mjs"),
        cacheRoot: path.join(evalsDir, ".cache", "revs"),
      });
      const directArgs = [
        "--scoring", scoringDir,
        "--concurrency", values.concurrency,
      ];
      if (values["decision-endpoint"]) directArgs.push("--decision-endpoint", values["decision-endpoint"]);
      if (values["decision-model"]) directArgs.push("--decision-model", values["decision-model"]);
      if (!runNode(path.join(bundle.distDir, "direct-decision-scorer.js"), directArgs)) return;
    } else {
      console.log(JSON.stringify({
        mode: "mcp",
        judgeProvider: values["judge-provider"],
        complete: status.complete,
        pendingCount: status.pending.length,
        instructions: "Invoke PwrAgent's decisions_invoke tool for each pending entry with its arguments object (inlineResults: false), then re-run this command with --skip-prepare.",
        pending: status.pending,
      }, null, 2));
      return;
    }
  }

  const recorded = collectDecisionFileBatches(scoringDir, true);
  console.log(`[eval] Recorded ${recorded.complete} Decision scoring batch(es).`);

  const aggArgs = [
    "--cohort", cohortPath,
    "--results", resultsDir,
    "--scoring", scoringDir,
    "--out", runDir,
  ];
  if (values["allow-inspect-test"]) aggArgs.push("--allow-inspect-test");
  runNode(path.join(driversDir, "aggregate-eval-scores.mjs"), aggArgs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
