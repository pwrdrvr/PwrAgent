import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(new URL("../../../../../apps/desktop/package.json", import.meta.url));
const { build } = require("esbuild");
const driver = fileURLToPath(new URL("../review-matrix-driver.ts", import.meta.url));

// Use the registry's public event, start, interrupt, and pending-request shapes.
// No provider commands or PwrAgent profiles are used.
const registryStub = `
  import fs from "node:fs";
  import path from "node:path";
  const scenario = process.env.MATRIX_TEST_SCENARIO;
  const backend = scenario === "neon" ? "acp:antigravity" : scenario === "claude" ? "claude" : "codex";
  const audit = (record) => fs.appendFileSync(process.env.MATRIX_TEST_AUDIT, JSON.stringify(record) + "\\n");
  let listener;
  let parents = 0;
  let live;
  let pending;
  const activeHeads = new Map();
  const reviewers = new Map();
  const firstArms = [];
  const send = (method, params) => listener({ backend: reviewers.get(params.threadId) ?? backend, notification: { method, params } });
  const terminal = (threadId, turnId, method = "turn/completed") => {
    activeHeads.delete(turnId);
    audit({ terminal: turnId });
    return send(method, { threadId, turn: { id: turnId, status: method.split("/")[1] } });
  };
  async function finish(threadId, turnId) {
    await send("item/completed", { threadId, turnId, item: {
      id: "toolu_Review" + threadId,
      type: "exitedReviewMode", data: { reviewOutput: { findings: [] } },
    } });
    await terminal(threadId, turnId);
  }
  const registry = {
    listBackends: async () => ({ backends: (scenario === "matrix" ? ["codex", "acp:antigravity"] : [backend]).map((kind) => ({
      kind, available: true, launchpadOptions: { models: [{ id: kind === "acp:antigravity" ? "gemini-4-neon" : "gpt-6.2-sol" }] },
    })) }),
    onEvent: (callback) => { listener = callback; return () => {}; },
    startTurn: async ({ threadId, input }) => {
      const turnId = "native-" + threadId;
      audit({ command: input[0].text });
      setTimeout(() => void finish(threadId, turnId), 5);
      return { backend, threadId, turnId };
    },
    startThread: async (options) => {
      audit({
        parent: ++parents, mode: options.executionMode, cwd: options.cwd,
        systemConfig: process.env.GIT_CONFIG_NOSYSTEM, globalConfig: process.env.GIT_CONFIG_GLOBAL,
      });
      if (scenario === "setup" && parents === 1) throw Error("setup rejected");
      reviewers.set(String(parents), options.backend);
      return { threadId: String(parents) };
    },
    startReview: async ({ backend, threadId, cwd, target }, _trusted, _attribution, access) => {
      const turnId = "turn-" + threadId;
      const reviewThreadId = "child-" + threadId;
      const { pullRequest, headCommit } = target.snapshot;
      const headKey = pullRequest.number + ":" + headCommit;
      audit({ start: turnId, access, cwd, snapshot: target.snapshot, backend, patch: access?.pinnedPatchFile
        ? fs.readFileSync(path.join(cwd, access.pinnedPatchFile), "utf8") : undefined });
      if ([...activeHeads.values()].includes(headKey)) throw Error("Snapshot already reserved");
      activeHeads.set(turnId, headKey);
      live = { backend, threadId, turnId, reviewThreadId };
      if (scenario === "start-timeout") return new Promise(() => {});
      if (scenario === "approvals") {
        pending = { method: "item/commandExecution/requestApproval", params: { threadId: reviewThreadId, turnId, requestId: "request-" + threadId } };
      } else if (scenario === "matrix" && backend === "codex") {
        firstArms.push([threadId, turnId]);
        if (firstArms.length === 2) {
          setTimeout(() => firstArms.forEach(([thread, turn]) => void finish(thread, turn)), 25);
        }
      } else if (scenario !== "turn-timeout" || threadId !== "1") {
        setTimeout(() => void finish(threadId, turnId), 5);
      }
      return live;
    },
    listPendingServerRequests: () => pending ? [{ backend, notification: pending }] : [],
    submitServerRequest: async ({ threadId, turnId, requestId, response }) => {
      audit({ submitted: requestId, threadId, decision: response.decision });
      pending = undefined;
      setTimeout(() => void finish(live.threadId, turnId), 5);
    },
    interruptTurn: async ({ threadId, turnId }) => {
      audit({ interrupt: turnId, threadId });
      setTimeout(() => void terminal(live.threadId, turnId, "turn/cancelled"), 10);
    },
  };
  export const initializeMainLogger = () => {};
  export const ensureNamedProfileExists = () => ({ profileDir: process.env.PWRAGENT_HOME });
  export const resolveActiveProfileDir = () => process.env.PWRAGENT_HOME;
  export const resolveActiveProfileName = () => "eval";
  export const getDesktopOverlayStore = () => ({ setThreadPullRequests: async () => {} });
  export const isAppStateInitialized = () => false;
  export const disposeAppState = () => {};
  export const issueProviderDiscoveryPermit = () => {};
  export const createHeadlessOwnerHostServices = (options) => ({
    runtimePolicy: options.runtimePolicy ?? {}, appRoot: options.runtime.appRoot,
  });
  export const createOutpostRuntimePolicy = () => ({});
  export const startOwnerServices = async ({ runtimePolicy, appRoot }) => {
    audit({ policy: runtimePolicy, appRoot }); return { prewarm() {}, registry };
  };
  export const prepareOwnerShutdown = () => {};
  export const disposeOwnerServices = async () => { audit({ shutdown: true }); };
  export const disposeOwnerServicesSync = () => {};
  export const buildPendingRequestResponse = (_notification, decision) => ({ decision });
`;

