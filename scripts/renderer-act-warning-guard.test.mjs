import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const config = "apps/desktop/src/renderer/src/test/fixtures/act-warning-guard.config.ts";

function runFixture(reportPath, filter) {
  return promisify(execFile)(process.execPath, [
    cli, "run", "--config", config,
    "--reporter=default", "--reporter=json", "--outputFile", reportPath,
    ...(filter ? ["--testNamePattern", filter] : []),
  ], { cwd: process.cwd(), maxBuffer: 256 * 1024 });
}

it("the renderer runner fails act warnings and keeps their async owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-act-guard-"));
  try {
    const reportPath = path.join(directory, "results.json");
    let output;
    try {
      output = await runFixture(reportPath);
      throw new Error("The intentionally unwrapped fixture passed");
    } catch (error) {
      expect(error.code).toBe(1);
      output = error;
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    const failed = assertions.filter((test) => test.status === "failed");
    expect(failed.map((test) => test.title)).toEqual([
      "fails a real unwrapped React update while preserving console output",
      "fails an asynchronous React update behind a silenced console spy",
      "fails after restoreAllMocks",
      "fails a warning from onTestFinished",
      "fails a warning from afterEach",
      "attributes a late callback to its originating test",
      "fails the originating final test when its callback settles in afterAll",
    ]);
    for (const test of failed) {
      expect(test.failureMessages.join("\n")).toContain("React act warning");
      expect(test.failureMessages.join("\n")).toContain(test.title);
    }
    expect(assertions.filter((test) => test.status === "passed")).toHaveLength(4);
    expect(report.testResults[0].message).toContain("suspended resource");
    expect(output.stdout + output.stderr).toContain("not wrapped in act");
    expect(output.stdout + output.stderr).toContain("Counter");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("an isolated real warning exits nonzero and a clean act-wrapped run exits zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-act-guard-exit-"));
  try {
    const reportPath = path.join(directory, "results.json");
    await expect(runFixture(reportPath, "^fails a real unwrapped React update"))
      .rejects.toMatchObject({ code: 1 });
    const failedReport = JSON.parse(await readFile(reportPath, "utf8"));
    expect(failedReport.numFailedTests).toBe(1);

    await runFixture(reportPath, "^passes clean act-wrapped|^preserves other console");
    const cleanReport = JSON.parse(await readFile(reportPath, "utf8"));
    expect(cleanReport.success).toBe(true);
    expect(cleanReport.numPassedTests).toBe(2);
    expect(cleanReport.numFailedTests).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
