import { readFileSync } from "node:fs";
import fc from "fast-check";
import { expect, test } from "vitest";
import { checkReleasePublicationWorkflow } from "./check-release-publication-workflow.mjs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function replace(before, after) {
  expect(workflow).toContain(before);
  return workflow.replace(before, after);
}

test("publication and optional retention leave cleanup headroom before notes/npm", () => {
  expect(checkReleasePublicationWorkflow(workflow)).toEqual({
    jobMinutes: 45,
    criticalPath: 42,
    retentionMinutes: 5,
    overheadMinutes: 3,
  });
});

// Oracle: sequential preparation plus the longest concurrent upload, with
// three minutes reserved for runner setup, action overhead and post-job work.
// Generate caps on both sides of the limit; include the one-minute boundary.
test("every accepted upload budget fits the job even if optional retention times out", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 60 }),
    fc.integer({ min: 1, max: 60 }),
    (publication, retention) => {
      const changed = workflow
        .replace("        timeout-minutes: 20\n", `        timeout-minutes: ${publication}\n`)
        .replace(/(name: Upload assembled release artifacts \(debug retention\)\n        timeout-minutes: )5\n/,
          (_match, prefix) => `${prefix}${retention}\n`);
      const fits = retention <= 5 && 22 + Math.max(publication, retention) + 3 <= 45;
      if (fits) {
        expect(() => checkReleasePublicationWorkflow(changed)).not.toThrow();
      } else {
        expect(() => checkReleasePublicationWorkflow(changed)).toThrow();
      }
    },
  ), { examples: [[20, 5], [21, 5], [20, 6]] });
});

test.each([
  ["    timeout-minutes: 45\n    permissions:\n      contents: write", "    timeout-minutes: 15\n    permissions:\n      contents: write"],
  ["        timeout-minutes: 5\n        uses: actions/upload-artifact", "        uses: actions/upload-artifact"],
  ["        background: true\n", ""],
  ["        wait: publish_assets\n", "        wait: unrelated\n"],
  ["        id: publish_assets\n", "        continue-on-error: true\n        id: publish_assets\n"],
  ["      - parallel:\n", "      - parallel:\n        continue-on-error: true\n"],
  ["        continue-on-error: true\n        with:\n          name: release-publish-artifacts", "        with:\n          name: release-publish-artifacts"],
  ["          name: release-publish-artifacts\n          compression-level: 0", "          name: release-publish-artifacts\n          compression-level: 6"],
  ["          path: windows-dist\n", "          path: mac-dist\n"],
])("rejects broken time-budget/isolation contract %#", (before, after) => {
  expect(() => checkReleasePublicationWorkflow(replace(before, after))).toThrow();
});

test("retention cannot move ahead of staged verification and mutations", () => {
  const start = workflow.indexOf("      - name: Upload assembled release artifacts (debug retention)");
  const end = workflow.indexOf("      - name: Wait for required release publication", start);
  const retention = workflow.slice(start, end);
  const changed = workflow.replace(retention, "").replace(
    "      - name: Verify updater channel files\n",
    `${retention}      - name: Verify updater channel files\n`,
  );
  expect(() => checkReleasePublicationWorkflow(changed)).toThrow();
});
