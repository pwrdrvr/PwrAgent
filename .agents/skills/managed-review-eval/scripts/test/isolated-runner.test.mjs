import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertProbePassed,
  buildDockerArgs,
  canonicalPath,
  defaultRunnerParent,
  ensureGitCleanPathCheck,
  hasCommand,
  resolveIsolationBackend,
  stageIsolatedAntigravityHome,
  stageIsolatedCodexHome,
} from "../isolated-sandbox.mjs";
import { verifyIsolationWithSyntheticCanaries } from "../isolated-review-controller.mjs";
import { reviewedMergeBase } from "../review-range.mjs";
import { checkoutReviewSnapshot } from "../review-workspace.mjs";

const require = createRequire(new URL("../../../../../apps/desktop/package.json", import.meta.url));
const { build } = require("esbuild");
const scriptsDir = fileURLToPath(new URL("../", import.meta.url));
const runnerEntrySource = path.join(scriptsDir, "isolated-review-runner.ts");
const controllerScript = path.join(scriptsDir, "isolated-review-controller.mjs");

function makeGit(cwd) {
  return (...args) => execFileSync("git", [
    "-C", cwd,
    "-c", "user.name=Synthetic",
    "-c", "user.email=synthetic@example.com",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createSyntheticRepoWithCanaries(root, { withPreMergeBaseSideMerge = false } = {}) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = makeGit(repo);
  git("init", "-q");

  fs.writeFileSync(path.join(repo, "example.txt"), "PRE_MERGE_BASE_CANARY\n");
  git("add", "example.txt");
  git("commit", "-qm", "pre-merge-base-canary");
  const preMergeBase = git("rev-parse", "HEAD");

  fs.writeFileSync(path.join(repo, "example.txt"), "common\n");
  git("commit", "-qam", "merge-base");
  const mergeBase = git("rev-parse", "HEAD");

  fs.writeFileSync(path.join(repo, "example.txt"), "common\nbase-only\n");
  git("commit", "-qam", "base-commit");
  const baseCommit = git("rev-parse", "HEAD");

  fs.writeFileSync(path.join(repo, "holdout-canary.json"), '{"secret":"FUTURE_MAIN_CANARY"}\n');
  git("add", "holdout-canary.json");
  git("commit", "-qm", "future-main-holdout");
  const futureMain = git("rev-parse", "HEAD");

  git("switch", "--quiet", "--detach", mergeBase);
  fs.writeFileSync(path.join(repo, "example.txt"), "common\nreviewed-head-line\n");
  git("commit", "-qam", "pr-head-1");
  let headCommit = git("rev-parse", "HEAD");

  if (withPreMergeBaseSideMerge) {
    // Exercise a merge commit inside mergeBase..head whose second parent is a
    // strict ancestor of mergeBase (so naive shallowing would disconnect head).
    git("merge", "--no-ff", "-q", "-m", "merge-old-ancestor", preMergeBase);
    headCommit = git("rev-parse", "HEAD");
  }

  git("checkout", "-q", "-b", "secret-canary-branch", headCommit);
  fs.writeFileSync(path.join(repo, "branch-canary.txt"), "UNRELATED_BRANCH_CANARY\n");
  git("add", "branch-canary.txt");
  git("commit", "-qm", "unrelated-branch-canary");
  const otherBranch = git("rev-parse", "HEAD");
  git("tag", "secret-canary-tag", futureMain);

  // Switch back to futureMain so HEAD of the source checkout holds future holdout files.
  git("switch", "--quiet", "--detach", futureMain);

  return { repo, git, preMergeBase, mergeBase, baseCommit, headCommit, futureMain, otherBranch };
}

test("minimal Git snapshot strips forbidden object history, reflogs, and blocks all remotes", async (t) => {
  for (const withPreMergeBaseSideMerge of [false, true]) {
    await t.test(`side-merge=${withPreMergeBaseSideMerge}`, async () => {
      const tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "iso-git-")));
      t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
      const fixture = createSyntheticRepoWithCanaries(tmp, { withPreMergeBaseSideMerge });
      const wsParent = path.join(tmp, "staged");
      fs.mkdirSync(wsParent, { recursive: true });
      const ws = await checkoutReviewSnapshot({
        source: fixture.repo,
        parent: wsParent,
        name: "cell",
        base: fixture.baseCommit,
        head: fixture.headCommit,
        mergeBase: fixture.mergeBase,
        blockRemotes: true,
      });

      const wsGit = makeGit(ws);
      assert.equal(wsGit("rev-parse", "HEAD"), fixture.headCommit);
      assert.equal(reviewedMergeBase(ws, fixture.baseCommit, fixture.headCommit), fixture.mergeBase);
      assert.equal(
        wsGit("diff", fixture.mergeBase, fixture.headCommit),
        fixture.git("diff", fixture.mergeBase, fixture.headCommit),
      );
      ensureGitCleanPathCheck(ws, [tmp, fixture.repo]);

      // Future main and unrelated branch commits must never exist in the object store.
      for (const forbidden of [fixture.futureMain, fixture.otherBranch]) {
        const res = spawnSync("git", ["-C", ws, "cat-file", "-e", `${forbidden}^{commit}`], { encoding: "utf8" });
        assert.notEqual(res.status, 0, `forbidden commit ${forbidden} should be absent`);
      }
      if (!withPreMergeBaseSideMerge) {
        const pre = spawnSync("git", ["-C", ws, "cat-file", "-e", `${fixture.preMergeBase}^{commit}`], { encoding: "utf8" });
        assert.notEqual(pre.status, 0, "pre-merge-base commit should be absent");
      }

      // No tags, no branches, only refs/eval/{base,head,merge-base}.
      assert.equal(wsGit("tag", "-l"), "");
      const refs = wsGit("for-each-ref", "--format=%(refname)").split("\n").sort();
      assert.deepEqual(refs, ["refs/eval/base", "refs/eval/head", "refs/eval/merge-base"]);
      assert.equal(wsGit("remote", "get-url", "origin"), "https://github.com/pwrdrvr/PwrAgent.git");

      // Remote fetches and ls-remote must fail closed for both https and file transports.
      const lsOrigin = spawnSync("git", ["-C", ws, "ls-remote", "origin"], { encoding: "utf8" });
      assert.notEqual(lsOrigin.status, 0);
      assert.match(lsOrigin.stderr, /not allowed/i);
      const lsLocal = spawnSync("git", ["-C", ws, "ls-remote", fixture.repo], { encoding: "utf8" });
      assert.notEqual(lsLocal.status, 0);
      assert.match(lsLocal.stderr, /not allowed/i);
    });
  }
});

