import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Explicit live-protocol oracle, separate from the hermetic unit workspace.
// Each server gets an empty CODEX_HOME. No account or inference is needed.
export default defineConfig({
  test: {
    include: ["apps/desktop/scripts/thread-handoff.oracle.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { PWRAGENT_HOME: path.join(os.tmpdir(), `pwragent-handoff-oracle-home-${process.pid}`) },
  },
});
