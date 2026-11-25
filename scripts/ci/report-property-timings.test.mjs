import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  HEAVY_TEST_BUDGET_MS,
  IN_MEMORY_FILE_BUDGET_MS,
  detectHeavyFixturesLightweight,
  discoverVitestJsonReports,
  formatPropertyTimingsMarkdown,
  normalizeTimingFilePath,
  summarizePropertyTimings,
} from "./report-property-timings.mjs";

describe("report-property-timings", () => {
  it("normalizes macOS runner and Windows paths to repo-relative POSIX paths", () => {
    expect(
      normalizeTimingFilePath(
        "/Users/runner/work/PwrAgent/PwrAgent/apps/desktop/src/main/__tests__/foo.property.test.ts",
      ),
    ).toBe("apps/desktop/src/main/__tests__/foo.property.test.ts");
    expect(
      normalizeTimingFilePath(
        "D:\\a\\PwrAgent\\PwrAgent\\packages\\owner-core\\src\\__tests__\\bar.property.test.ts",
      ),
    ).toBe("packages/owner-core/src/__tests__/bar.property.test.ts");
  });

  it("flags property files strictly over their in-memory or heavy-fixture budget, sorted slowest first", () => {
    const suiteArb = fc.record({
      name: fc.constantFrom(
        "apps/desktop/src/main/__tests__/a.property.test.ts",
        "apps/desktop/src/main/__tests__/b.property.test.ts",
        "apps/desktop/src/main/__tests__/c.test.ts",
        "packages/shared/src/__tests__/d.property.test.ts",
      ),
      isHeavy: fc.boolean(),
      fileMs: fc.integer({ min: 10, max: 1200 }),
      slowestTestMs: fc.integer({ min: 5, max: 900 }),
    });

    fc.assert(
      fc.property(fc.uniqueArray(suiteArb, { selector: (item) => item.name, maxLength: 4 }), (items) => {
        const heavyByFile = new Map(items.map((item) => [item.name, item.isHeavy]));
        const report = {
          testResults: items.map((item) => ({
            name: `/Users/runner/work/PwrAgent/PwrAgent/${item.name}`,
            startTime: 1000,
            endTime: 1000 + item.fileMs,
            assertionResults: [{ fullName: "case", duration: item.slowestTestMs }],
          })),
        };

        const summary = summarizePropertyTimings([report], {
          classifyFile: (relPath) =>
            heavyByFile.get(relPath)
              ? { kind: "heavy", heavyFixtures: ["state-db"] }
              : { kind: "in-memory", heavyFixtures: [] },
        });

        const propertyItems = items.filter((item) => /\.property\.test\.[^.]+$/.test(item.name));
        expect(summary.totalPropertyFiles).toBe(propertyItems.length);

        const expectedFiles = propertyItems
          .filter((item) =>
            item.isHeavy
              ? item.slowestTestMs > HEAVY_TEST_BUDGET_MS
              : item.fileMs > IN_MEMORY_FILE_BUDGET_MS,
          )
          .sort((a, b) => b.fileMs - a.fileMs || a.name.localeCompare(b.name))
          .map((item) => item.name);

        expect(summary.overBudget.map((row) => row.file)).toEqual(expectedFiles);
      }),
    );
  });

  it("classifies heavy fixtures without node_modules dependencies", () => {
    expect(detectHeavyFixturesLightweight('import { openInMemoryStateDb } from "./sqlite-test-utils"; openInMemoryStateDb();')).toEqual(["state-db"]);
    expect(detectHeavyFixturesLightweight('import { render } from "@testing-library/react";')).toEqual(["testing-library"]);
    expect(detectHeavyFixturesLightweight('import { execFileSync } from "node:child_process"; execFileSync("git", ["status"]);')).toEqual(["child_process", "git"]);
    expect(detectHeavyFixturesLightweight('import { execFileSync } from "node:child_process"; vi.mock("node:child_process");')).toEqual([]);
  });

  it("discovers both flat and per-lane downloaded timing files and formats empty runs cleanly", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "property-timings-"));
    try {
      mkdirSync(path.join(dir, "macos-unit-timings-lane-1"), { recursive: true });
      mkdirSync(path.join(dir, "macos-unit-timings-lane-2"), { recursive: true });
      writeFileSync(path.join(dir, "macos-unit-timings-lane-1", "macos-unit-results.json"), "{}");
      writeFileSync(path.join(dir, "macos-unit-timings-lane-2", "macos-unit-results.json"), "{}");
      expect(discoverVitestJsonReports(dir)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const emptyMd = formatPropertyTimingsMarkdown(
      { totalPropertyFiles: 0, totalPropertyMs: 0, overBudget: [] },
      { reportFilesCount: 0 },
    );
    expect(emptyMd).toContain("No `macos-unit-results.json` timing artifacts were found");
  });
});
