import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReady, atomicJson, probeInterrupt, budgetStop, waitForOutcome, claimRun, cleanEnvironment, configToml, observedBudget, sanitizer, terminalEvent, validateInput } from "./headless-contract.mjs";
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
  return { backend: { available: true, capabilities: { startTurn: true, interruptTurn: true }, account: { type: "chatgpt" }, launchpadOptions: { models: [{ id: input.model, reasoningEfforts: ["high"] }] }, tokenMiser: { enabled: true, defaultEnabled: true } }, settings: { federation: { mode: { value: "disabled" } }, runtime: { tokenMiser: { managedCodex: { state: "ready", version: "1-pwragent" }, activation: { state: "active" } }, messaging: { disabled: true } }, models: { codex: { discovery: { selectedCommand: "/opt/managed/codex" } } } }, runtime: { directory: "/opt/managed", version: "1-pwragent" } };
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
