import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/pwragent.js", import.meta.url));

// Rule: `serve` probes the sandbox Codex will apply, with the permission
// profile that denies the Outpost's state and the Codex home's credentials
// and private files, and keeps the Codex home read-only,
// against a protected file that exists while the owner lock is held. The fake
// Codex records that request and refuses it, so startup stops at the
// preflight and no owner starts.
test("serve preflights the Outpost profile against its held owner lock", (t) => {
  const base = realpathSync(mkdtempSync("/tmp/pwragent-daemon-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [root, workspace, home] = ["state", "workspace", "codex"].map((name) => path.join(base, name));
  for (const directory of [root, workspace, home]) mkdirSync(directory);
  const record = path.join(base, "codex-argv.json");
  const codex = path.join(base, "fake-codex");
  writeFileSync(codex, `#!/usr/bin/env node
const fs = require("node:fs");
const protectedFile = process.argv.at(-1);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), protectedFileExists: fs.existsSync(protectedFile) }));
process.stderr.write("fake sandbox refused");
process.exit(1);
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [cli, "serve", "--workspace", workspace, "--codex-home", home, "--codex-bin", codex], {
    env: { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "daemon-test" }, encoding: "utf8", timeout: 30000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex sandbox preflight failed \(exit 1\): fake sandbox refused/);
  const { argv, protectedFileExists } = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(argv[0], "sandbox");
  assert.equal(argv.at(-1), path.join(root, "profiles", "daemon-test", "state", "headless", "owner.lock"));
  assert.equal(protectedFileExists, true);
  assert.equal(argv[argv.indexOf("-P") + 1], "pwragent-outpost-workspace-write");
  const filesystem = argv.find((value) => value.startsWith("permissions.pwragent-outpost-workspace-write.filesystem="));
  const denied = ["auth.json", ".credentials.json", "secrets", "config.toml", "sessions", "archived_sessions", "history.jsonl", "log", "*.sqlite*"]
    .map((entry) => path.join(home, entry));
  for (const entry of [path.join(root, "profiles"), ...denied]) {
    assert.ok(filesystem.includes(`${JSON.stringify(entry)}="deny"`), `${entry} in ${filesystem}`);
  }
  assert.ok(filesystem.includes(`${JSON.stringify(home)}="read"`), `read-only Codex home in ${filesystem}`);
});
