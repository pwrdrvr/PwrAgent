#!/usr/bin/env node
/**
 * Unified CLI for the PwrAgent managed-review evaluation suite.
 *
 * Examples:
 *   pnpm eval:review -- --cohort dev-1 --cases pr4385-codex --arms codex,codex-native,neon --out evals/runs/smoke
 *   pnpm eval:review -- --cohort dev-1 --rev v1.5.1 --arms codex --out evals/runs/v1.5.1
 *   pnpm eval:review -- --cohort dev-1 --prompt /tmp/variant.md --arms codex,neon --out evals/runs/prompt-v2
 *   pnpm eval:review -- --cohort test-1 --arms codex,neon --out evals/runs/test-1-candidate
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareRevisionBundle } from "../shared/revision-builder.mjs";
import { resolveSafeWorkspaceParent } from "../shared/workspace-staging.mjs";

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const evalsDir = path.resolve(suiteDir, "..");
const repoRoot = path.resolve(evalsDir, "..");
const cohortsDir = path.join(suiteDir, "cohorts");
const driversDir = path.join(suiteDir, "drivers");
const callerCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();

function stripLeadingDoubleDash(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

export function resolveCohortPath(cohortArg, defaultCohortsDir = cohortsDir) {
  if (!cohortArg) return path.join(defaultCohortsDir, "dev-1.json");
  const named = path.join(defaultCohortsDir, cohortArg.endsWith(".json") ? cohortArg : `${cohortArg}.json`);
  if (!cohortArg.includes("/") && !cohortArg.includes("\\") && fs.existsSync(named)) {
    return named;
  }
  return path.resolve(callerCwd, cohortArg);
}

export function parseRunCliArgs(argv) {
  return parseArgs({
    args: stripLeadingDoubleDash(argv),
    allowPositionals: false,
    options: {
      cohort: { type: "string", default: "dev-1" },
      out: { type: "string" },
      repo: { type: "string", default: repoRoot },
      arms: { type: "string", default: "codex,neon" },
      cases: { type: "string", default: "all" },
      rev: { type: "string" },
      prompt: { type: "string" },
      "codex-model": { type: "string" },
      "codex-effort": { type: "string" },
      "neon-model": { type: "string" },
      "neon-effort": { type: "string" },
      "neon-mode": { type: "string", default: "plan" },
      "claude-model": { type: "string" },
      "claude-effort": { type: "string" },
      concurrency: { type: "string", default: "2" },
      "timeout-ms": { type: "string", default: "900000" },
      remote: { type: "string", default: "origin" },
      "workspace-root": { type: "string" },
      "keep-workspaces": { type: "boolean", default: false },
      isolated: { type: "boolean", default: false },
      isolation: { type: "string", default: "auto" },
      "runner-root": { type: "string" },
      "docker-image": { type: "string" },
      "seccomp-profile": { type: "string" },
      "deny-path": { type: "string", multiple: true },
      "allow-full-access": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }).values;
}

function usage() {
  return [
    "Usage: pnpm eval:review -- --out <dir> [options]",
    "",
    "Options:",
    "  --cohort <name|path>     Cohort name (dev-1, dev-2, test-1, test-2) or JSON path (default: dev-1)",
    "  --out <dir>              Output directory for durable cell results and run-meta.json (required)",
    "  --arms <list>            Comma-separated arms: codex, codex-native, neon, claude-native (default: codex,neon)",
    "  --cases <all|ids>        Case IDs to run (default: all; blind cohorts require all)",
    "  --rev <git-ref>          Git commit/tag/branch to benchmark (default: current working tree)",
    "  --prompt <file>          Candidate guidance markdown overriding managed-review-guidance-ledger.md",
    "  --codex-model <id>       Codex model ID (default: gpt-6.2-sol)",
    "  --codex-effort <level>   Codex reasoning effort (default: xhigh)",
    "  --neon-model <id>        Antigravity Neon model ID (default: gemini-4-neon)",
    "  --neon-effort <level>    Antigravity Neon reasoning effort (default: high)",
    "  --neon-mode <plan|auto>  Neon mode under OS-enforced isolation (default: plan)",
    "  --workspace-root <dir>   Safe staging parent outside ~/.codex (default: /tmp/pwragent-eval-workspaces)",
    "  --keep-workspaces        Retain staged workspaces after each cell finishes",
    "  --isolated               Force OS-isolated runner even on dev cohorts (automatic for blind cohorts)",
    "  --isolation <backend>    Isolation backend: auto, seatbelt, bwrap, codex-sandbox, docker",
    "  --concurrency <n>        Parallel cases in flight (default: 2)",
    "  --timeout-ms <ms>        Per-cell timeout in milliseconds (default: 900000)",
    "  --force                  Re-run cells that already completed with matching identity",
    "  --rebuild                Force rebuilding cached revision bundle",
    "  --dry-run                Validate cohort, staging root, and build plan without invoking models",
  ].join("\n");
}

function main() {
  const args = parseRunCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.out) {
    throw new Error(`Missing required flag --out <dir>.\n\n${usage()}`);
  }

  const repoCwd = path.resolve(callerCwd, args.repo);
  const cohortPath = resolveCohortPath(args.cohort);
  if (!fs.existsSync(cohortPath)) {
    throw new Error(`Cohort file not found: ${cohortPath}`);
  }
  const parsedCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8"));
  const blind = !Array.isArray(parsedCohort) && parsedCohort.blind === true;
  const cohortName = !Array.isArray(parsedCohort) && parsedCohort.name
    ? parsedCohort.name
    : path.basename(cohortPath, ".json");
  const arms = [...new Set(args.arms.split(",").map((s) => s.trim()).filter(Boolean))];
  const nativeClaudeCollection = arms.length === 1 && arms[0] === "claude-native";
  const useIsolated = (blind && !nativeClaudeCollection) || args.isolated;

  if (args["neon-mode"] !== "plan" && args["neon-mode"] !== "auto") {
    throw new Error("--neon-mode must be plan or auto.");
  }
  if (args["neon-mode"] === "auto" && !useIsolated) {
    throw new Error("--neon-mode auto requires OS-enforced isolation (--isolated or a blind cohort).");
  }

  const outDir = path.resolve(callerCwd, args.out);
  const promptPath = args.prompt ? path.resolve(callerCwd, args.prompt) : undefined;
  const workspaceParent = useIsolated
    ? undefined
    : resolveSafeWorkspaceParent({
        requestedParent: args["workspace-root"] ? path.resolve(callerCwd, args["workspace-root"]) : undefined,
        env: process.env,
        pwragentHome: path.join(outDir, "pwragent-home"),
      });

  if (args["dry-run"]) {
    console.log(JSON.stringify({
      dryRun: true,
      repoCwd,
      cohortName,
      cohortPath,
      blind,
      useIsolated,
      arms,
      cases: args.cases,
      rev: args.rev ?? "WORKTREE",
      prompt: promptPath ?? null,
      outDir,
      workspaceParent: workspaceParent ?? "(isolated ephemeral cell root)",
    }, null, 2));
    return;
  }

  const bundle = prepareRevisionBundle({
    repoCwd,
    buildScriptPath: path.join(driversDir, "build-driver.mjs"),
    cacheRoot: path.join(evalsDir, ".cache", "revs"),
    rev: args.rev,
    promptPath,
    forceRebuild: args.rebuild,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const runMeta = {
    schemaVersion: 1,
    suite: "managed-review",
    cohortName,
    cohortPath,
    blind,
    repoCwd,
    arms,
    cases: args.cases,
    isolated: useIsolated,
    isolation: useIsolated ? args.isolation : "local-safe-staging",
    rev: args.rev ?? "WORKTREE",
    commitSha: bundle.commitSha,
    revLabel: bundle.revLabel,
    prompt: bundle.prompt,
    codexModel: args["codex-model"] ?? "gpt-6.2-sol",
    codexEffort: args["codex-effort"] ?? "xhigh",
    neonModel: args["neon-model"] ?? "gemini-4-neon",
    neonEffort: args["neon-effort"] ?? "high",
    neonMode: args["neon-mode"],
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "run-meta.json"), `${JSON.stringify(runMeta, null, 2)}\n`);

  const childArgs = [];
  if (useIsolated) {
    childArgs.push(
      path.join(driversDir, "isolated-controller.mjs"),
      "--repo", repoCwd,
      "--dist", bundle.distDir,
      "--cohort", cohortPath,
      "--out", outDir,
      "--arms", arms.join(","),
      "--cases", args.cases,
      "--concurrency", args.concurrency,
      "--timeout-ms", args["timeout-ms"],
      "--remote", args.remote,
      "--isolation", args.isolation,
      "--neon-mode", args["neon-mode"],
      "--rev-label", bundle.revLabel,
    );
    if (bundle.prompt) childArgs.push("--prompt-sha256", bundle.prompt.sha256);
    if (args["runner-root"]) childArgs.push("--runner-root", args["runner-root"]);
    if (args["docker-image"]) childArgs.push("--docker-image", args["docker-image"]);
    if (args["seccomp-profile"]) childArgs.push("--seccomp-profile", args["seccomp-profile"]);
    for (const denied of args["deny-path"] ?? []) childArgs.push("--deny-path", denied);
  } else {
    childArgs.push(
      path.join(bundle.distDir, "review-matrix-driver.js"),
      "--repo", repoCwd,
      "--cohort", cohortPath,
      "--out", outDir,
      "--arms", arms.join(","),
      "--cases", args.cases,
      "--concurrency", args.concurrency,
      "--timeout-ms", args["timeout-ms"],
      "--remote", args.remote,
      "--workspace-root", workspaceParent,
      "--rev-label", bundle.revLabel,
    );
    if (bundle.prompt) childArgs.push("--prompt-sha256", bundle.prompt.sha256);
    if (args["keep-workspaces"]) childArgs.push("--keep-workspaces");
    if (args["allow-full-access"]) childArgs.push("--allow-full-access");
  }

  if (args["codex-model"]) childArgs.push("--codex-model", args["codex-model"]);
  if (args["codex-effort"]) childArgs.push("--codex-effort", args["codex-effort"]);
  if (args["neon-model"]) childArgs.push("--neon-model", args["neon-model"]);
  if (args["neon-effort"]) childArgs.push("--neon-effort", args["neon-effort"]);
  if (args["claude-model"]) childArgs.push("--claude-model", args["claude-model"]);
  if (args["claude-effort"]) childArgs.push("--claude-effort", args["claude-effort"]);
  if (args.force) childArgs.push("--force");

  const result = spawnSync(process.execPath, childArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
