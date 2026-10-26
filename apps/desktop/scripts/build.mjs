#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const cliPath = resolve(desktopRoot, "node_modules/electron-vite/bin/electron-vite.js");

// electron-vite builds these sequentially in one process. Releasing each
// process also releases its Rollup graph and decoded source maps before the
// next target starts, without changing the bundle or its hidden source maps.
export function buildDesktop(args = [], options = {}) {
  const run = options.spawnSync ?? spawnSync;
  for (const target of ["main", "preload", "renderer"]) {
    const result = run(options.node ?? process.execPath, [
      cliPath, "build", ...args, "--ignoreConfigWarning",
    ], {
      cwd: desktopRoot,
      env: { ...(options.env ?? process.env), PWRAGENT_BUILD_TARGET: target },
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`Desktop ${target} build failed: ${result.error.message}`);
    }
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = buildDesktop(process.argv.slice(2));
}
