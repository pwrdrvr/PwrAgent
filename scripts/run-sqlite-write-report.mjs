#!/usr/bin/env node
/**
 * Run the test suite with sqlite write accounting on, then print the ranked
 * report. Any extra arguments are forwarded to vitest, so you can narrow the
 * run the same way `pnpm test` does:
 *
 *   pnpm test:sqlite-writes
 *   pnpm test:sqlite-writes apps/desktop/src/main/__tests__/state-db.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(tmpdir(), "pwragent-sqlite-write-metrics");
const metricsFile = path.join(outDir, `run-${process.pid}.jsonl`);

rmSync(metricsFile, { force: true });
mkdirSync(outDir, { recursive: true });

const vitest = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.workspace.ts", ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PWRAGENT_DEV_SQLITE_WRITE_METRICS: "1",
      PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE: metricsFile,
    },
    stdio: "inherit",
  },
);

// Report regardless of suite outcome — a failing run still tells you where the
// writes went, and that is often why you started the run.
const report = spawnSync(
  "node",
  [path.join(repoRoot, "scripts", "report-sqlite-writes.mjs"), metricsFile],
  { cwd: repoRoot, stdio: "inherit" },
);

process.exit(vitest.status ?? report.status ?? 0);
