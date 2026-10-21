import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeHeadlessApp, createOwnedCaptureRoot, exportOwnedProtocol } from "./attempt-lifecycle.mjs";
import { deadlineCall, sanitizer } from "./headless-contract.mjs";

test("failed ownership acquisition never exports an existing profile's private captures", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "capture-owner-"));
  try {
    const capture = path.join(root, "protocol"); mkdirSync(capture);
    const privateFile = path.join(capture, "prior.jsonl");
    writeFileSync(privateFile, "private prior capture");
    let owned;
    assert.throws(() => { owned = createOwnedCaptureRoot(root); }, { code: "EEXIST" });
    const destination = path.join(root, "export.jsonl");
    await exportOwnedProtocol(owned, destination, sanitizer());
    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(privateFile, "utf8"), "private prior capture");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owned capture export sanitizes only current regular files and rejects root replacement", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "capture-export-"));
  try {
    const owned = createOwnedCaptureRoot(root);
    const destination = path.join(root, "export.jsonl");
    const secret = "synthetic-current-auth-token";
    writeFileSync(path.join(owned.directory, "current.jsonl"), JSON.stringify({ raw: JSON.stringify({ result: { output: secret } }) }) + "\n");
    const foreign = path.join(root, "foreign.jsonl"); writeFileSync(foreign, "unrelated private bytes");
    symlinkSync(foreign, path.join(owned.directory, "link.jsonl"));
    await exportOwnedProtocol(owned, destination, sanitizer([secret]));
    const text = readFileSync(destination, "utf8");
    assert.match(text, /REDACTED/);
    assert.doesNotMatch(text, /synthetic|unrelated/);
    renameSync(owned.directory, path.join(root, "old-protocol"));
    mkdirSync(owned.directory);
    await assert.rejects(exportOwnedProtocol(owned, destination, sanitizer()), /ownership changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real CLI early preflight failure cannot copy prior profile captures", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "capture-cli-"));
  try {
    const profile = path.join(root, "profile"); mkdirSync(path.join(profile, "protocol"), { recursive: true });
    const capture = JSON.stringify({ raw: JSON.stringify({ result: { output: "UNRELATED_PRIVATE_CREDENTIAL" } }) });
    writeFileSync(path.join(profile, "protocol/prior.jsonl"), capture);
    const cwd = path.join(root, "task"); mkdirSync(cwd);
    const codexHome = path.join(root, "codex"); mkdirSync(codexHome);
    const input = path.join(root, "input.json");
    writeFileSync(input, JSON.stringify({ schemaVersion: 1, runId: "preflight-owner", cwd, codexHome, profileDir: profile, prompt: "unused", model: "gpt-6-astra", reasoningEffort: "high", serviceTier: "default", tokenMiser: false, timeoutMs: 1000, runtimeManifest: path.join(root, "missing-runtime.json") }));
    const output = path.join(root, "output");
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("../run-headless.mjs", import.meta.url)), "--input", input, "--output", output], { encoding: "utf8", timeout: 10_000, env: { ...process.env, DISPLAY: ":not-launched" } });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(output, "result.json"))).status, "preflight_failed");
    assert.equal(existsSync(path.join(output, "protocol.jsonl")), false);
    assert.equal(readFileSync(path.join(profile, "protocol/prior.jsonl"), "utf8"), capture);
    assert.doesNotMatch(run.stdout + run.stderr, /UNRELATED_PRIVATE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("forced shutdown kills the owned process group, waits for exit and defers artifacts until container stop", { skip: process.platform === "win32" }, async () => {
  const leaf = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const middle = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' }); console.log(JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', process.stdout, 'ignore'] }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", parent], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const unrelated = spawn(process.execPath, ["-e", leaf], { stdio: "ignore" });
  try {
    const [bytes] = await deadlineCall("fixtureReady", once(child.stdout, "data"), 5000);
    const descendants = JSON.parse(bytes.toString());
    const result = await closeHeadlessApp({ process: () => child, close: () => new Promise(() => {}) }, { graceMs: 20, forceMs: 2000 });
    assert.equal(result.cleanup, "forced");
    assert.equal(result.artifactsSafe, false);
    assert.equal(result.containerStopRequired, true);
    assert.equal(result.forceError, undefined);
    assert.equal(child.signalCode, "SIGKILL");
    for (const pid of descendants) {
      // Exited grandchildren can briefly remain zombies pending PID1 reaping.
      let state;
      try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { state = ""; }
      assert.ok(!state || state.startsWith("Z"), `descendant ${pid} still running: ${state}`);
    }
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    unrelated.kill("SIGKILL");
    if (unrelated.exitCode === null && unrelated.signalCode === null) await once(unrelated, "exit");
  }
});

test("normal shutdown permits artifact collection", async () => {
  assert.deepEqual(await closeHeadlessApp({ close: async () => {} }), { cleanup: "graceful", artifactsSafe: true });
});
