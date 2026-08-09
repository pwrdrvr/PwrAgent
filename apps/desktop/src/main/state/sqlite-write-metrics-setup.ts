import { afterAll, beforeAll, expect } from "vitest";
import {
  flushSqliteWriteMetrics,
  isSqliteWriteMetricsEnabled,
  resetSqliteWriteMetrics,
} from "./sqlite-write-metrics";

/**
 * Vitest setup that attributes sqlite write volume to the test file that
 * caused it. Inert unless `PWRAGENT_DEV_SQLITE_WRITE_METRICS` is set, so a
 * normal `pnpm test` pays nothing beyond this import.
 *
 * Vitest isolates the module graph per test file, so the collector is already
 * per-file; this only has to name it and flush it. Drive it through
 * `pnpm test:sqlite-writes`, which sets the env vars and prints the report.
 *
 * Note what this can and cannot see: it measures tests that open a real
 * `StateDb`. The big main-process suites mock the overlay store, so they read
 * as zero here no matter how they write in production. The E2E run is what
 * covers those paths, through the same collector inside the real app.
 */
if (isSqliteWriteMetricsEnabled()) {
  beforeAll(() => {
    resetSqliteWriteMetrics();
  });

  afterAll(() => {
    flushSqliteWriteMetrics(expect.getState().testPath ?? "unknown");
  });
}
