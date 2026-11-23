import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript-native/bin/tsc", import.meta.url));
const options = process.argv.slice(2);
const desktopOnly = options[0] === "--desktop";
if (desktopOnly) options.shift();

const projects = [
  desktopOnly ? "apps/desktop/tsconfig.production.json" : "tsconfig.typecheck.json",
  "apps/desktop/tsconfig.tests.json",
  "apps/desktop/tsconfig.renderer-tests.json",
];

// Each compiler process releases its heap before the next desktop slice.
for (const project of projects) {
  const result = spawnSync(process.execPath, [
    compiler, "--build", project, "--stopBuildOnErrors", "--checkers", "4", ...options,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS ?? "4" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
