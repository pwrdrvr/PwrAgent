import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { projectActiveThreadSubAgents } from "../subagent-visibility";
import { deriveTaskMonitorDisplayTitle } from "../task-monitor-display-title";

describe("task monitor titles", () => {
  it("keeps the PR and check while hiding the commit and reporting instructions", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 40, maxLength: 40 }),
      (number, sha) => {
        const task = `Monitor PR #${number} CI after pushing commit ${sha}. Report when it finishes.`;
        const [row] = projectActiveThreadSubAgents([{
          monitorId: "monitor-legacy",
          task,
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        }]);
        expect(row).toHaveProperty("displayTitle", `PR ${number} CI`);
        expect(row?.task).toBe(task);
      },
    ));
  });

  it.each([
    ["Monitor PR #1 CI after pushing commit 0000000000000000000000000000000000000000.", "PR 1 CI"],
    ["Watch gh pr checks 753 --watch and report failures.", "PR 753 CI"],
    ["Monitor CI for https://github.com/acme/example/pull/753.", "PR 753 CI"],
    ["Monitor `pnpm --filter @pwragent/desktop typecheck` until it exits.", "Desktop Typecheck"],
    ["Watch pnpm -C apps/desktop run typecheck.", "Desktop Typecheck"],
    ["Monitor Giphy Swift Verify commit a40f3de.", "Giphy Swift Verify"],
    ["Watch CI on branch staging at commit a40f3deeae808a1129ef59b07c3ffc33913ba4ca.", "CI on branch staging"],
    ["Monitor commit a40f3de.", "Job Monitor"],
  ])("labels %s as %s", (task, title) => {
    expect(deriveTaskMonitorDisplayTitle(task)).toBe(title);
  });

  it("bounds arbitrary labels, preserving whole graphemes", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("z", "o\u0301", "👩‍💻", "界"), { minLength: 49, maxLength: 120 }),
      (graphemes) => {
        const title = deriveTaskMonitorDisplayTitle(`Monitor ${graphemes.join("")}`);
        expect(title.length).toBeLessThanOrEqual(48);
        expect(title.endsWith("…")).toBe(true);
        const prefix = title.slice(0, -1);
        const count = Array.from(new Intl.Segmenter("en").segment(prefix)).length;
        expect(prefix).toBe(graphemes.slice(0, count).join(""));
      },
    ));
  });
});
