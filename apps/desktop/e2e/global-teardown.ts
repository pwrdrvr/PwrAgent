import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Print the sqlite write-volume ranking for the run.
 *
 * The E2E harness is the only place the real write path executes — the
 * main-process suites mock the overlay store — so this is where a per-event
 * write regression like PR #1406's per-chunk tool accounting becomes visible.
 * Output goes to stdout so it lands in the lab's `e2e.log` alongside the
 * Playwright results.
 */
export default function globalTeardown(): void {
  const metricsFile = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE;
  if (!metricsFile || !existsSync(metricsFile)) {
    return;
  }
  const script = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "scripts",
    "report-sqlite-writes.mjs",
  );
  spawnSync("node", [script, metricsFile], { stdio: "inherit" });
  // The file is append-only across a run; a stale one would blend two runs.
  rmSync(metricsFile, { force: true });
}
