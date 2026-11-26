#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBudgetThreadEnv, resolveLocalCpuBudget } from "./local-cpu-budget.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vitestEntry = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const args = process.argv.slice(2);
const watchMode = args[0] === "--watch-mode";
const vitestArgs = watchMode
  ? ["--config", "vitest.workspace.mts", ...args.slice(1)]
  : ["run", "--config", "vitest.workspace.mts", ...args];

const localBudget = resolveLocalCpuBudget({ cwd: repositoryRoot });
const env = localBudget
  ? { ...process.env, ...buildBudgetThreadEnv(localBudget.units, process.env) }
  : process.env;

const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], {
  cwd: repositoryRoot,
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
