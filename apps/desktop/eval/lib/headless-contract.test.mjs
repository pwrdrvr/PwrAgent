import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, assertReady, atomicJson, captureLaunchRejections, dispatchTurn, errorStatus, launchHeadlessElectron, observeFamilyBudget, sanitizedProtocolRecord, probeInterrupt, budgetStop, waitForOutcome, claimRun, cleanEnvironment, configToml, observedBudget, sanitizer, terminalEvent, validateInput } from "./headless-contract.mjs";
const input = { schemaVersion: 1, runId: "run-1", cwd: "/app", prompt: "Fix it", model: "gpt-6-astra", reasoningEffort: "high", serviceTier: "default", tokenMiser: true, timeoutMs: 1000, runtimeManifest: "/eval/runtime.json" };
test("strict contract rejects implicit toggles, model substitutions and unknown inputs", () => {
  assert.equal(validateInput(input).codexHome, "/eval/codex");
  for (const patch of [{ tokenMiser: undefined }, { model: "gpt-6" }, { reasoningEffort: "max" }, { serviceTier: "priority" }, { timeoutMs: Infinity }, { dangerousBypass: true }]) assert.throws(() => validateInput({ ...input, ...patch }));
});
test("durable claim never redispatches a repeated or crashed run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "headless-claim-"));
  try {
    const claim = claimRun(dir, input);
    assert.equal(claim.prior, undefined);
    assert.equal(claimRun(dir, input).prior.status, "incomplete");
    assert.throws(() => claimRun(dir, { ...input, tokenMiser: false }), /different request/);
    atomicJson(claim.file, { inputHash: claim.hash, status: "completed", turnId: "paid-once" });
    assert.equal(claimRun(dir, input).prior.turnId, "paid-once");
    assert.equal(JSON.parse(readFileSync(claim.file)).status, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("environment cannot inherit consumer settings, credentials or mock provider overrides", () => {
  const env = cleanEnvironment(validateInput(input), "/eval/profile/home", "/eval/profile/protocol", { PATH: "/usr/bin", HOME: "/consumer", OPENAI_API_KEY: "SECRET", PWRAGENT_PROFILE: "real", PWRAGENT_REPLAY_FIXTURE_PATH: "/mock", NODE_OPTIONS: "--require /bad", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(env.HOME, "/eval/profile/home");
  assert.equal(env.PWRAGENT_PROFILE, "default");
  assert.equal(env.PWRAGENT_DISABLE_AUTOMATIONS, "1");
  for (const key of ["OPENAI_API_KEY", "NODE_OPTIONS", "PWRAGENT_REPLAY_FIXTURE_PATH", "ELECTRON_RUN_AS_NODE"]) assert.equal(env[key], undefined);
});
test("pair configuration differs only in the two Token Miser gates", () => {
  const on = configToml(input, "/opt/managed/codex").split("\n");
  const off = configToml({ ...input, tokenMiser: false }, "/opt/managed/codex").split("\n");
  assert.deepEqual(on.filter((line, i) => line !== off[i]), ["token_miser_enabled = true", "token_miser_default_enabled = true"]);
  assert.match(on.join("\n"), /managed_builds = true/);
});
function ready() {
  return { backend: { available: true, capabilities: { startTurn: true, interruptTurn: true }, account: { type: "chatgpt" }, launchpadOptions: { models: [{ id: input.model, reasoningEfforts: ["high"] }] }, tokenMiser: { enabled: true, defaultEnabled: true } }, settings: { experimental: { tokenMiserEnabled: { value: true }, tokenMiserDefaultEnabled: { value: true } }, federation: { mode: { value: "disabled" } }, runtime: { tokenMiser: { managedCodex: { state: "ready", version: "1-pwragent" }, activation: { state: "active" } }, messaging: { disabled: true } }, models: { codex: { discovery: { selectedCommand: "/opt/managed/codex" } } } }, runtime: { directory: "/opt/managed", version: "1-pwragent" } };
}
test("readiness fails closed for auth, catalog, managed pin and gate activation", () => {
  const ok = ready();
  assert.doesNotThrow(() => assertReady(ok.backend, ok.settings, input, ok.runtime));
  for (const mutate of [(v) => { v.backend.account = { requiresOpenaiAuth: true }; }, (v) => { v.backend.launchpadOptions.models = []; }, (v) => { v.settings.runtime.tokenMiser.activation.state = "unavailable"; }, (v) => { v.settings.runtime.tokenMiser.managedCodex.version = "wrong"; }, (v) => { v.backend.tokenMiser.enabled = false; }, (v) => { v.settings.runtime.messaging.disabled = false; }]) {
    const v = ready(); mutate(v);
    assert.throws(() => assertReady(v.backend, v.settings, input, v.runtime));
  }
});
test("completion requires this backend, thread and turn, never another helper", () => {
  const event = { backend: "codex", notification: { method: "turn/completed", params: { threadId: "parent", turnId: "turn" } } };
  assert.equal(terminalEvent(event, "parent", "turn"), "completed");
  assert.equal(terminalEvent(event, "helper", "turn"), undefined);
  assert.equal(terminalEvent(event, "parent", "old-turn"), undefined);
  event.notification.method = "turn/failed";
  assert.equal(terminalEvent(event, "parent", "turn"), "failed");
});
test("usage totals parent and helper rows without cumulative double counting", () => {
  const rows = [{ totalTokens: 100, cumulativeTotalTokens: 200, totalCostMicros: 200000, priceStatus: "priced" }, { totalTokens: 20, totalCostMicros: 50000, priceStatus: "priced" }];
  assert.deepEqual(observedBudget(rows), { tokens: 120, costUsd: 0.25, unpriced: false });
  assert.equal(observedBudget([{ totalTokens: 1, priceStatus: "unpriced" }]).unpriced, true);
});
test("artifact redaction handles credentials in arbitrary tool output and account fields", () => {
  const clean = sanitizer(["sensitive-test-token"]);
  assert.deepEqual(clean({ output: "quoted sensitive-test-token here", nested: { access_token: "another", accountKey: "account" }, raw: "sk-abcdefghijklmnopqrstuvwxyz" }), { output: "quoted [REDACTED] here", nested: { access_token: "[REDACTED]", accountKey: "[REDACTED]" }, raw: "[REDACTED]" });
});

test("timeout and cancellation interrupt the wait even if the provider stays idle", async () => {
  for (const reason of ["timeout", "cancelled"]) {
    let stopped;
    let reads = 0;
    const result = await waitForOutcome({ threadId: "p", turnId: "t", drain: async () => [], read: async () => { reads++; return { threadStatus: "idle" }; }, onEvent: () => {}, onUsage: async () => {}, stop: () => stopped, pause: async () => { stopped = reason; } });
    assert.equal(result, reason);
    assert.equal(reads, 1);
  }
});
test("unattended wait propagates failure and rejects interactive requests", async () => {
  for (const [method, expected] of [["turn/failed", "failed"], ["item/tool/requestUserInput", "input_required"]]) {
    const result = await waitForOutcome({ threadId: "p", turnId: "t", drain: async () => [{ backend: "codex", notification: { method, params: { threadId: "p", turnId: "t" } } }], read: async () => ({}), onEvent: () => {}, onUsage: async () => {}, stop: () => {}, pause: async () => { throw new Error("must finish"); } });
    assert.equal(result, expected);
  }
});
test("budget fails closed on unpriced usage and stops at observed thresholds", () => {
  assert.equal(budgetStop({ maxObservedCostUsd: 1 }, { unpriced: true, costUsd: 0, tokens: 10 }), "unpriced_usage");
  assert.equal(budgetStop({ maxObservedCostUsd: 1 }, { unpriced: false, costUsd: 1, tokens: 10 }), "budget_exceeded");
  assert.equal(budgetStop({ maxObservedTokens: 10 }, { unpriced: false, costUsd: 0, tokens: 10 }), "budget_exceeded");
});

test("empty-thread interrupt probe proves method support without starting a turn", async () => {
  const calls = [];
  const evidence = await probeInterrupt(async (method, request) => { calls.push(method); return request; }, "empty");
  assert.equal(evidence.supported, true);
  assert.deepEqual(calls, ["interruptTurn"]);
  assert.equal((await probeInterrupt(async () => { throw new Error("no active turn"); }, "empty")).supported, true);
  for (const message of ["method not found: turn/interrupt", "turn/interrupt deadline exceeded", "unsupported method", "Unexpected interrupt probe response"]) await assert.rejects(probeInterrupt(async () => { throw new Error(message); }, "empty"));
});

test("real capture-store raw envelope preserves usage while removing credentials", () => {
  const record = { sequence: 1, direction: "inbound", raw: JSON.stringify({ method: "thread/tokenUsage/updated", params: { usage: { inputTokens: 42, cachedInputTokens: 20, reasoningOutputTokens: 10 }, access_token: "credential" } }) };
  const clean = sanitizedProtocolRecord(record, sanitizer());
  assert.equal(clean.raw, undefined);
  assert.equal(clean.envelope.params.usage.reasoningOutputTokens, 10);
  assert.equal(clean.envelope.params.access_token, "[REDACTED]");
});

test("local readiness uses settings snapshot when optional federated composer projection is absent", () => {
  const v = ready();
  delete v.backend.tokenMiser;
  assert.doesNotThrow(() => assertReady(v.backend, v.settings, input, v.runtime));
  v.settings.experimental.tokenMiserEnabled.value = false;
  assert.throws(() => assertReady(v.backend, v.settings, input, v.runtime), /settings mismatch/);
});

test("real Playwright launch never disables sandboxing or retries a failed executable", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "headless-launch-"));
  try {
    const executable = path.join(dir, "fake-electron");
    const log = path.join(dir, "args.json");
    // No Electron or provider runs: record the actual Playwright spawn args,
    // then fail as a host with unsupported sandbox prerequisites would.
    writeFileSync(executable, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(1);\n', { mode: 0o700 });
    // Exercise the real early-exit listener failure in its own Node process,
    // including the startup adapter that must make it catchable by the driver.
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { _electron as electron } from ${JSON.stringify(import.meta.resolve("@playwright/test"))};
      import { atomicJson, captureLaunchRejections, errorStatus, launchHeadlessElectron } from ${JSON.stringify(new URL("./headless-contract.mjs", import.meta.url).href)};
      const before = process.listenerCount("unhandledRejection");
      try {
        await captureLaunchRejections(async () => {
          await launchHeadlessElectron({ launch: (options) => {
            if (options.chromiumSandbox !== true) throw new Error("Sandbox option missing");
            return electron.launch({ ...options, executablePath: ${JSON.stringify(executable)}, timeout: 5000 });
          } }, ${JSON.stringify(dir)}, { PATH: process.env.PATH, ARG_LOG: ${JSON.stringify(log)} });
        });
        throw new Error("Expected launch failure");
      } catch (error) {
        atomicJson(${JSON.stringify(path.join(dir, "result.json"))}, { status: errorStatus({}), error: error.message });
      }
      if (process.listenerCount("unhandledRejection") !== before) throw new Error("Leaked launch listener");
    `], { encoding: "utf8", timeout: 15_000 });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
    assert.equal(result.status, "preflight_failed");
    assert.match(result.error, /Process failed to launch/);
    const launches = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(launches.length, 1);
    const [args] = launches;
    assert.ok(args.includes(path.join(dir, "out/main/index.js")));
    assert.ok(!args.includes("--no-sandbox"));
    assert.ok(!args.includes("--disable-setuid-sandbox"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sandbox prerequisite rejection propagates without a fallback launch", async () => {
  let calls = 0;
  const failure = new Error("sandbox unavailable");
  await assert.rejects(launchHeadlessElectron({ launch: async (options) => {
    calls++;
    assert.equal(options.chromiumSandbox, true);
    throw failure;
  } }, "/opt/pwragent/apps/desktop", {}), (error) => error === failure);
  assert.equal(calls, 1);
});

test("startup rejection capture is removed before model work and never ignores orphan failures", async () => {
  const before = process.listenerCount("unhandledRejection");
  let launched = false;
  await captureLaunchRejections(async () => { launched = true; });
  assert.equal(launched, true);
  assert.equal(process.listenerCount("unhandledRejection"), before);
  // Isolate the synthetic orphan from node:test's own unhandled listener.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { captureLaunchRejections } from ${JSON.stringify(new URL("./headless-contract.mjs", import.meta.url).href)};
    const before = process.listenerCount("unhandledRejection");
    await assert.rejects(captureLaunchRejections(async () => {
      void Promise.reject(new Error("orphan startup failure"));
    }), /orphan startup failure/);
    assert.equal(process.listenerCount("unhandledRejection"), before);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
});

test("nested interrupted completion and normalized cancellation cannot report success", async () => {
  for (const [method, status, expected] of [
    ["turn/completed", "interrupted", "cancelled"],
    ["turn/completed", "cancelled", "cancelled"],
    ["turn/completed", "failed", "failed"],
    ["turn/completed", "completed", "completed"],
    ["turn/cancelled", undefined, "cancelled"],
    ["turn/interrupted", undefined, "cancelled"],
  ]) {
    const event = { backend: "codex", notification: { method, params: { threadId: "p", turnId: "t", turn: { id: "t", status } } } };
    const result = await waitForOutcome({ threadId: "p", turnId: "t", drain: async () => [event], read: async () => ({}), onEvent: () => {}, onUsage: async () => {}, stop: () => {}, pause: async () => { throw new Error("terminal event must end wait"); } });
    assert.equal(result, expected);
    assert.equal(EXIT[result], expected === "completed" ? 0 : expected === "cancelled" ? 4 : 1);
    assert.equal(terminalEvent(event, "p", "another-turn"), undefined);
    event.notification.params.turn.id = "another-turn";
    assert.equal(terminalEvent(event, "p", "t"), undefined);
  }
  assert.equal(terminalEvent({ backend: "codex", notification: { method: "turn/completed", params: { threadId: "p", turnId: "t", turn: { status: "inProgress" } } } }, "p", "t"), undefined);
});

test("delegated tokens stop the run, counting each thread and its native helpers once per snapshot", async () => {
  const root = { backend: "codex", threadId: "p" };
  const child = { backend: "codex", threadId: "child", totalCostMicros: 200000, usageLineCount: 2 };
  const grandchild = { backend: "codex", threadId: "grandchild", totalCostMicros: 100000, usageLineCount: 1 };
  const parent = { pricing: { lines: [
    { totalTokens: 100, totalCostMicros: 200000, priceStatus: "priced" },
    { totalTokens: 20, totalCostMicros: 50000, priceStatus: "priced" }, // native helper
  ] } };
  const reads = [];
  const call = async (method, request) => {
    if (method === "readThreadFamilyPricing") return { members: [{ ...root, self: true, totalCostMicros: 250000 }, child, grandchild, child] };
    assert.equal(method, "readThread");
    reads.push(request.threadId);
    return { pricing: { summaries: [{ totalTokens: request.threadId === "child" ? 1000 : 300, totalCostMicros: request.threadId === "child" ? 200000 : 100000, unpricedUsageLineCount: 0 }] } };
  };
  for (let poll = 0; poll < 2; poll++) {
    const result = await observeFamilyBudget(call, root, parent);
    assert.deepEqual(result.observed, { tokens: 1420, costUsd: 0.55, unpriced: false });
    assert.equal(result.familyUsage.length, 3);
    assert.equal(budgetStop({ maxObservedTokens: 1000 }, result.observed), "budget_exceeded");
  }
  assert.deepEqual(reads.sort(), ["child", "child", "grandchild", "grandchild"]);
});

test("family accounting fails closed when delegated pricing cannot be read", async () => {
  const root = { backend: "codex", threadId: "p" };
  for (const missing of [false, true]) {
    await assert.rejects(observeFamilyBudget(async (method) => {
      if (method === "readThreadFamilyPricing") return { members: [{ backend: "codex", threadId: "child", usageLineCount: 1 }] };
      if (missing) return {};
      throw new Error("delegated read disconnected");
    }, root, { pricing: { lines: [] } }), /Missing pricing|disconnected/);
  }
});

test("lost or invalid dispatch acknowledgement stays incomplete on disk and repeated invocation", async () => {
  for (const response of ["timeout", "disconnect", "missing-id"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "headless-dispatch-"));
    try {
      const claim = claimRun(dir, input);
      const result = { status: "preflight_failed", threadId: "p" };
      const persist = () => atomicJson(claim.file, { ...result, inputHash: claim.hash });
      let calls = 0;
      await assert.rejects(dispatchTurn({ result, persist, request: { threadId: "p" }, call: async (method) => {
        assert.equal(method, "startTurn");
        calls++;
        const marker = JSON.parse(readFileSync(claim.file, "utf8"));
        assert.equal(marker.status, "incomplete");
        assert.equal(marker.exitCode, 6);
        assert.ok(marker.dispatchIntentAt);
        // Provider may already be executing before either transport failure.
        if (response === "missing-id") return {};
        throw new Error(response);
      } }));
      result.status = errorStatus(result, "timeout");
      result.exitCode = EXIT[result.status];
      persist();
      const repeated = claimRun(dir, input);
      assert.equal(repeated.prior.status, "incomplete");
      assert.equal(EXIT[repeated.prior.status], 6);
      assert.equal(calls, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("acknowledged dispatch stays uncertain until outcome is known; artifact failures preserve stop classifications", async () => {
  const result = {};
  const snapshots = [];
  await dispatchTurn({ result, persist: () => snapshots.push({ ...result }), request: {}, call: async () => ({ turnId: "t" }) });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].turnId, "t");
  assert.equal(errorStatus(result), "incomplete");
  for (const status of ["cancelled", "timeout", "budget_exceeded", "failed"]) assert.equal(errorStatus({ ...result, status }), status);
  assert.equal(errorStatus({ ...result, status: "completed" }), "failed");
  assert.equal(errorStatus({}), "preflight_failed");
  assert.equal(errorStatus({}, "cancelled"), "cancelled");
});
