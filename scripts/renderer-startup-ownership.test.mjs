import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

it("a timed-out renderer startup releases act before the next test", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-startup-owner-"));
  try {
    const reportPath = path.join(directory, "results.json");
    await expect(promisify(execFile)(process.execPath, [
      cli, "run", "--config", "apps/desktop/src/renderer/src/test/fixtures/startup-ownership.config.ts",
      "--reporter=json", "--outputFile", reportPath,
    ], { cwd: process.cwd(), maxBuffer: 64 * 1024 })).rejects.toMatchObject({ code: 1 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const assertions = report.testResults.flatMap((file) => file.assertionResults);
    expect(assertions.map((test) => [test.title, test.status])).toEqual([
      ["times out while the admitted renderer import is pending", "failed"],
      ["renders independently after the previous test timed out", "passed"],
    ]);
    expect(assertions[0].failureMessages.join("\n")).toContain("Test timed out");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