test("synthetic canary isolation proof succeeds across both managed arms and fails when a canary leaks", async () => {
  const armsToVerify = [];
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    armsToVerify.push("neon");
    if (hasCommand("codex")) armsToVerify.push("codex");
  } else if (process.platform === "linux" && hasCommand("bwrap")) {
    armsToVerify.push("neon", "codex");
  }
  assert.ok(armsToVerify.length > 0, "Host must support at least one OS isolation backend for canary verification.");

  const report = await verifyIsolationWithSyntheticCanaries({ arms: armsToVerify });
  assert.equal(report.ok, true);
  for (const arm of armsToVerify) {
    assert.equal(report.arms[arm].ok, true);
    assert.equal(report.arms[arm].checkedCanaries, 7);
    assert.equal(report.arms[arm].checkedCommits, 3);
  }

  // Non-vacuity check: assertProbePassed must reject a readable canary or open remote.
  assert.throws(() => assertProbePassed({
    canaryReads: { cohortFile: { blocked: false, leaked: "SECRET" } },
    gitCommits: { futureMain: { absent: true } },
    hostHomeDirBlocked: true,
    remoteBlocked: true,
    workspaceReadOk: true,
    patchReadOk: true,
    writeBlocked: true,
    configWriteBlocked: true,
    ghBlocked: true,
    leakedEnv: [],
  }), /canary readable: cohortFile/);
  assert.throws(() => assertProbePassed({
    canaryReads: { cohortFile: { blocked: true } },
    gitCommits: { futureMain: { absent: false } },
    hostHomeDirBlocked: true,
    remoteBlocked: true,
    workspaceReadOk: true,
    patchReadOk: true,
    writeBlocked: true,
    configWriteBlocked: true,
    ghBlocked: true,
    leakedEnv: [],
  }), /forbidden git commit reachable: futureMain/);
});

