#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Always rebuild using the shipped config. Checking stale out/ output could
// silently miss an extracted module or a compressor-induced function merge.
const build = spawnSync(process.execPath, [
  resolve(root, "apps/desktop/node_modules/electron-vite/bin/electron-vite.js"),
  "build", "--ignoreConfigWarning",
], {
  cwd: resolve(root, "apps/desktop"),
  env: { ...process.env, PWRAGENT_BUILD_TARGET: "main" },
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exitCode = build.status || 1;
else {
  const check = spawnSync(process.execPath, [resolve(root, "scripts/check-main-bytecode.mjs"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
  if (check.error) throw check.error;
  process.exitCode = check.status || (check.signal ? 1 : 0);
}
