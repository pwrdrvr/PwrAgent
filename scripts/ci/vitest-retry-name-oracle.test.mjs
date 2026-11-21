import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planUnitRetry, unitRetryNamePattern, verifyInitialUnitRun, verifyUnitRetry } from "./retry-failures.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const config = path.join(root, "scripts/ci/fixtures/vitest-retry-name-oracle.config.mjs");
const reporter = path.join(root, "scripts/ci/vitest-ci-reporter.mjs");

function run(directory, name, phase, { pattern, teardown = "clean" } = {}) {
  const reportPath = path.join(directory, `${name}.json`);
  const args = [vitest, "run", "--config", config, "--reporter", reporter];
  if (pattern) args.push("--testNamePattern", pattern);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PWRAGENT_CI_TEST_REPORT: reportPath,
      PWRAGENT_RETRY_NAME_ORACLE_PHASE: phase,
      PWRAGENT_RETRY_NAME_ORACLE_TEARDOWN: teardown,
    },
  });
  return { result, report: JSON.parse(readFileSync(reportPath, "utf8")) };
}

describe("Vitest retry name oracle", () => {
  it("selects exactly each initially failed test at every nesting depth", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-name-oracle-"));
    try {
      const first = run(directory, "first", "first");
      expect(first.result.status).toBe(1);
      const plan = planUnitRetry(first.report, 20);
      expect(plan.tests).toHaveLength(3);
      for (const [index, test] of plan.tests.entries()) {
        const pattern = unitRetryNamePattern([test]);
        const retry = run(directory, `retry-${index}`, "retry", { pattern });
        expect(retry.result.status, retry.result.stderr).toBe(0);
        expect(verifyUnitRetry({ tests: [test] }, retry.report), test.name).toBe(true);
      }
      const batch = run(directory, "retry-batch", "retry", { pattern: unitRetryNamePattern(plan.tests) });
      expect(batch.result.status, batch.result.stderr).toBe(0);
      expect(verifyUnitRetry(plan, batch.report)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // Vitest's real process is the oracle: identical test results and exit
  // status can follow either a clean run or a teardown failure.
  it.each(["throw", "exit"])("rejects retry after a failed test when teardown uses %s", (teardown) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-teardown-oracle-"));
    try {
      const clean = run(directory, "clean", "first");
      const failed = run(directory, "failed", "first", { teardown });
      expect(failed.result.status).toBe(clean.result.status);
      expect(failed.report.complete).toBe(true);
      expect(failed.report.suites).toEqual(clean.report.suites);
      expect(planUnitRetry(clean.report, 20).tests).toHaveLength(3);
      expect(() => planUnitRetry(failed.report, 20)).toThrow(/shut down cleanly/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a forced exit even when the selected test passed and the process exits zero", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-teardown-oracle-"));
    try {
      const first = run(directory, "first", "first");
      const [test] = planUnitRetry(first.report, 20).tests;
      const pattern = unitRetryNamePattern([test]);
      const clean = run(directory, "clean", "retry", { pattern });
      const forced = run(directory, "forced", "retry", { pattern, teardown: "exit" });
      expect(forced.result.status).toBe(0);
      expect(forced.report.suites).toEqual(clean.report.suites);
      expect(verifyInitialUnitRun(clean.report)).toBe(true);
      expect(verifyInitialUnitRun(forced.report)).toBe(false);
      expect(verifyUnitRetry({ tests: [test] }, clean.report)).toBe(true);
      expect(verifyUnitRetry({ tests: [test] }, forced.report)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