test("matrix ownership, permissions, setup isolation and resume identity", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-matrix-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bundle = path.join(tmp, "matrix.cjs");
  await build({
    entryPoints: [driver], outfile: bundle, bundle: true, platform: "node", format: "cjs",
    plugins: [{ name: "registry-stub", setup(builder) {
      builder.onResolve({ filter: /^@pwragent\// }, () => ({ path: "registry", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: registryStub, loader: "js" }));
    } }],
  });
  const git = (...args) => execFileSync("git", [
    "-C", tmp, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(tmp, "fixture.txt"), "common\n");
  git("add", "fixture.txt");
  git("commit", "-qm", "common");
  const mergeBaseCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(tmp, "fixture.txt"), "base-only\n");
  git("commit", "-qam", "base");
  const baseCommit = git("rev-parse", "HEAD");
  git("switch", "--detach", mergeBaseCommit);
  fs.writeFileSync(path.join(tmp, "fixture.txt"), "reviewed-head\n");
  git("commit", "-qam", "head");
  const headCommit = git("rev-parse", "HEAD");
  const candidate = path.join(tmp, "candidate");
  git("worktree", "add", "--detach", candidate, baseCommit);
  const cohort = path.join(tmp, "cohort.json");
  const cases = [1, 2].map((pr) => ({ id: `private-case-${pr}`, pr, baseline: { baseCommit, headCommit } }));
  const run = (scenario, { blind = false, split, extra = [], out = scenario, arm = "codex" } = {}) => {
    fs.writeFileSync(cohort, JSON.stringify({ blind, split, cases }));
    const audit = path.join(tmp, "audit.jsonl");
    fs.writeFileSync(audit, "");
    const resultDir = path.join(tmp, out);
    const child = spawnSync(process.execPath, [
      bundle, "--repo", candidate, "--cohort", cohort, "--out", resultDir, "--arms", arm,
      ...extra, "--concurrency", "1", "--timeout-ms", "750",
    ], {
      env: { ...process.env, MATRIX_TEST_SCENARIO: scenario, MATRIX_TEST_AUDIT: audit },
      encoding: "utf8", timeout: 5000,
    });
    return {
      ...child,
      logs: fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
      cell: (n, selectedArm = arm) => JSON.parse(fs.readFileSync(path.join(resultDir, "results", `private-case-${n}--${selectedArm}.json`))),
    };
  };

  await t.test("Default Access reviews use independent Git snapshots when the candidate is a linked worktree", () => {
    const result = run("neon", { arm: "neon", out: "linked-worktree" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.logs[0].appRoot, path.join(candidate, "apps/desktop"));
    assert.ok(fs.statSync(path.join(candidate, ".git")).isFile());
    const workspaces = new Set();
    for (const index of [1, 2]) {
      const cell = result.cell(index);
      const parent = result.logs.find((row) => row.parent === index);
      const review = result.logs.find((row) => row.start === `turn-${index}`);
      // Each workspace carries the whole reviewed range under its own .git.
      assert.equal(cell.status, "completed");
      assert.notEqual(parent.cwd, candidate);
      assert.equal(parent.cwd, review.cwd);
      assert.equal(cell.workspacePath, parent.cwd);
      assert.equal(parent.systemConfig, "1");
      assert.equal(parent.globalConfig, os.devNull);
      assert.ok(fs.statSync(path.join(parent.cwd, ".git")).isDirectory());
      assert.equal(git("-C", parent.cwd, "rev-parse", "--git-common-dir"), ".git");
      assert.equal(fs.existsSync(path.join(parent.cwd, ".git/objects/info/alternates")), false);
      assert.equal(git("-C", parent.cwd, "remote", "get-url", "origin"), "https://github.com/pwrdrvr/PwrAgent.git");
      assert.equal(git("-C", parent.cwd, "rev-parse", "HEAD"), headCommit);
      assert.equal(git("-C", parent.cwd, "merge-base", baseCommit, headCommit), mergeBaseCommit);
      assert.equal(git("-C", parent.cwd, "diff", mergeBaseCommit, headCommit), git("diff", mergeBaseCommit, headCommit));
      assert.equal(review.patch?.trim(), git("diff", mergeBaseCommit, headCommit));
      assert.equal(git("-C", parent.cwd, "status", "--porcelain"), "");
      assert.equal(review.snapshot.mergeBaseCommit, mergeBaseCommit);
      assert.equal(fs.readFileSync(path.join(parent.cwd, "fixture.txt"), "utf8"), "reviewed-head\n");
      workspaces.add(parent.cwd);
    }
    assert.equal(workspaces.size, 2);
    assert.equal(fs.readFileSync(path.join(candidate, "fixture.txt"), "utf8"), "base-only\n");
  });

  await t.test("native Claude receives an exact commit range and capture identifies its automatic artifact", () => {
    const result = run("claude", { arm: "claude-native", blind: true, split: "collection" });
    assert.equal(result.status, 0, result.stderr);
    const command = `/code-review high ${mergeBaseCommit}..${headCommit}`;
    assert.equal(result.logs.find((row) => row.command)?.command, command);
    const cell = result.cell(1);
    assert.equal(cell.status, "completed");
    assert.deepEqual(cell.nativeClaude, {
      command, dispatchedAt: cell.nativeClaude.dispatchedAt, sourceKey: "toolu_Review1",
    });
    assert.ok(cell.nativeClaude.dispatchedAt <= Date.parse(cell.completedAt));
    assert.doesNotMatch(result.stdout + result.stderr, /private-case/);
  });

  await t.test("shared-host blind candidates fail closed and development keeps its access policy", () => {
    const blind = run("clean", { blind: true });
    assert.equal(blind.status, 1, blind.stderr);
    assert.match(blind.stderr, /separate reviewer environment/i);
    assert.deepEqual(blind.logs, []);
    assert.doesNotMatch(blind.stdout + blind.stderr, /private-case|turn-1|\[DONE\]/);
    const codex = run("clean-default");
    assert.equal(codex.status, 0, codex.stderr);
    assert.equal(codex.logs.find((row) => row.parent)?.mode, "default");
    assert.equal(codex.logs[0].policy.sandboxByMode.default, "read-only");
    assert.equal(codex.logs[0].policy.executionModes.includes("full-access"), false);
    const neon = run("neon", { arm: "neon" });
    assert.equal(neon.status, 0, neon.stderr);
    assert.equal(neon.logs.find((row) => row.start)?.access.mode, "plan");
    assert.equal(neon.logs.find((row) => row.start)?.access.fullAccess, false);
    const full = run("full", { extra: ["--allow-full-access"] });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.logs.find((row) => row.parent)?.mode, "full-access");
  });
  await t.test("different cases overlap while the same PR head releases each arm before the next", () => {
    const result = run("matrix", { arm: "codex,neon", extra: ["--concurrency", "2", "--timeout-ms", "3500"] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.logs.filter((row) => row.start).length, 4);
    const firstTerminal = result.logs.findIndex((row) => row.terminal);
    assert.equal(result.logs.slice(0, firstTerminal).filter((row) => row.start).length, 2);
    for (const index of [1, 2]) {
      assert.equal(result.cell(index, "codex").status, "completed");
      assert.equal(result.cell(index, "neon").status, "completed");
    }
  });
  await t.test("an explicit unavailable Neon model fails before starting any review", () => {
    const result = run("neon", { arm: "neon", extra: ["--neon-model", "gemini-4-neon-missing"] });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Requested Neon model .* is unavailable/);
    assert.equal(result.logs.some((row) => row.start), false);
  });
  await t.test("a real pending child approval is declined once", () => {
    const result = run("approvals");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.cell(1).status, "completed");
    assert.equal(result.cell(1).approvals, 1);
    const responses = result.logs.filter((row) => row.submitted === "request-1");
    assert.deepEqual(responses.map(({ threadId, decision }) => [threadId, decision]), [["child-1", "decline"]]);
  });
  await t.test("setup failures stay in their cell, and stale cells are run again", () => {
    const failed = run("setup");
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(failed.cell(1).status, "failed");
    assert.equal(failed.cell(2).status, "completed");
    const fresh = run("reused");
    assert.equal(fresh.status, 0, fresh.stderr);
    const same = run("reused");
    assert.equal(same.logs.some((row) => row.start), false);
    const different = run("reused", { extra: ["--codex-effort", "high"] });
    assert.equal(different.status, 0, different.stderr);
    assert.equal(different.logs.filter((row) => row.start).length, 2);
    fs.appendFileSync(bundle, "\n// Changed bundled review prompt\n");
    const rebuilt = run("reused", { extra: ["--codex-effort", "high"] });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(rebuilt.logs.filter((row) => row.start).length, 2);
  });
  await t.test("timeout interrupts and waits for termination before reusing the slot", () => {
    const result = run("turn-timeout");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.cell(1).status, "timeout");
    assert.ok(result.logs.find((row) => row.interrupt === "turn-1"));
    const firstTerminal = result.logs.findIndex((row) => row.terminal === "turn-1");
    const secondStart = result.logs.findIndex((row) => row.start === "turn-2");
    assert.ok(firstTerminal >= 0 && firstTerminal < secondStart);
    const unknown = run("start-timeout");
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.equal(unknown.cell(1).status, "timeout");
    assert.equal(unknown.logs.some((row) => row.start === "turn-2"), false);
    assert.equal(unknown.logs.at(-1).shutdown, true);
  });
});
