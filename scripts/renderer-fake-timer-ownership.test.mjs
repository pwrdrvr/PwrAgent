import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

it("fake-clock advancement owns its React updates through completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-clock-owner-"));
  try {
    const reportPath = path.join(directory, "results.json");
    let output;
    try {
      output = await promisify(execFile)(process.execPath, [
        cli, "run", "--config", "apps/desktop/src/renderer/src/test/fixtures/fake-timer-ownership.config.ts",
        "--reporter=json", "--outputFile", reportPath,
      ], { cwd: process.cwd(), maxBuffer: 64 * 1024 });
    } catch (error) {
      output = error;
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    expect(assertions.map((test) => [test.title, test.status])).toEqual([
      ["settles a busy fake clock without leaving act in the next test", "passed"],
      ["renders independently after the fake-clock test", "passed"],
    ]);
    expect(output.stdout + output.stderr).not.toMatch(/overlapping act|not configured to support act|not wrapped in act/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
