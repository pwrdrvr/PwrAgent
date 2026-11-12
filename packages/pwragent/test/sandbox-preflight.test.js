import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkCodexSandbox } from "../src/sandbox-preflight.js";

function fixture(t, source) {
  const workspace = mkdtempSync("/tmp/pwragent-sandbox-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const command = path.join(workspace, "codex");
  writeFileSync(command, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  const state = path.join(workspace, "state");
  mkdirSync(state);
  const protectedFile = path.join(state, "owner.lock");
  writeFileSync(protectedFile, "{}\n", { mode: 0o600 });
  return { command, workspace, home: workspace, protectedFile, profile: "outpost-test",
    permissionOverrides: [`permissions.outpost-test.filesystem={":root"="read",${JSON.stringify(state)}="deny"}`] };
}

// Runs the probe argv for real. With `enforceDeny`, it reproduces the
// sandbox's deny by pointing a denied path at one that cannot be read.
const wrapper = (enforceDeny) => `
const { spawnSync } = require("node:child_process");
const denied = process.argv.flatMap(arg => [...arg.matchAll(/("[^"]+")="deny"/g)].map(match => JSON.parse(match[1])));
const args = process.argv.slice(process.argv.indexOf("--") + 1)
  .map(arg => ${enforceDeny} && denied.some(root => arg.startsWith(root + "/")) ? "/nonexistent/denied" : arg);
const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
process.stderr.write(result.error?.message || result.stderr || "");
process.exitCode = result.status ?? 1;
`;

// The host OS is the oracle: a successful sandbox wrapper must be able to
// execute the actual probe argv on every supported platform.
test("a sandbox that denies the Outpost state executes the native probe successfully", async (t) => {
  const result = await checkCodexSandbox(fixture(t, wrapper(true)));
  assert.equal(result.status, "ready", result.error);
});

test("a sandbox that lets commands read the Outpost state fails startup", async (t) => {
  const result = await checkCodexSandbox(fixture(t, wrapper(false)));
  assert.equal(result.status, "failed");
  assert.match(result.error, /can read the Outpost's state directory/);
});

test("the preflight refuses to run without the Outpost permission profile", async (t) => {
  const options = fixture(t, wrapper(true));
  for (const missing of ["permissionOverrides", "profile", "protectedFile"]) {
    const result = await checkCodexSandbox({ ...options, [missing]: undefined });
    assert.equal(result.status, "failed");
    assert.match(result.error, /requires the Outpost permission profile/);
  }
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
