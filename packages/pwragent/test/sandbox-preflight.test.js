import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkCodexSandbox } from "../src/sandbox-preflight.js";

function fixture(t, source) {
  const workspace = mkdtempSync("/tmp/pwragent-sandbox-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = path.join(workspace, "codex");
  writeFileSync(command, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { command, workspace, home: workspace };
}

// The host OS is the oracle: a successful sandbox wrapper must be able to
// execute the actual probe argv on every supported platform.
test("a working sandbox wrapper executes the native probe successfully", async (t) => {
  const options = fixture(t, `
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(process.argv.indexOf("--") + 1);
const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
process.stderr.write(result.error?.message || result.stderr || "");
process.exitCode = result.status ?? 1;
`);
  const result = await checkCodexSandbox(options);
  assert.equal(result.status, "ready", result.error);
});

test("a sandbox check that cannot start degrades without rejecting startup", async (t) => {
  const options = fixture(t, "");
  const result = await checkCodexSandbox({ ...options, command: path.join(options.workspace, "missing") });
  assert.equal(result.status, "failed");
  assert.match(result.error, /ENOENT/);
});

test("sandbox diagnostics remain bounded while the child output is drained", async (t) => {
  const options = fixture(t, `process.stderr.write("bwrap: " + "x".repeat(100000)); process.exitCode = 1;`);
  const result = await checkCodexSandbox(options);
  assert.equal(result.status, "failed");
  assert.match(result.error, /bwrap:/);
  assert.ok(result.error.length < 4200);
});

test("a hung sandbox check reaches its deadline and degrades", { timeout: 5000 }, async (t) => {
  const options = fixture(t, "setInterval(() => {}, 1000);");
  const result = await checkCodexSandbox({ ...options, timeout: 100 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /timed out after 100 ms/);
});

test("daemon shutdown cancels a pending sandbox check", { timeout: 5000 }, async (t) => {
  const options = fixture(t, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = checkCodexSandbox({ ...options, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.error, /cancelled/);
});
