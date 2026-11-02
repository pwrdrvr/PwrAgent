// Diagnostic only: run before the macOS unit suite to compare fresh binaries
// with repeat executions in the same job.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const dugite = require("dugite");
const root = dugite.resolveEmbeddedGitDir();
const commands = [
  ["git", dugite.resolveGitBinary(root)],
  ["lfs", path.join(dugite.resolveGitExecPath(root, ""), "git-lfs")],
];
for (const [label, command] of commands) {
  for (const iteration of ["first", "repeat"]) {
    const start = performance.now();
    try {
      await promisify(execFile)(command, ["--version"], { timeout: 120_000 });
      console.log("[bundled-git-startup-probe]", JSON.stringify({ label, iteration, ms: Math.round(performance.now() - start) }));
    } catch (error) {
      console.warn("[bundled-git-startup-probe]", JSON.stringify({ label, iteration, ms: Math.round(performance.now() - start), error: String(error) }));
    }
  }
}
