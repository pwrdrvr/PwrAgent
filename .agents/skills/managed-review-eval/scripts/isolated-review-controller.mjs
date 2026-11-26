#!/usr/bin/env node
/**
 * Controller-side orchestrator for isolated managed-review evaluations,
 * including blind holdout cohorts.
 *
 * Keeps the cohort file, settled baseline findings, judge inputs/outputs, and
 * raw holdout logs strictly on the controller side. Stages one minimal Git
 * snapshot and minimum review settings per cell into an ephemeral isolated
 * runner environment, enforces Default Access, validates pinned merge-base and
 * head metadata, and prints aggregate-only summaries for blind cohorts.
 *
 * Usage:
 *   node .agents/skills/managed-review-eval/scripts/isolated-review-controller.mjs \
 *     --repo "$PWD" \
 *     --cohort .agents/skills/managed-review-eval/cohorts/test-1.json \
 *     --out .local/managed-review-eval/runs/test-1-candidate \
 *     --arms codex,neon --concurrency 2
 *
 *   node .agents/skills/managed-review-eval/scripts/isolated-review-controller.mjs \
 *     --verify-isolation --arms codex,neon
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reviewedMergeBase } from "./review-range.mjs";
import { checkoutReviewSnapshot, writePinnedReviewPatch } from "./review-workspace.mjs";
import {
  assertProbePassed,
  buildIsolatedEnv,
  canonicalPath,
  createRestrictedBinDir,
  defaultRunnerParent,
  ensureGitCleanPathCheck,
  resolveDeniedRoots,
  resolveExecutable,
  resolveIsolationBackend,
  runReviewerIsolationProbe,
  spawnIsolatedProcess,
  stageIsolatedAntigravityHome,
  stageIsolatedCodexHome,
} from "./isolated-sandbox.mjs";

const runFile = promisify(execFile);
const MANAGED_ARMS = new Set(["codex", "neon"]);
const ARM_BACKEND = { codex: "codex", neon: "acp:antigravity" };
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// Covers runner's 90s backend warmup + 10s turn interrupt + 10s owner shutdown + 10s slack.
const CONTROLLER_WATCHDOG_SLACK_MS = 120_000;
const DEFAULT_DOCKER_NODE_PATH = "/opt/outpost-tools/node_modules:/usr/local/lib/node_modules";

function parseArg(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return fallback;
}

function parseMultiArg(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) {
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values;
}

function writeAtomicJson(file, record, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
}

function hasCommit(repoCwd, sha) {
  try {
    execFileSync("git", ["-C", repoCwd, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureCommitPresent(repoCwd, remote, prNumber, sha, env, signal) {
  if (!SHA_PATTERN.test(sha)) throw new Error("Expected a pinned commit SHA.");
  if (hasCommit(repoCwd, sha)) return;
  try {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`],
      { timeout: 60_000, env, signal },
    );
  } catch {
    signal?.throwIfAborted();
  }
  if (!hasCommit(repoCwd, sha)) {
    await runFile(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, sha],
      { timeout: 60_000, env, signal },
    );
  }
  if (!hasCommit(repoCwd, sha)) {
    throw new Error(`Pinned commit for PR #${prNumber} could not be fetched from ${remote}.`);
  }
}

function resolveIsolatedBundleDir(distDir) {
  const portableSubdir = path.join(distDir, "isolated");
  if (fs.existsSync(path.join(portableSubdir, "isolated-review-runner.js"))) {
    return portableSubdir;
  }
  return distDir;
}

function copyRunnerBundle(distDir, targetBundleDir) {
  const sourceDir = resolveIsolatedBundleDir(distDir);
  const runnerFile = path.join(sourceDir, "isolated-review-runner.js");
  if (!fs.existsSync(runnerFile)) {
    throw new Error(
      `Isolated runner bundle missing at ${runnerFile}. Build it first with build-eval-driver.mjs.`,
    );
  }
  fs.mkdirSync(targetBundleDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(sourceDir)) {
    if (!entry.endsWith(".js") || entry === "review-matrix-driver.js") continue;
    const src = path.join(sourceDir, entry);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(targetBundleDir, entry));
  }
  return path.join(targetBundleDir, "isolated-review-runner.js");
}

function computeBundleSha256(distDir) {
  const sourceDir = resolveIsolatedBundleDir(distDir);
  const hash = createHash("sha256");
  const files = fs.readdirSync(sourceDir)
    .filter((entry) => entry.endsWith(".js") && entry !== "review-matrix-driver.js")
    .sort();
  if (!files.includes("isolated-review-runner.js")) {
    throw new Error(`Missing isolated-review-runner.js in ${sourceDir}.`);
  }
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(sourceDir, file)));
  }
  return hash.digest("hex");
}

function buildMinimalRunnerJob({
  cellToken,
  arm,
  model,
  explicitNeonModel,
  reasoningEffort,
  timeoutMs,
  workspacePath,
  outputPath,
  pwragentHome,
  runtimeRoot,
  pinnedPatchFile,
  codexProtectedRoots,
  codexReadOnlyRoots,
  caseData,
  mergeBaseCommit,
}) {
  const prNumber = caseData.baseline.prNumber ?? caseData.pr;
  const prUrl = caseData.baseline.prUrl ?? `https://github.com/pwrdrvr/PwrAgent/pull/${prNumber}`;
  return {
    schemaVersion: 1,
    cellToken,
    arm,
    ...(model ? { model } : {}),
    ...(arm === "neon" && explicitNeonModel ? { explicitNeonModel: true } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    timeoutMs,
    workspacePath,
    outputPath,
    pwragentHome,
    runtimeRoot,
    ...(pinnedPatchFile ? { pinnedPatchFile } : {}),
    ...(arm === "codex" && codexProtectedRoots?.length ? { codexProtectedRoots } : {}),
    ...(arm === "codex" && codexReadOnlyRoots?.length ? { codexReadOnlyRoots } : {}),
    snapshot: {
      prNumber,
      prUrl,
      ...(caseData.baseline.prTitle ? { prTitle: caseData.baseline.prTitle } : {}),
      baseBranch: caseData.baseline.baseBranch || "main",
      headBranch: caseData.baseline.branch || `pr-${prNumber}`,
      baseCommit: caseData.baseline.baseCommit,
      headCommit: caseData.baseline.headCommit,
      mergeBaseCommit,
    },
  };
}

function terminateLaunchedProcess({ child, detached, containerName }, signal) {
  if (containerName) {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore", timeout: 10_000 });
  }
  if (detached && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child signal if process group already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function waitForChild(launched, timeoutMs) {
  const { child } = launched;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    const maxLogBytes = 256 * 1024;
    const appendBounded = (buf, chunk) => {
      if (buf.length >= maxLogBytes) return buf;
      return (buf + chunk.toString("utf8")).slice(0, maxLogBytes);
    };
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateLaunchedProcess(launched, "SIGTERM");
      killTimer = setTimeout(() => terminateLaunchedProcess(launched, "SIGKILL"), 10_000);
      killTimer.unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function archiveRawHoldoutLog({ rawLogsDir, cellToken, pwragentHome, stdout, stderr, exitInfo }) {
  fs.mkdirSync(rawLogsDir, { recursive: true, mode: 0o700 });
  const mainLog = path.join(pwragentHome, "profiles", "eval", "logs", "profile-eval.main.log");
  const sections = [
    `# Isolated eval cell ${cellToken}`,
    `exitCode=${exitInfo.code} signal=${exitInfo.signal ?? "none"} timedOut=${exitInfo.timedOut}`,
  ];
  if (stderr.trim()) sections.push("## runner stderr", stderr.trim());
  if (stdout.trim()) sections.push("## runner stdout", stdout.trim());
  if (fs.existsSync(mainLog)) {
    sections.push("## profile-eval.main.log", fs.readFileSync(mainLog, "utf8"));
  }
  fs.writeFileSync(
    path.join(rawLogsDir, `${cellToken}.log`),
    `${sections.join("\n\n")}\n`,
    { mode: 0o600 },
  );
}

/**
 * Run a self-contained synthetic canary isolation audit across the requested
 * managed arms without touching any published cohorts or provider tokens.
 */
