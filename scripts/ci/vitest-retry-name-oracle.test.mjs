import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planUnitRetry, unitRetryNamePattern, verifyUnitRetry } from "./retry-failures.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const config = path.join(root, "scripts/ci/fixtures/vitest-retry-name-oracle.config.mjs");
const reporter = path.join(root, "scripts/ci/vitest-ci-reporter.mjs");

describe("Vitest retry name oracle", () => {
  it("selects exactly each initially failed test at every nesting depth", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-retry-name-oracle-"));
    try {
      const run = (phase, name, pattern) => {
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
          },
        });
        return { result, report: JSON.parse(readFileSync(reportPath, "utf8")) };
      };

      const first = run("first", "first");
      expect(first.result.status).toBe(1);
      const plan = planUnitRetry(first.report, 20);
      expect(plan.tests).toHaveLength(3);
      for (const [index, test] of plan.tests.entries()) {
        const pattern = unitRetryNamePattern([test]);
        const retry = run("retry", `retry-${index}`, pattern);
        expect(retry.result.status, retry.result.stderr).toBe(0);
        expect(verifyUnitRetry({ tests: [test] }, retry.report), test.name).toBe(true);
      }
      const batch = run("retry", "retry-batch", unitRetryNamePattern(plan.tests));
      expect(batch.result.status, batch.result.stderr).toBe(0);
      expect(verifyUnitRetry(plan, batch.report)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