test("provider auth staging strips sessions, history, skills, and MCP configs; Docker args isolate mounts", (t) => {
  const tmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "iso-stage-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const fakeSourceCodex = path.join(tmp, "src-codex");
  const targetCodex = path.join(tmp, "dst-codex");
  fs.mkdirSync(path.join(fakeSourceCodex, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(fakeSourceCodex, "skills", "leak"), { recursive: true });
  fs.writeFileSync(path.join(fakeSourceCodex, "auth.json"), '{"token":"synthetic-auth"}');
  fs.writeFileSync(path.join(fakeSourceCodex, "sessions", "holdout.jsonl"), "CANARY_SESSION\n");
  fs.writeFileSync(path.join(fakeSourceCodex, "history.jsonl"), "CANARY_HISTORY\n");
  fs.writeFileSync(path.join(fakeSourceCodex, "state_5.sqlite"), "CANARY_DB");
  fs.writeFileSync(path.join(fakeSourceCodex, "AGENTS.md"), "CANARY_AGENTS");
  fs.writeFileSync(path.join(fakeSourceCodex, "skills", "leak", "SKILL.md"), "CANARY_SKILL");
  fs.writeFileSync(path.join(fakeSourceCodex, "config.toml"), '[mcp_servers.rogue]\ncommand = "echo"\n');

  const codexStage = stageIsolatedCodexHome({ sourceCodexHome: fakeSourceCodex, targetCodexHome: targetCodex });
  assert.deepEqual(codexStage.copied, ["auth.json"]);
  assert.equal(fs.existsSync(path.join(targetCodex, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(targetCodex, "sessions")), false);
  assert.equal(fs.existsSync(path.join(targetCodex, "history.jsonl")), false);
  assert.equal(fs.existsSync(path.join(targetCodex, "state_5.sqlite")), false);
  assert.equal(fs.existsSync(path.join(targetCodex, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(targetCodex, "skills")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(targetCodex, "config.toml"), "utf8"), /mcp_servers|rogue/);

  const fakeSourceHome = path.join(tmp, "src-home");
  const targetHome = path.join(tmp, "dst-home");
  const srcAgy = path.join(fakeSourceHome, ".gemini", "antigravity-cli");
  fs.mkdirSync(path.join(srcAgy, "cache"), { recursive: true });
  fs.mkdirSync(path.join(srcAgy, "brain", "conv-1"), { recursive: true });
  fs.mkdirSync(path.join(srcAgy, "conversations"), { recursive: true });
  fs.mkdirSync(path.join(srcAgy, "mcp"), { recursive: true });
  fs.mkdirSync(path.join(fakeSourceHome, ".agents", "skills"), { recursive: true });
  fs.writeFileSync(path.join(srcAgy, "jetski_state.pbtxt"), "synthetic-state");
  fs.writeFileSync(path.join(srcAgy, "cache", "acp-auth-state.json"), "{}");
  fs.writeFileSync(path.join(srcAgy, "cache", "conversation_metadata.json"), "CANARY_META");
  fs.writeFileSync(path.join(srcAgy, "brain", "conv-1", "notes.md"), "CANARY_BRAIN");
  fs.writeFileSync(path.join(srcAgy, "conversations", "c1.pb"), "CANARY_CONV");
  fs.writeFileSync(path.join(srcAgy, "conversation_summaries.db"), "CANARY_SUMMARIES");
  fs.writeFileSync(path.join(srcAgy, "mcp", "rogue.json"), "CANARY_MCP");
  fs.writeFileSync(path.join(fakeSourceHome, ".agents", "skills", "leak.md"), "CANARY_USER_SKILL");

  const agyStage = stageIsolatedAntigravityHome({
    sourceHome: fakeSourceHome,
    targetHome,
    allowMacKeychain: false,
  });
  assert.deepEqual(agyStage.copied, ["jetski_state.pbtxt", "cache/acp-auth-state.json"]);
  const dstAgy = path.join(targetHome, ".gemini", "antigravity-cli");
  assert.equal(fs.existsSync(path.join(dstAgy, "brain")), false);
  assert.equal(fs.existsSync(path.join(dstAgy, "conversations")), false);
  assert.equal(fs.existsSync(path.join(dstAgy, "conversation_summaries.db")), false);
  assert.equal(fs.existsSync(path.join(dstAgy, "mcp")), false);
  assert.equal(fs.existsSync(path.join(dstAgy, "cache", "conversation_metadata.json")), false);
  assert.equal(fs.existsSync(path.join(targetHome, ".agents")), false);
  assert.equal(
    fs.readFileSync(path.join(targetHome, ".gemini", "config", "mcp_config.json"), "utf8").trim(),
    '{"mcpServers":{}}',
  );

  // Verify Docker container launch args mount ONLY the single cell root and drop capabilities.
  const cellRoot = path.join(tmp, "cell-root");
  fs.mkdirSync(cellRoot, { recursive: true });
  const dockerArgs = buildDockerArgs({
    image: "pwragent-eval:synthetic",
    cellRoot,
    env: { PWRAGENT_PROFILE: "eval", GIT_ALLOW_PROTOCOL: "" },
    command: "node",
    args: ["/eval/bundle/isolated-review-runner.js", "--job", "/eval/job.json"],
  });
  assert.ok(dockerArgs.includes("--cap-drop") && dockerArgs.includes("ALL"));
  assert.ok(dockerArgs.includes("no-new-privileges"));
  assert.ok(dockerArgs.includes("--read-only"));
  const volumeFlags = dockerArgs.filter((v, i) => dockerArgs[i - 1] === "-v");
  assert.deepEqual(volumeFlags, [`${cellRoot}:/eval:rw`]);
  assert.doesNotMatch(dockerArgs.join(" "), new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("isolated controller runs both managed arms on a blind cohort with canary checks, Default Access, and full blind scoring", async (t) => {
  const controllerTmp = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "iso-e2e-ctrl-")));
  const runnerParent = canonicalPath(fs.mkdtempSync(path.join(defaultRunnerParent(), "iso-e2e-run-")));
  t.after(() => {
    fs.rmSync(controllerTmp, { recursive: true, force: true });
    fs.rmSync(runnerParent, { recursive: true, force: true });
  });

  const fixture = createSyntheticRepoWithCanaries(controllerTmp);
  const cohortDir = path.join(controllerTmp, "cohorts");
  const outDir = path.join(controllerTmp, "out");
  const extraCanaryDir = path.join(controllerTmp, "extra-holdout");
  const distDir = path.join(controllerTmp, "dist");
  fs.mkdirSync(cohortDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(extraCanaryDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  const canarySecrets = {
    cohort: "SYNTHETIC_CANARY_COHORT_8192",
    baseline: "SYNTHETIC_CANARY_BASELINE_FINDING_9911",
    judgeIn: "SYNTHETIC_CANARY_JUDGE_INPUT_4422",
    judgeOut: "SYNTHETIC_CANARY_JUDGE_OUTPUT_7733",
    rawLog: "SYNTHETIC_CANARY_RAW_LOG_6644",
    repoFile: "SYNTHETIC_CANARY_REPO_FILE_5511",
    extraDir: "SYNTHETIC_CANARY_EXTRA_DIR_3399",
  };

  const preExistingScoring = path.join(outDir, "prior-scoring");
  const preExistingRawLogs = path.join(outDir, "raw-logs");
  fs.mkdirSync(preExistingScoring, { recursive: true });
  fs.mkdirSync(preExistingRawLogs, { recursive: true });

  const canaryFiles = {
    cohort: path.join(cohortDir, "blind-synthetic.json"),
    judgeIn: path.join(preExistingScoring, "recall-chunk-0.json"),
    judgeOut: path.join(preExistingScoring, "decision-output.json"),
    rawLog: path.join(preExistingRawLogs, "existing-holdout.log"),
    repoFile: path.join(fixture.repo, "holdout-canary.json"),
    extraDir: path.join(extraCanaryDir, "secret.txt"),
  };
  fs.writeFileSync(canaryFiles.judgeIn, canarySecrets.judgeIn);
  fs.writeFileSync(canaryFiles.judgeOut, canarySecrets.judgeOut);
  fs.writeFileSync(canaryFiles.rawLog, canarySecrets.rawLog);
  fs.writeFileSync(canaryFiles.extraDir, canarySecrets.extraDir);

  const syntheticCohort = {
    name: "synthetic-blind-e2e",
    split: "test",
    blind: true,
    cases: [
      {
        id: "pr9001-codex",
        pr: 9001,
        backend: "codex",
        bucket: "codex-findings-high",
        baseline: {
          prNumber: 9001,
          prTitle: "Synthetic blind PR",
          baseBranch: "main",
          branch: "synthetic-pr-9001",
          baseCommit: fixture.baseCommit,
          headCommit: fixture.headCommit,
          reviewedRangeVerified: true,
          reviewMode: "codex-native",
          rangeEvidence: "codex-pr-snapshot",
          diffFiles: 1,
          diffAdds: 1,
          diffDels: 0,
          counts: { total: 1, addressed: 1, deferred: 0, declined: 0 },
          items: [
            {
              id: "base-1",
              title: canarySecrets.baseline,
              body: `Settled detail ${canarySecrets.cohort}`,
              status: "addressed",
              priority: 2,
              file: "example.txt",
              startLine: 2,
              endLine: 2,
            },
          ],
        },
      },
    ],
  };
  fs.writeFileSync(canaryFiles.cohort, JSON.stringify(syntheticCohort, null, 2));

  // Build stubbed isolated-review-runner.js that runs inside the REAL OS
  // isolation boundary and asserts every isolation invariant from the inside.
  const embeddedAuditConfig = JSON.stringify({
    canaryFiles,
    canarySecrets: Object.values(canarySecrets),
    forbiddenCommits: [fixture.preMergeBase, fixture.futureMain, fixture.otherBranch],
    expectedDeniedRoots: [fixture.repo, cohortDir, outDir, extraCanaryDir],
    hostHome: canonicalPath(os.homedir()),
    caseId: "pr9001-codex",
    bucket: "codex-findings-high",
  });

  const registryStub = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { spawnSync } from "node:child_process";

    const CFG = ${embeddedAuditConfig};
    let listener;
    let activeTurn;
    let pending;
    let capturedPolicy;
    let capturedAppRoot;

    function assertInsideRunner(cwd, backend, access) {
      // 1. Inspect job.json directly and ensure zero holdout/cohort/canary leakage.
      const jobIdx = process.argv.indexOf("--job");
      const rawJob = fs.readFileSync(process.argv[jobIdx + 1], "utf8");
      for (const secret of [...CFG.canarySecrets, CFG.caseId, CFG.bucket]) {
        if (rawJob.includes(secret)) throw new Error("Runner job leaked forbidden token: " + secret);
      }

      // 2. Verify env isolation and disabled git/forge tools.
      if (process.env.GIT_CONFIG_NOSYSTEM !== "1") throw new Error("GIT_CONFIG_NOSYSTEM not set");
      if (process.env.GIT_CONFIG_GLOBAL !== os.devNull) throw new Error("GIT_CONFIG_GLOBAL not set");
      if (process.env.GIT_ALLOW_PROTOCOL !== "") throw new Error("GIT_ALLOW_PROTOCOL not empty");
      if (process.env.PWRAGENT_DISABLE_MESSAGING !== "1") throw new Error("messaging not disabled");
      for (const forbidden of ["GH_TOKEN", "GITHUB_TOKEN", "PWRAGENT_HOLDOUT_CANARY", "SSH_AUTH_SOCK"]) {
        if (process.env[forbidden]) throw new Error("Leaked env var: " + forbidden);
      }
      const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
      if (gh.status === 0) throw new Error("gh was executable inside isolated runner");

      // 3. Verify Git history and remote blocking inside the staged workspace.
      for (const sha of CFG.forbiddenCommits) {
        const res = spawnSync("git", ["-C", cwd, "cat-file", "-e", sha + "^{commit}"], { encoding: "utf8" });
        if (res.status === 0) throw new Error("Forbidden commit reachable: " + sha);
      }
      const remoteCheck = spawnSync("git", ["-C", cwd, "ls-remote", "origin"], { encoding: "utf8" });
      if (remoteCheck.status === 0) throw new Error("git ls-remote origin succeeded");

      // 4. Verify runtimePolicy & Default Access settings.
      if (JSON.stringify(capturedPolicy.executionModes) !== JSON.stringify(["default"])) {
        throw new Error("Expected default executionMode only");
      }
      if (capturedPolicy.sandboxByMode.default !== "read-only") {
        throw new Error("Expected read-only sandbox");
      }
      if (capturedPolicy.agentNetwork !== false) {
        throw new Error("Expected agentNetwork=false");
      }
      if (JSON.stringify(capturedPolicy.enabledBackends) !== JSON.stringify([backend])) {
        throw new Error("Expected single enabled backend");
      }
      if (capturedAppRoot.includes(CFG.expectedDeniedRoots[0])) {
        throw new Error("appRoot leaked source repo checkout");
      }

      // 5. Verify OS filesystem isolation:
      //    - For neon (wrapped in Seatbelt/bwrap): direct fs reads of EVERY canary
      //      and host home directory MUST fail inside the runner process itself.
      //    - For codex: verify codexProtectedRoots includes every sensitive root.
      if (backend === "acp:antigravity") {
        if (access?.mode !== "plan" || access?.fullAccess !== false || access?.pinnedPatchFile !== "pwragent-eval-review.patch") {
          throw new Error("Neon Default Access / pinnedPatchFile was not preserved");
        }
        const patchText = fs.readFileSync(path.join(cwd, access.pinnedPatchFile), "utf8");
        if (!patchText.includes("+reviewed-head-line")) {
          throw new Error("Pinned patch missing reviewed head diff");
        }
        for (const [name, target] of Object.entries(CFG.canaryFiles)) {
          let readable = false;
          try { fs.readFileSync(target, "utf8"); readable = true; } catch {}
          if (readable) throw new Error("Seatbelt/bwrap failed to block canary: " + name);
        }
        let homeReadable = false;
        try { fs.readdirSync(CFG.hostHome); homeReadable = true; } catch {}
        if (homeReadable) throw new Error("Seatbelt/bwrap failed to block host home listing");
      } else {
        for (const denied of CFG.expectedDeniedRoots) {
          if (!capturedPolicy.codexProtectedRoots.includes(denied)) {
            throw new Error("Missing codexProtectedRoot: " + denied);
          }
        }
      }
    }

    const send = (backend, method, params) => listener({ backend, notification: { method, params } });
    const registry = {
      listBackends: async () => ({
        backends: capturedPolicy.enabledBackends.map((kind) => ({
          kind,
          available: true,
          launchpadOptions: {
            models: [{ id: kind === "acp:antigravity" ? "gemini-4-neon" : "gpt-6.2-sol" }],
          },
        })),
      }),
      onEvent: (cb) => { listener = cb; return () => {}; },
      startThread: async (opts) => {
        if (opts.executionMode !== "default") throw new Error("startThread must use default executionMode");
        if (opts.mcpProviderServersEnabled !== false || !Array.isArray(opts.mcpConnectionIds) || opts.mcpConnectionIds.length !== 0) {
          throw new Error("startThread must disable MCP provider servers");
        }
        return { threadId: "parent-1" };
      },
      startReview: async ({ backend, threadId, cwd, target }, trusted, _attr, access) => {
        if (trusted !== true) throw new Error("Expected trustedSnapshot=true");
        assertInsideRunner(cwd, backend, access);
        const turnId = "turn-1";
        const reviewThreadId = "child-1";
        activeTurn = { backend, threadId, turnId, reviewThreadId, cwd };
        pending = {
          method: "item/commandExecution/requestApproval",
          params: { threadId: reviewThreadId, turnId, requestId: "approval-1" },
        };
        return { backend, threadId, reviewThreadId, turnId };
      },
      listPendingServerRequests: () => (pending ? [{ backend: activeTurn.backend, notification: pending }] : []),
      submitServerRequest: async ({ response }) => {
        if (response.decision !== "decline") throw new Error("Expected decline for pending approval");
        pending = undefined;
        setTimeout(() => {
          send(activeTurn.backend, "item/completed", {
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            item: {
              id: "managed-review:turn-1:result",
              type: "exitedReviewMode",
              review: "Synthetic isolated review completed.",
              data: {
                reviewOutput: {
                  overall_correctness: "patch is incorrect",
                  overall_confidence_score: 0.9,
                  overall_explanation: "Synthetic finding.",
                  findings: [
                    {
                      title: "Synthetic defect on line 2",
                      body: "Concrete defect observed in reviewed diff.",
                      priority: 2,
                      confidence_score: 0.9,
                      code_location: {
                        absolute_file_path: path.join(activeTurn.cwd, "example.txt"),
                        line_range: { start: 2, end: 2 },
                      },
                    },
                  ],
                },
              },
            },
          });
          send(activeTurn.backend, "turn/completed", {
            threadId: activeTurn.threadId,
            turn: { id: activeTurn.turnId, status: "completed" },
          });
        }, 5);
      },
      interruptTurn: async () => {},
    };

    export const initializeMainLogger = ({ logDirectory, profileName }) => {
      fs.mkdirSync(logDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(logDirectory, "profile-" + profileName + ".main.log"),
        'managed review artifact published turnId="turn-1" candidateLedgerTotal=1 candidateLedgerKeep=1 candidateLedgerDrop=0 candidateLedgerPending=0\\n',
      );
    };
    export const ensureNamedProfileExists = () => {
      const profileDir = path.join(process.env.PWRAGENT_HOME, "profiles", "eval");
      fs.mkdirSync(profileDir, { recursive: true });
      return { profileDir };
    };
    export const resolveActiveProfileDir = () => path.join(process.env.PWRAGENT_HOME, "profiles", "eval");
    export const resolveActiveProfileName = () => "eval";
    export const getDesktopOverlayStore = () => ({ setThreadPullRequests: async () => {} });
    export const isAppStateInitialized = () => false;
    export const disposeAppState = () => {};
    export const issueProviderDiscoveryPermit = () => {};
    export const createOutpostRuntimePolicy = () => ({
      codexProtectedRoots: [path.join(process.env.PWRAGENT_HOME, "profiles")],
      codexReadOnlyRoots: [],
    });
    export const createHeadlessOwnerHostServices = (opts) => ({
      runtimePolicy: opts.runtimePolicy,
      appRoot: opts.runtime.appRoot,
    });
    export const startOwnerServices = async ({ runtimePolicy, appRoot }) => {
      capturedPolicy = runtimePolicy;
      capturedAppRoot = appRoot;
      return { prewarm() {}, registry };
    };
    export const prepareOwnerShutdown = () => {};
    export const disposeOwnerServices = async () => {};
    export const disposeOwnerServicesSync = () => {};
    export const buildPendingRequestResponse = (_notification, decision) => ({ decision });
  `;

  await build({
    entryPoints: [runnerEntrySource],
    outfile: path.join(distDir, "isolated-review-runner.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [{
      name: "isolated-registry-stub",
      setup(builder) {
        builder.onResolve({ filter: /^@pwragent\// }, () => ({ path: "registry", namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: registryStub, loader: "js" }));
      },
    }],
  });

  // 1. Fail-closed CLI validations on controller and runner.
  const runController = (extraArgs, extraEnv = {}) => spawnSync(
    process.execPath,
    [
      controllerScript,
      "--repo", fixture.repo,
      "--cohort", canaryFiles.cohort,
      "--out", outDir,
      "--dist", distDir,
      "--runner-root", runnerParent,
      "--deny-path", extraCanaryDir,
      "--concurrency", "1",
      "--timeout-ms", "15000",
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        GH_TOKEN: "LEAKED_GH_TOKEN_CANARY",
        PWRAGENT_HOLDOUT_CANARY: "LEAKED_ENV_CANARY",
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.notEqual(runController(["--arms", "codex", "--allow-full-access"]).status, 0);
  assert.notEqual(runController(["--arms", "claude-native"]).status, 0);
  assert.notEqual(runController(["--arms", "codex", "--cases", "pr9001-codex"]).status, 0);
  assert.notEqual(
    spawnSync(process.execPath, [
      controllerScript,
      "--repo", fixture.repo,
      "--cohort", canaryFiles.cohort,
      "--out", outDir,
      "--dist", distDir,
      "--runner-root", outDir,
      "--arms", "codex",
    ], { encoding: "utf8" }).status,
    0,
  );

  // Direct runner rejects forbidden flags and unexpected holdout fields in job.json.
  const badJob = path.join(controllerTmp, "bad-job.json");
  fs.writeFileSync(badJob, JSON.stringify({
    schemaVersion: 1,
    cellToken: "cell-bad1",
    arm: "codex",
    timeoutMs: 1000,
    workspacePath: controllerTmp,
    outputPath: path.join(controllerTmp, "out.json"),
    pwragentHome: controllerTmp,
    runtimeRoot: controllerTmp,
    baseline: { items: [] },
    snapshot: {
      prNumber: 9001,
      prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/9001",
      baseBranch: "main",
      headBranch: "head",
      baseCommit: fixture.baseCommit,
      headCommit: fixture.headCommit,
      mergeBaseCommit: fixture.mergeBase,
    },
  }));
  const badJobRun = spawnSync(process.execPath, [
    path.join(distDir, "isolated-review-runner.js"),
    "--job", badJob,
  ], { encoding: "utf8" });
  assert.notEqual(badJobRun.status, 0);
  assert.match(badJobRun.stderr, /Unexpected field "baseline"/);

  // 2. Run BOTH supported managed arms (codex, neon) through the isolated controller.
  const run = runController(["--arms", "codex,neon"]);
  assert.equal(run.status, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);

  // Blind aggregate-only reporting: zero case IDs, PR numbers, titles, findings, or canaries in stdout/stderr.
  const combinedOutput = run.stdout + run.stderr;
  for (const forbidden of [
    "pr9001-codex",
    "9001",
    "Synthetic blind PR",
    "Synthetic defect on line 2",
    ...Object.values(canarySecrets),
  ]) {
    assert.equal(combinedOutput.includes(forbidden), false, `blind output leaked: ${forbidden}`);
  }
  const cellDebug = ["codex", "neon"].map((arm) => {
    const file = path.join(outDir, "results", `pr9001-codex--${arm}.json`);
    return fs.existsSync(file) ? `${arm}: ${fs.readFileSync(file, "utf8")}` : `${arm}: missing`;
  }).join("\n");
  assert.match(run.stdout, /Isolated cell totals:.*"completed":2/, cellDebug);

  // Ephemeral runner staging directories must be cleaned up.
  assert.deepEqual(fs.readdirSync(runnerParent), []);

  // Raw holdout logs stay on the controller side under out/raw-logs/.
  const rawLogs = fs.readdirSync(preExistingRawLogs).filter((name) => name.startsWith("cell-"));
  assert.equal(rawLogs.length, 2);

  // Both arm result files preserve Default Access, pinned SHAs, structured findings, and ledger stats.
  for (const arm of ["codex", "neon"]) {
    const cell = JSON.parse(fs.readFileSync(path.join(outDir, "results", `pr9001-codex--${arm}.json`), "utf8"));
    assert.equal(cell.status, "completed");
    assert.equal(cell.structured, true);
    assert.equal(cell.executionMode, "default");
    assert.equal(cell.baseCommit, fixture.baseCommit);
    assert.equal(cell.headCommit, fixture.headCommit);
    assert.equal(cell.mergeBaseCommit, fixture.mergeBase);
    assert.equal(cell.approvals, 1);
    assert.equal(cell.findingsCount, 1);
    assert.deepEqual(cell.ledger, { total: 1, keep: 1, drop: 0, pending: 0 });
    assert.equal(cell.isolation.mode, resolveIsolationBackend({ requested: "auto", arm }));
  }

  // 3. Resume identity skips already-completed matching cells, and effort change re-runs only the affected arm.
  const resumed = runController(["--arms", "codex,neon"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /"skipped":2.*"completed":0|"completed":0.*"skipped":2/);

  const changedEffort = runController(["--arms", "codex,neon", "--codex-effort", "high"]);
  assert.equal(changedEffort.status, 0, changedEffort.stderr);
  assert.match(changedEffort.stdout, /"completed":1.*"skipped":1|"skipped":1.*"completed":1/);

  // 4. End-to-end blind scoring round-trip using prepare-scoring-batches, decision-file-batches, and aggregate-eval-scores.
  const scoringDir = path.join(outDir, "scoring");
  const prepare = spawnSync(process.execPath, [
    path.join(scriptsDir, "prepare-scoring-batches.mjs"),
    "--repo", fixture.repo,
    "--cohort", canaryFiles.cohort,
    "--results", path.join(outDir, "results"),
    "--out", scoringDir,
    "--arms", "codex,neon",
    "--judge-provider", "openai",
  ], { encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);

  const plan = spawnSync(process.execPath, [
    path.join(scriptsDir, "decision-file-batches.mjs"),
    "--scoring", scoringDir,
  ], { encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  const { pending } = JSON.parse(plan.stdout);
  assert.ok(pending.length >= 3);

  const compactAnswers = {
    recall: [{ name: "same_root_cause", probability: 0.95 }, { name: "match_grade", choice: "exact_match" }],
    precision: [{ name: "matches_baseline", probability: 0.95 }, { name: "concrete_defect", probability: 0.9 }, { name: "defect_value", score: 3 }],
    holistic: ["signal_to_noise", "actionability", "overall_quality"].map((name) => ({ name, score: 3 })),
  };
  for (const { batchType, chunkIndex, count, arguments: args } of pending) {
    fs.mkdirSync(path.dirname(args.outputFile), { recursive: true });
    fs.writeFileSync(args.outputFile, JSON.stringify({
      batchId: `synthetic_${batchType}_${chunkIndex}`,
      state: "completed",
      provider: "openai",
      count,
      succeeded: count,
      failed: 0,
      results: Array.from({ length: count }, (_, index) => ({ index, ok: true, answers: compactAnswers[batchType] })),
    }));
  }

  const record = spawnSync(process.execPath, [
    path.join(scriptsDir, "decision-file-batches.mjs"),
    "--scoring", scoringDir,
    "--record",
  ], { encoding: "utf8" });
  assert.equal(record.status, 0, record.stderr);

  const aggregate = spawnSync(process.execPath, [
    path.join(scriptsDir, "aggregate-eval-scores.mjs"),
    "--cohort", canaryFiles.cohort,
    "--results", path.join(outDir, "results"),
    "--scoring", scoringDir,
    "--out", outDir,
  ], { encoding: "utf8" });
  assert.equal(aggregate.status, 0, aggregate.stderr);
  assert.match(aggregate.stdout, /\[BLIND TEST COHORT\]/);
  assert.doesNotMatch(aggregate.stdout, /pr9001-codex|SYNTHETIC_CANARY/);
  assert.equal(fs.existsSync(path.join(outDir, "eval-matrix-findings-scored.csv")), false);

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "eval-matrix-summary.json"), "utf8"));
  assert.equal(summary.blind, true);
  assert.equal(Object.hasOwn(summary, "cases"), false);
  assert.equal(summary.aggregates.all.codex.addressedRecall.exactPct, 100);
  assert.equal(summary.aggregates.all.neon.addressedRecall.exactPct, 100);
  assert.equal(summary.aggregates.all.unionRecall.unionPct, 100);
});
