import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { invalidateTypecheckCaches } from "./typecheck-cache.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript-native/bin/tsc", import.meta.url));
const options = process.argv.slice(2);
const scope = ["--desktop", "--package"].includes(options[0]) ? options.shift() : undefined;

function enabledOption(...names) {
  const index = options.findLastIndex((option) => names.includes(option.toLowerCase()));
  return index >= 0 && options[index + 1]?.toLowerCase() !== "false";
}

const watch = enabledOption("--watch", "-w");
if (watch && !scope) {
  process.stderr.write("Workspace typecheck does not support watch mode. Use pnpm --filter @pwragent/desktop typecheck --watch for desktop.\n");
  process.exit(1);
}
const desktopWatch = scope === "--desktop" && watch;
if (!desktopWatch && !enabledOption("--clean") && !enabledOption("--dry", "-d")
  && !enabledOption("--help", "-h") && !enabledOption("--version")) {
  invalidateTypecheckCaches(repositoryRoot);
}

const compilerEnv = { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS ?? "4" };
const lowMemory = totalmem() < 32 * 1024 ** 3;
const desktopCheckers = lowMemory ? "2" : "4";
const desktopTestEnv = lowMemory
  ? { ...compilerEnv, GOMEMLIMIT: compilerEnv.GOMEMLIMIT ?? "4608MiB" }
  : compilerEnv;
let projects;
if (scope === "--package") {
  projects = [{ config: "tsconfig.json", checkers: "4", env: compilerEnv }];
} else if (desktopWatch) {
  projects = [{ config: "apps/desktop/tsconfig.json", checkers: desktopCheckers, env: desktopTestEnv }];
} else {
  projects = [
    {
      config: scope === "--desktop" ? "apps/desktop/tsconfig.production.json" : "tsconfig.typecheck.json",
      checkers: "4",
      env: compilerEnv,
    },
    { config: "apps/desktop/tsconfig.tests.json", checkers: desktopCheckers, env: desktopTestEnv },
    { config: "apps/desktop/tsconfig.renderer.json", checkers: "4", env: compilerEnv },
  ];
}

const cwd = scope === "--package" ? process.cwd() : repositoryRoot;

// Each compiler process releases its heap before the next desktop slice.
for (const { config, checkers, env } of projects) {
  const projectArgs = desktopWatch ? ["--project", config] : ["--build", config, "--stopBuildOnErrors"];
  const result = spawnSync(process.execPath, [
    compiler, ...projectArgs, "--checkers", checkers, ...options,
  ], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