export async function verifyIsolationWithSyntheticCanaries({
  arms = ["codex", "neon"],
  requestedIsolation = "auto",
  runnerParent = defaultRunnerParent(),
  codexCommand,
  dockerImage,
  seccompProfile,
  extraDeniedPaths = [],
} = {}) {
  const controllerTemp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-eval-canary-ctrl-")));
  const runnerTemp = canonicalPath(fs.mkdtempSync(path.join(runnerParent, "pwragent-eval-canary-run-")));
  const git = (cwd, ...args) => execFileSync("git", [
    "-C", cwd, "-c", "user.name=Canary", "-c", "user.email=canary@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  try {
    const repoDir = path.join(controllerTemp, "repo");
    const cohortDir = path.join(controllerTemp, "cohorts");
    const outDir = path.join(controllerTemp, "out");
    const scoringDir = path.join(outDir, "scoring");
    const rawLogsDir = path.join(outDir, "raw-logs");
    const hostHomeCanaryDir = path.join(controllerTemp, "host-home");
    for (const dir of [repoDir, cohortDir, scoringDir, rawLogsDir, hostHomeCanaryDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const token = randomBytes(12).toString("hex");
    const canaries = {
      cohortFile: { file: path.join(cohortDir, "synthetic-blind-cohort.json"), secret: `CANARY_COHORT_${token}` },
      settledBaseline: { file: path.join(cohortDir, "settled-baseline.json"), secret: `CANARY_BASELINE_${token}` },
      judgeInputs: { file: path.join(scoringDir, "recall-chunk-0.json"), secret: `CANARY_JUDGE_IN_${token}` },
      judgeOutputs: { file: path.join(scoringDir, "decision-output.json"), secret: `CANARY_JUDGE_OUT_${token}` },
      rawHoldoutLog: { file: path.join(rawLogsDir, "holdout.log"), secret: `CANARY_RAW_LOG_${token}` },
      sourceRepoFile: { file: path.join(repoDir, ".local-holdout-canary.txt"), secret: `CANARY_REPO_${token}` },
      hostHomeFile: { file: path.join(hostHomeCanaryDir, "host-secret.txt"), secret: `CANARY_HOME_${token}` },
    };

    // Build synthetic source Git repository with pre-merge-base, future-main,
    // unrelated-branch, and tag canary commits.
    git(repoDir, "init", "-q");
    fs.writeFileSync(path.join(repoDir, "src.ts"), `export const pre = "CANARY_PRE_MB_${token}";\n`);
    git(repoDir, "add", "src.ts");
    git(repoDir, "commit", "-qm", "pre-merge-base-canary");
    const preMergeBase = git(repoDir, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const value = 1;\n");
    git(repoDir, "commit", "-qam", "merge-base");
    const mergeBase = git(repoDir, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const value = 2;\n");
    git(repoDir, "commit", "-qam", "base-commit");
    const baseCommit = git(repoDir, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(repoDir, "future-holdout.json"), `{"secret":"CANARY_FUTURE_MAIN_${token}"}\n`);
    git(repoDir, "add", "future-holdout.json");
    git(repoDir, "commit", "-qm", "future-main-holdout");
    const futureMain = git(repoDir, "rev-parse", "HEAD");

    git(repoDir, "switch", "--quiet", "--detach", mergeBase);
    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const value = 42;\n");
    git(repoDir, "commit", "-qam", "pr-head");
    const headCommit = git(repoDir, "rev-parse", "HEAD");

    git(repoDir, "checkout", "-q", "-b", "secret-canary-branch", headCommit);
    fs.writeFileSync(path.join(repoDir, "branch-secret.txt"), `CANARY_BRANCH_${token}\n`);
    git(repoDir, "add", "branch-secret.txt");
    git(repoDir, "commit", "-qm", "unrelated-branch-canary");
    const otherBranch = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "tag", "canary-tag", futureMain);

    for (const entry of Object.values(canaries)) {
      fs.writeFileSync(entry.file, `${entry.secret}\n`, { mode: 0o600 });
    }
    const syntheticCase = {
      id: `synthetic-canary-${token}`,
      pr: 999999,
      backend: "codex",
      bucket: "codex-findings-high",
      baseline: {
        prNumber: 999999,
        prTitle: "Synthetic isolation probe",
        baseBranch: "main",
        branch: "synthetic-head",
        baseCommit,
        headCommit,
        items: [{ id: "b1", title: canaries.settledBaseline.secret, status: "addressed" }],
      },
    };
    fs.writeFileSync(
      canaries.cohortFile.file,
      JSON.stringify({ name: "synthetic-blind", blind: true, cases: [syntheticCase] }),
      { mode: 0o600 },
    );

    const canaryFiles = Object.fromEntries(
      Object.entries(canaries).map(([name, entry]) => [name, entry.file]),
    );
    const deniedWriteDirs = {
      outDir,
      cohortDir,
      repoDir,
      hostHomeCanaryDir,
    };
    const canaryCommits = { preMergeBase, futureMain, otherBranch };
    const report = { ok: true, platform: process.platform, arms: {} };

    for (const arm of arms) {
      if (!MANAGED_ARMS.has(arm)) throw new Error(`Unsupported managed arm: ${arm}`);
      const isolation = resolveIsolationBackend({ requested: requestedIsolation, arm });
      if (isolation === "docker" && !dockerImage) {
        throw new Error("Docker isolation verification requires --docker-image <image>.");
      }
      const cellToken = `probe-${arm}-${randomBytes(4).toString("hex")}`;
      const cellRoot = path.join(runnerTemp, cellToken);
      fs.mkdirSync(cellRoot, { recursive: true, mode: 0o700 });
      const rawWs = await checkoutReviewSnapshot({
        source: repoDir,
        parent: cellRoot,
        name: "ws",
        base: baseCommit,
        head: headCommit,
        mergeBase,
        blockRemotes: true,
      });
      const workspacePath = path.join(cellRoot, "workspace");
      fs.renameSync(rawWs, workspacePath);
      ensureGitCleanPathCheck(workspacePath, [controllerTemp, repoDir, outDir, cohortDir]);

      let pinnedPatchFile;
      if (arm === "neon") {
        pinnedPatchFile = await writePinnedReviewPatch(workspacePath, mergeBase, headCommit);
      }

      const bundleDir = path.join(cellRoot, "bundle");
      const runnerHome = path.join(cellRoot, "home");
      const pwragentHome = path.join(cellRoot, "pwragent-home");
      const runtimeRoot = path.join(cellRoot, "runtime");
      const resultDir = path.join(cellRoot, "result");
      const tmpDir = path.join(cellRoot, "tmp");
      const resultPath = path.join(resultDir, "cell-result.json");
      const codexHome = arm === "codex" ? path.join(cellRoot, "codex-home") : undefined;
      for (const dir of [bundleDir, runnerHome, pwragentHome, runtimeRoot, resultDir, tmpDir]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(path.join(bundleDir, "runner-stub.js"), "// immutable bundle marker\n");
      if (codexHome) stageIsolatedCodexHome({ sourceCodexHome: undefined, targetCodexHome: codexHome });
      if (arm === "neon") {
        stageIsolatedAntigravityHome({ sourceHome: undefined, targetHome: runnerHome, allowMacKeychain: false });
      }
      const restrictedBinDir = createRestrictedBinDir(cellRoot);
      const deniedRoots = resolveDeniedRoots({
        repoCwd: repoDir,
        cohortPath: canaries.cohortFile.file,
        outDir,
        extraDeniedPaths: [hostHomeCanaryDir, ...extraDeniedPaths],
        runnerRoot: cellRoot,
      });
      const codexProtectedRoots = [
        ...deniedRoots,
        path.join(cellRoot, "job.json"),
        resultDir,
        bundleDir,
        restrictedBinDir,
      ];

      const useContainerPaths = isolation === "docker";
      const mapPath = (hostPath) => (useContainerPaths
        ? path.posix.join("/eval", path.relative(cellRoot, hostPath).split(path.sep).join("/"))
        : hostPath);

      const job = buildMinimalRunnerJob({
        cellToken,
        arm,
        model: arm === "codex" ? "gpt-6.2-sol" : "gemini-4-neon",
        explicitNeonModel: false,
        reasoningEffort: arm === "codex" ? "xhigh" : "high",
        timeoutMs: 60_000,
        workspacePath: mapPath(workspacePath),
        outputPath: mapPath(resultPath),
        pwragentHome: mapPath(pwragentHome),
        runtimeRoot: mapPath(runtimeRoot),
        pinnedPatchFile,
        codexProtectedRoots: useContainerPaths ? undefined : codexProtectedRoots,
        codexReadOnlyRoots: useContainerPaths || !codexHome ? undefined : [codexHome],
        caseData: syntheticCase,
        mergeBaseCommit: mergeBase,
      });
      const serializedJob = JSON.stringify(job);
      for (const forbidden of [
        syntheticCase.id,
        syntheticCase.bucket,
        ...Object.values(canaries).map((c) => c.secret),
      ]) {
        if (serializedJob.includes(forbidden)) {
          throw new Error(`Runner job manifest leaked forbidden controller data (${arm}).`);
        }
      }

      const env = buildIsolatedEnv({
        arm,
        cellRoot: useContainerPaths ? "/eval" : cellRoot,
        pwragentHome: mapPath(pwragentHome),
        runnerHome: mapPath(runnerHome),
        codexHome: codexHome ? mapPath(codexHome) : undefined,
        restrictedBinDir: mapPath(restrictedBinDir),
        codexCommand: useContainerPaths ? undefined : codexCommand,
        createTmpDir: !useContainerPaths,
      });

      const prevCanary = process.env.PWRAGENT_HOLDOUT_CANARY;
      const prevGhToken = process.env.GH_TOKEN;
      process.env.PWRAGENT_HOLDOUT_CANARY = `ENV_CANARY_${token}`;
      process.env.GH_TOKEN = `GH_CANARY_${token}`;
      try {
        const probe = runReviewerIsolationProbe({
          isolation,
          arm,
          cellRoot,
          workspacePath,
          deniedRoots: arm === "codex" && isolation === "codex-sandbox" ? codexProtectedRoots : deniedRoots,
          canaryFiles,
          deniedWriteDirs,
          canaryCommits,
          expectedPatchFile: pinnedPatchFile,
          expectedWorkspaceFile: "src.ts",
          env,
          codexCommand,
          dockerImage,
          seccompProfile,
          allowReadSubpaths: [path.dirname(canonicalPath(process.execPath))],
        });
        const summary = assertProbePassed(probe);
        report.arms[arm] = { isolation, ...summary };
      } finally {
        if (prevCanary === undefined) delete process.env.PWRAGENT_HOLDOUT_CANARY;
        else process.env.PWRAGENT_HOLDOUT_CANARY = prevCanary;
        if (prevGhToken === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = prevGhToken;
      }
    }
    return report;
  } finally {
    fs.rmSync(controllerTemp, { recursive: true, force: true });
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
}

export async function runIsolatedMatrix(argv = process.argv.slice(2)) {
  if (argv.includes("--allow-full-access")) {
    throw new Error("The isolated reviewer runner preserves Default Access and rejects --allow-full-access.");
  }

  const armsArg = parseArg(argv, "--arms", "codex,neon");
  const requestedArms = [...new Set(armsArg.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!requestedArms.length || !requestedArms.every((arm) => MANAGED_ARMS.has(arm))) {
    throw new Error("Isolated reviewer runner supports only managed arms: codex, neon.");
  }
  const requestedIsolation = parseArg(argv, "--isolation", "auto");
  const runnerParent = canonicalPath(parseArg(argv, "--runner-root", defaultRunnerParent()));
  const extraDeniedPaths = parseMultiArg(argv, "--deny-path").map((p) => path.resolve(p));
  const codexBinArg = parseArg(argv, "--codex-bin", "") || undefined;
  const agyBinArg = parseArg(argv, "--agy-bin", "") || undefined;
  const dockerImage = parseArg(argv, "--docker-image", "") || undefined;
  const seccompProfile = parseArg(argv, "--seccomp-profile", "") || undefined;
  const dockerNodePath = parseArg(argv, "--docker-node-path", DEFAULT_DOCKER_NODE_PATH);

  if (argv.includes("--verify-isolation")) {
    const report = await verifyIsolationWithSyntheticCanaries({
      arms: requestedArms,
      requestedIsolation,
      runnerParent,
      codexCommand: codexBinArg,
      dockerImage,
      seccompProfile,
      extraDeniedPaths,
    });
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const repoCwd = canonicalPath(path.resolve(parseArg(argv, "--repo", process.cwd())));
  const cohortPathArg = parseArg(argv, "--cohort", "");
  if (!cohortPathArg) {
    throw new Error("Required flag: --cohort <cohort.json>");
  }
  const cohortPath = canonicalPath(path.resolve(cohortPathArg));
  const outDir = canonicalPath(
    path.resolve(parseArg(argv, "--out", path.join(repoCwd, ".local/managed-review-eval/isolated-run"))),
  );
  const distDir = canonicalPath(
    path.resolve(parseArg(argv, "--dist", path.join(repoCwd, ".local/managed-review-eval/dist"))),
  );
  const remote = parseArg(argv, "--remote", "origin");
  const casesArg = parseArg(argv, "--cases", "all");
  const timeoutMs = Number(parseArg(argv, "--timeout-ms", "900000"));
  const requestedConcurrency = Number(parseArg(argv, "--concurrency", "2"));
  const codexModel = parseArg(argv, "--codex-model", "gpt-6.2-sol");
  const codexEffort = parseArg(argv, "--codex-effort", "xhigh");
  const neonModel = parseArg(argv, "--neon-model", "gemini-4-neon");
  const explicitNeonModel = argv.includes("--neon-model");
  const neonEffort = parseArg(argv, "--neon-effort", "high");
  const force = argv.includes("--force");
  const sourceCodexHome = parseArg(
    argv,
    "--codex-home",
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  );

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(requestedConcurrency) || requestedConcurrency <= 0) {
    throw new Error("Concurrency and timeout must be positive integers within the supported bounds.");
  }

  const parsedCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8"));
  const allCases = Array.isArray(parsedCohort) ? parsedCohort : parsedCohort.cases;
  const blind = !Array.isArray(parsedCohort) && parsedCohort.blind === true;
  if (blind && casesArg !== "all") {
    throw new Error("Blind cohorts must run with --cases all to keep individual case identities private.");
  }

  const selectedCases = casesArg === "all"
    ? allCases
    : allCases.filter((c) => casesArg.split(",").map((id) => id.trim()).includes(c.id));
  if (!selectedCases.length || selectedCases.some((c) => !/^[A-Za-z0-9_-]+$/.test(c.id))
    || new Set(selectedCases.map((c) => c.id)).size !== selectedCases.length) {
    throw new Error("Select at least one case with a unique, valid case ID.");
  }
  const snapshotKeys = selectedCases.map((c) => `${c.baseline.prNumber ?? c.pr}:${c.baseline.headCommit}`);
  if (new Set(snapshotKeys).size !== selectedCases.length) {
    throw new Error("Each PR head must appear in only one matrix case.");
  }

  // Validate isolation backend availability for every requested arm up front.
  const isolationByArm = Object.fromEntries(
    requestedArms.map((arm) => [arm, resolveIsolationBackend({ requested: requestedIsolation, arm })]),
  );
  if (Object.values(isolationByArm).includes("docker") && !dockerImage) {
    throw new Error("Docker isolation requires --docker-image <image>.");
  }

  // Validate runnerRoot disjointness from sensitive and platform home/temp roots
  // before creating directories or launching any cells.
  resolveDeniedRoots({
    repoCwd,
    cohortPath,
    outDir,
    extraDeniedPaths,
    runnerRoot: runnerParent,
  });

  // Under codex-sandbox on macOS, /private/tmp cannot be denied while a cell
  // workspace lives in it. Serialize cells to concurrency 1 so no sibling cell
  // workspace, auth file, or result coexists in /private/tmp.
  const usesCodexSandbox = Object.values(isolationByArm).includes("codex-sandbox");
  const caseConcurrency = usesCodexSandbox ? 1 : requestedConcurrency;

  const bundleSha256 = computeBundleSha256(distDir);
  const resultsDir = path.join(outDir, "results");
  const rawLogsDir = path.join(outDir, "raw-logs");
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rawLogsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runnerParent, { recursive: true, mode: 0o700 });

  const sourceGitEnv = { ...process.env };
  const localGitVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  for (const key of localGitVariables.trim().split(/\s+/)) delete sourceGitEnv[key];

  const codexBin = codexBinArg || resolveExecutable("codex");
  const agyBin = agyBinArg
    || resolveExecutable("agy")
    || resolveExecutable(path.join(os.homedir(), ".local", "bin", "agy"));
  const hostNodePaths = [
    path.join(repoCwd, "apps", "desktop", "node_modules"),
    path.join(repoCwd, "node_modules"),
  ].filter((dir) => fs.existsSync(dir));
  const totals = { completed: 0, failed: 0, cancelled: 0, timeout: 0, skipped: 0 };

  if (blind) {
    console.log(
      `[eval] Starting isolated blind matrix (${selectedCases.length} cases x [${requestedArms.join(", ")}], concurrency=${caseConcurrency}, isolation=${JSON.stringify(isolationByArm)}).`,
    );
  } else {
    console.log(
      `[eval] Starting isolated matrix (${selectedCases.length} cases x [${requestedArms.join(", ")}], concurrency=${caseConcurrency}, out=${outDir}, isolation=${JSON.stringify(isolationByArm)}).`,
    );
  }

  async function runCell(c, arm) {
    const outPath = path.join(resultsDir, `${c.id}--${arm}.json`);
    const prNum = c.baseline.prNumber ?? c.pr;
    const backend = ARM_BACKEND[arm];
    const model = arm === "codex" ? codexModel : neonModel;
    const reasoningEffort = arm === "codex" ? codexEffort : neonEffort;
    const isolation = isolationByArm[arm];

    const identity = createHash("sha256").update(JSON.stringify({
      snapshot: {
        prNumber: prNum,
        baseCommit: c.baseline.baseCommit,
        headCommit: c.baseline.headCommit,
      },
      arm,
      backend,
      model,
      reasoningEffort,
      bundleSha256,
      executionMode: "default",
      isolation,
    })).digest("hex");

    if (!force && fs.existsSync(outPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if (existing.status === "completed" && existing.structured === true
          && Array.isArray(existing.findings) && existing.findingsCount === existing.findings.length
          && existing.identity === identity) {
          totals.skipped += 1;
          if (!blind) console.log(`[SKIP] ${c.id} | ${arm} | already completed`);
          return;
        }
      } catch {
        // Re-run malformed entries.
      }
    }

    const cellToken = `cell-${randomBytes(8).toString("hex")}`;
    const cellRoot = canonicalPath(fs.mkdtempSync(path.join(runnerParent, `pwragent-eval-${cellToken}-`)));
    fs.chmodSync(cellRoot, 0o700);
    const startedAt = Date.now();
    const setupAbort = new AbortController();

    try {
      await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.baseCommit, sourceGitEnv, setupAbort.signal);
      await ensureCommitPresent(repoCwd, remote, prNum, c.baseline.headCommit, sourceGitEnv, setupAbort.signal);
      const mergeBase = reviewedMergeBase(repoCwd, c.baseline.baseCommit, c.baseline.headCommit);

      const deniedRoots = resolveDeniedRoots({
        repoCwd,
        cohortPath,
        outDir,
        extraDeniedPaths,
        runnerRoot: cellRoot,
      });

      const rawWs = await checkoutReviewSnapshot({
        source: repoCwd,
        parent: cellRoot,
        name: "ws",
        base: c.baseline.baseCommit,
        head: c.baseline.headCommit,
        mergeBase,
        blockRemotes: true,
        signal: setupAbort.signal,
      });
      const workspacePath = path.join(cellRoot, "workspace");
      fs.renameSync(rawWs, workspacePath);
      ensureGitCleanPathCheck(workspacePath, [repoCwd, outDir, cohortPath]);

      let pinnedPatchFile;
      if (arm === "neon") {
        pinnedPatchFile = await writePinnedReviewPatch(workspacePath, mergeBase, c.baseline.headCommit, setupAbort.signal);
      }

      const bundleDir = path.join(cellRoot, "bundle");
      const runnerEntry = copyRunnerBundle(distDir, bundleDir);
      const runnerHome = path.join(cellRoot, "home");
      const pwragentHome = path.join(cellRoot, "pwragent-home");
      const runtimeRoot = path.join(cellRoot, "runtime");
      const resultDir = path.join(cellRoot, "result");
      const tmpDir = path.join(cellRoot, "tmp");
      const hostOutputPath = path.join(resultDir, "cell-result.json");
      const codexHome = arm === "codex" ? path.join(cellRoot, "codex-home") : undefined;

      for (const dir of [runnerHome, pwragentHome, path.join(runtimeRoot, "resources"), resultDir, tmpDir]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      if (codexHome) {
        stageIsolatedCodexHome({ sourceCodexHome, targetCodexHome: codexHome });
      }
      let agyKeychainPath;
      if (arm === "neon") {
        ({ keychainPath: agyKeychainPath } = stageIsolatedAntigravityHome({
          sourceHome: os.homedir(),
          targetHome: runnerHome,
          allowMacKeychain: process.platform === "darwin" && isolation !== "docker",
        }));
      }

      const restrictedBinDir = createRestrictedBinDir(cellRoot);
      const useContainerPaths = isolation === "docker";
      const mapPath = (hostPath) => (useContainerPaths
        ? path.posix.join("/eval", path.relative(cellRoot, hostPath).split(path.sep).join("/"))
        : hostPath);

      const hostJobPath = path.join(cellRoot, "job.json");
      const codexProtectedRoots = useContainerPaths
        ? undefined
        : [
            ...deniedRoots,
            hostJobPath,
            resultDir,
            bundleDir,
            restrictedBinDir,
          ];

      const runnerJob = buildMinimalRunnerJob({
        cellToken,
        arm,
        model,
        explicitNeonModel,
        reasoningEffort,
        timeoutMs,
        workspacePath: mapPath(workspacePath),
        outputPath: mapPath(hostOutputPath),
        pwragentHome: mapPath(pwragentHome),
        runtimeRoot: mapPath(runtimeRoot),
        pinnedPatchFile,
        codexProtectedRoots,
        codexReadOnlyRoots: useContainerPaths || !codexHome ? undefined : [codexHome],
        caseData: c,
        mergeBaseCommit: mergeBase,
      });
      writeAtomicJson(hostJobPath, runnerJob, 0o600);

      const env = buildIsolatedEnv({
        arm,
        cellRoot: useContainerPaths ? "/eval" : cellRoot,
        pwragentHome: mapPath(pwragentHome),
        runnerHome: mapPath(runnerHome),
        codexHome: codexHome ? mapPath(codexHome) : undefined,
        restrictedBinDir: mapPath(restrictedBinDir),
        antigravityCliPath: !useContainerPaths && arm === "neon" ? agyBin : undefined,
        codexCommand: !useContainerPaths && arm === "codex" ? codexBin : undefined,
        nodePaths: useContainerPaths ? dockerNodePath.split(":").filter(Boolean) : hostNodePaths,
        createTmpDir: !useContainerPaths,
      });

      const allowReadSubpaths = [];
      const allowReadLiterals = [];
      if (!useContainerPaths) {
        allowReadSubpaths.push(...hostNodePaths);
        allowReadSubpaths.push(path.dirname(canonicalPath(process.execPath)));
        if (arm === "codex" && codexBin) {
          allowReadSubpaths.push(path.dirname(canonicalPath(codexBin)));
          allowReadLiterals.push(canonicalPath(codexBin));
        }
        if (arm === "neon" && agyBin) {
          allowReadSubpaths.push(path.dirname(canonicalPath(agyBin)));
          allowReadLiterals.push(canonicalPath(agyBin));
        }
        if (arm === "neon" && agyKeychainPath) {
          allowReadSubpaths.push(agyKeychainPath);
        }
      }

      if (!blind) {
        console.log(`[START] ${c.id} | ${arm} | isolation=${isolation}`);
      }

      const launched = spawnIsolatedProcess({
        isolation,
        command: useContainerPaths ? "node" : process.execPath,
        args: [mapPath(runnerEntry), "--job", mapPath(hostJobPath)],
        cwd: workspacePath,
        env,
        cellRoot,
        workspacePath,
        deniedRoots,
        allowReadSubpaths,
        allowReadLiterals,
        dockerImage,
        dockerContainerName: useContainerPaths ? `pwragent-eval-${cellToken}` : undefined,
        seccompProfile,
      });

      const exitInfo = await waitForChild(launched, timeoutMs + CONTROLLER_WATCHDOG_SLACK_MS);
      archiveRawHoldoutLog({
        rawLogsDir,
        cellToken,
        pwragentHome,
        stdout: exitInfo.stdout,
        stderr: exitInfo.stderr,
        exitInfo,
      });

      let runnerResult;
      if (fs.existsSync(hostOutputPath)) {
        try {
          runnerResult = JSON.parse(fs.readFileSync(hostOutputPath, "utf8"));
        } catch {
          runnerResult = undefined;
        }
      }

      let record;
      if (runnerResult
        && runnerResult.cellToken === cellToken
        && runnerResult.arm === arm
        && runnerResult.executionMode === "default"
        && runnerResult.baseCommit === c.baseline.baseCommit
        && runnerResult.headCommit === c.baseline.headCommit
        && runnerResult.mergeBaseCommit === mergeBase) {
        const { cellToken: _token, ...runnerFields } = runnerResult;
        record = {
          identity,
          caseId: c.id,
          prNumber: prNum,
          baseBranch: c.baseline.baseBranch,
          ...runnerFields,
          isolation: { mode: isolation, cellToken },
        };
      } else {
        const errorMessage = exitInfo.timedOut
          ? `Isolated runner timed out after ${timeoutMs}ms`
          : `Isolated runner exited with code ${exitInfo.code ?? "null"} without a valid cell result.`;
        record = {
          identity,
          caseId: c.id,
          prNumber: prNum,
          arm,
          backend,
          model,
          baseCommit: c.baseline.baseCommit,
          headCommit: c.baseline.headCommit,
          mergeBaseCommit: mergeBase,
          workspacePath: mapPath(workspacePath),
          baseBranch: c.baseline.baseBranch,
          reasoningEffort: reasoningEffort ?? null,
          executionMode: "default",
          status: exitInfo.timedOut ? "timeout" : "failed",
          error: errorMessage,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          approvals: 0,
          structured: false,
          findingsCount: 0,
          overallCorrectness: null,
          overallConfidence: null,
          overallExplanation: null,
          findings: [],
          reviewText: null,
          ledger: null,
          completedAt: new Date().toISOString(),
          isolation: { mode: isolation, cellToken },
        };
      }

      writeAtomicJson(outPath, record, 0o600);
      totals[record.status] = (totals[record.status] ?? 0) + 1;
      if (!blind) {
        console.log(
          `[DONE] ${c.id} | ${arm} | ${record.status} | ${record.findingsCount} findings${record.error ? ` | ${record.error}` : ""}`,
        );
      }
    } finally {
      fs.rmSync(cellRoot, { recursive: true, force: true });
    }
  }

  let nextIdx = 0;
  let fatalError;
  const workers = Array.from(
    { length: Math.min(caseConcurrency, selectedCases.length) },
    async () => {
      while (!fatalError) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= selectedCases.length) return;
        const c = selectedCases[idx];
        for (const arm of requestedArms) {
          if (fatalError) break;
          try {
            await runCell(c, arm);
          } catch (error) {
            fatalError = error;
            break;
          }
        }
      }
    },
  );
  await Promise.all(workers);

  console.log(`[eval] Isolated cell totals: ${JSON.stringify(totals)}`);
  if (fatalError) {
    if (blind) {
      try {
        fs.mkdirSync(rawLogsDir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(
          path.join(rawLogsDir, "controller-error.log"),
          `${new Date().toISOString()} ${fatalError instanceof Error ? fatalError.stack ?? fatalError.message : String(fatalError)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // Keep diagnostic private even if logging fails.
      }
      throw new Error("Isolated blind matrix encountered an error. Inspect controller raw logs locally.");
    }
    throw fatalError;
  }
  return { totals, isolationByArm };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runIsolatedMatrix().catch((error) => {
    process.stderr.write(`[eval] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
