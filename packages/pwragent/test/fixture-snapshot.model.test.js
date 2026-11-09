import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/codex.js", import.meta.url));
const initialize = { id: 1, method: "initialize", params: { capabilities: { experimentalApi: true } } };
const initialized = { method: "initialized" };

// The fixture is the authority for daemon restart tests. Killing its writer at
// any file-write boundary must leave a complete old or new provider snapshot.
for (const phase of ["before-write", "after-truncate", "after-write"]) {
  test(`provider fixture preserves a restartable snapshot when killed ${phase}`, () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-fixture-snapshot-")));
    try {
      const records = path.join(root, "fixture-threads.json");
      writeFileSync(records, JSON.stringify({ existing: { id: "existing", cwd: root, turns: [] } }));
      const preload = path.join(root, "interrupt.cjs");
      writeFileSync(preload, `
const fs = require("node:fs");
const original = fs.writeFileSync;
fs.writeFileSync = (file, value, ...options) => {
  let snapshot;
  try { snapshot = typeof value === "string" && JSON.parse(value); } catch {}
  if (snapshot?.existing?.id === "existing" && Object.keys(snapshot).length > 1) {
    if (process.env.FIXTURE_INTERRUPT === "after-truncate") fs.closeSync(fs.openSync(file, "w"));
    if (process.env.FIXTURE_INTERRUPT === "after-write") original(file, value, ...options);
    process.kill(process.pid, "SIGKILL");
  }
  return original(file, value, ...options);
};
require("node:module").syncBuiltinESMExports();
`);
      const env = { ...process.env, PWRAGENT_TEST_DATA: root, CODEX_HOME: root, FIXTURE_INTERRUPT: phase };
      const killed = spawnSync(process.execPath, ["--require", preload, fixture, "app-server", "--listen", "stdio://"], {
        env, cwd: root, encoding: "utf8", input: [initialize, initialized, { id: 2, method: "thread/start", params: { cwd: root } }].map(JSON.stringify).join("\n") + "\n",
      });
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const snapshot = JSON.parse(readFileSync(records, "utf8"));
      assert.deepEqual(snapshot.existing, { id: "existing", cwd: root, turns: [] });
      assert.ok(Object.keys(snapshot).length <= 2);
      const restarted = spawnSync(process.execPath, [fixture, "app-server", "--listen", "stdio://"], {
        env, cwd: root, encoding: "utf8", input: [initialize, initialized, { id: 2, method: "thread/list", params: { archived: false } }].map(JSON.stringify).join("\n") + "\n",
      });
      assert.equal(restarted.status, 0, restarted.stderr);
      const response = restarted.stdout.trim().split("\n").map(JSON.parse).find(message => message.id === 2);
      assert.ok(response.result.data.some(thread => thread.id === "existing"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
