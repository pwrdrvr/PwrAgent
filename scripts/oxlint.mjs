import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveLocalCpuBudget } from "./local-cpu-budget.mjs";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// The native type-aware backend. From the repository root oxlint reaches it
// through node_modules/.bin: pnpm's sh shim, then a Node wrapper that execs
// this file. A caller outside the repository names it with OXLINT_TSGOLINT_PATH.
export function tsgolintExecutable() {
  const require = createRequire(import.meta.url);
  const wrapper = createRequire(require.resolve("oxlint-tsgolint/package.json"));
  const extension = process.platform === "win32" ? ".exe" : "";
  return wrapper.resolve(`@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${extension}`);
}

export function oxlintBin() {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("oxlint/package.json");
  const { bin } = JSON.parse(readFileSync(packageFile, "utf8"));
  return resolve(dirname(packageFile), bin.oxlint);
}

export function runOxlint(config, paths, options = {}) {
  const localBudget = resolveLocalCpuBudget({ cwd: repositoryRoot });
  const threads = process.env.OXLINT_THREADS
    ?? (options.defaultThreads !== undefined ? String(options.defaultThreads) : undefined)
    ?? (localBudget ? String(localBudget.units) : undefined);
  const result = spawnSync(process.execPath, [
    oxlintBin(), "--config", config, ...(threads ? ["--threads", threads] : []), ...paths,
  ], { cwd: repositoryRoot, env: options.env ?? process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
