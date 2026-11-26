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
  const scenario = process.env.MATRIX_TEST_SCENARIO;
  const backend = scenario === "neon" ? "acp:antigravity" : "codex";
  const audit = (record) => fs.appendFileSync(process.env.MATRIX_TEST_AUDIT, JSON.stringify(record) + "\\n");
  let listener;
  let parents = 0;
  let live;
  let pending;
  const send = (method, params) => listener({ backend, notification: { method, params } });
  const terminal = (threadId, turnId, method = "turn/completed") => {
    audit({ terminal: turnId });
    return send(method, { threadId, turn: { id: turnId, status: method.split("/")[1] } });
  };
  async function finish(threadId, turnId) {
    await send("item/completed", { threadId, turnId, item: {
      type: "exitedReviewMode", data: { reviewOutput: { findings: [] } },
    } });
    await terminal(threadId, turnId);
  }
  const registry = {
    listBackends: async () => ({ backends: [{ kind: backend, available: true,
      launchpadOptions: { models: [{ id: scenario === "neon" ? "gemini-4-neon" : "gpt-6.2-sol" }] } }] }),
    onEvent: (callback) => { listener = callback; return () => {}; },
    startThread: async (options) => {
      audit({ parent: ++parents, mode: options.executionMode });
      if (scenario === "setup" && parents === 1) throw Error("setup rejected");
      return { threadId: String(parents) };
    },
    startReview: async ({ threadId }, _trusted, _attribution, access) => {
      const turnId = "turn-" + threadId;
      const reviewThreadId = "child-" + threadId;
      audit({ start: turnId, access });
      live = { backend, threadId, turnId, reviewThreadId };
      if (scenario === "start-timeout") return new Promise(() => {});
      if (scenario === "approvals") {
        pending = { method: "item/commandExecution/requestApproval", params: { threadId: reviewThreadId, turnId, requestId: "request-" + threadId } };
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
  export const createHeadlessOwnerHostServices = (options) => ({ runtimePolicy: options.runtimePolicy ?? {} });
  export const createOutpostRuntimePolicy = () => ({});
  export const startOwnerServices = async ({ runtimePolicy }) => {
    audit({ policy: runtimePolicy }); return { prewarm() {}, registry };
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
  git("commit", "-qm", "base", "--allow-empty");
  const baseCommit = git("rev-parse", "HEAD");
  git("commit", "-qm", "head", "--allow-empty");
  const headCommit = git("rev-parse", "HEAD");
  const cohort = path.join(tmp, "cohort.json");
  const cases = [1, 2].map((pr) => ({ id: `private-case-${pr}`, pr, baseline: { baseCommit, headCommit } }));
  const run = (scenario, { blind = false, extra = [], out = scenario, arm = "codex" } = {}) => {
    fs.writeFileSync(cohort, JSON.stringify({ blind, cases }));
    const audit = path.join(tmp, "audit.jsonl");
    fs.writeFileSync(audit, "");
    const resultDir = path.join(tmp, out);
    const child = spawnSync(process.execPath, [
      bundle, "--repo", tmp, "--cohort", cohort, "--out", resultDir, "--arms", arm,
      "--concurrency", "1", "--timeout-ms", "180", ...extra,
    ], {
      env: { ...process.env, MATRIX_TEST_SCENARIO: scenario, MATRIX_TEST_AUDIT: audit },
      encoding: "utf8", timeout: 2800,
    });
    return {
      ...child,
      logs: fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
      cell: (n) => JSON.parse(fs.readFileSync(path.join(resultDir, "results", `private-case-${n}--${arm}.json`))),
    };
  };

  await t.test("default read-only access, explicit Full Access, and no blind case metadata", () => {
    const blind = run("clean", { blind: true });
    assert.equal(blind.status, 0, blind.stderr);
    assert.equal(blind.logs.find((row) => row.parent)?.mode, "default");
    assert.equal(blind.logs[0].policy.sandboxByMode.default, "read-only");
    assert.equal(blind.logs[0].policy.executionModes.includes("full-access"), false);
    assert.doesNotMatch(blind.stdout + blind.stderr, /private-case|turn-1|\[DONE\]/);
    const neon = run("neon", { arm: "neon" });
    assert.equal(neon.status, 0, neon.stderr);
    assert.deepEqual(neon.logs.find((row) => row.start)?.access, { mode: "plan", fullAccess: false });
    const full = run("full", { extra: ["--allow-full-access"] });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.logs.find((row) => row.parent)?.mode, "full-access");
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
