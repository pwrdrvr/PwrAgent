import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import VitestReporter from "./vitest-ci-reporter.mjs";
import PlaywrightReporter from "./playwright-ci-reporter.mjs";

const directories = [];
afterEach(() => {
  delete process.env.PWRAGENT_CI_TEST_REPORT;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reportFile() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-ci-reporter-"));
  directories.push(directory);
  process.env.PWRAGENT_CI_TEST_REPORT = path.join(directory, "report.json");
  return process.env.PWRAGENT_CI_TEST_REPORT;
}

describe("CI completion reporters", () => {
  it("requires exactly the Vitest modules selected by the lane's sequencer", async () => {
    for (let mask = 1; mask < 16; mask++) {
      const destination = reportFile();
      const project = { name: "desktop-main" };
      const all = Array.from({ length: 4 }, (_, i) => ({ project, moduleId: `/test-${i}` }));
      const selected = all.filter((_, i) => mask & (1 << i));
      class Sequencer {
        async shard() { return selected; }
      }
      const reporter = new VitestReporter();
      reporter.onInit({ config: { shard: { index: 1, count: 4 }, sequence: { sequencer: Sequencer } } });
      await reporter.onTestRunStart(all);
      const modules = selected.map((specification) => ({
        ...specification,
        errors: () => [],
        children: { allSuites: () => [], allTests: () => [] },
      }));
      for (const module of modules) reporter.onTestModuleEnd(module);
      reporter.onTestRunEnd(modules, [], "passed");
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(true);
      reporter.finished.pop();
      reporter.onTestRunEnd(modules, [], "passed");
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(false);
    }
  });

  it("distinguishes intentional Playwright skips from tests that never ran", () => {
    for (const [outcome, expectedStatus, results, complete] of [
      ["expected", "passed", [{ status: "passed" }], true],
      ["skipped", "skipped", [{ status: "skipped" }], true],
      ["skipped", "passed", [{ status: "skipped" }], false],
      ["skipped", "passed", [], false],
      ["unexpected", "passed", [{ status: "interrupted" }], false],
    ]) {
      const destination = reportFile();
      const reporter = new PlaywrightReporter();
      reporter.onBegin({}, { allTests: () => [{
        id: "test", titlePath: () => ["test"], outcome: () => outcome, expectedStatus, results,
      }] });
      reporter.onEnd({ status: "failed" });
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(complete);
    }
  });
});
