import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript-native/bin/tsc", import.meta.url));
const options = process.argv.slice(2);
const desktopOnly = options[0] === "--desktop";
if (desktopOnly) options.shift();

const compilerEnv = { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS ?? "4" };
const projects = [
  {
    config: desktopOnly ? "apps/desktop/tsconfig.production.json" : "tsconfig.typecheck.json",
    checkers: "4",
    env: compilerEnv,
  },
  {
    config: "apps/desktop/tsconfig.tests.json",
    checkers: "2",
    env: { ...compilerEnv, GOMEMLIMIT: compilerEnv.GOMEMLIMIT ?? "4608MiB" },
  },
  {
    config: "apps/desktop/tsconfig.renderer.json",
    checkers: "4",
    env: compilerEnv,
  },
];

// Each compiler process releases its heap before the next desktop slice.
for (const { config, checkers, env } of projects) {
  const result = spawnSync(process.execPath, [
    compiler, "--build", config, "--stopBuildOnErrors", "--checkers", checkers, ...options,
  ], {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
