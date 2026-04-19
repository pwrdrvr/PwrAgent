import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeCodexThreadProtocolCapture } from "../testing/codex-thread-protocol-analysis";

describe("analyzeCodexThreadProtocolCapture", () => {
  it("characterizes thread list payloads and identity fields from a real codex capture", async () => {
    const analysis = await analyzeCodexThreadProtocolCapture({
      capturePath: path.resolve(
        "apps/desktop/e2e/fixtures/codex-todo-list/raw.capture.jsonl",
      ),
    });

    expect(analysis.captureId).toBe("2026-04-19T01-40-27-292Z-codex");
    expect(analysis.requestCounts.initialize).toBeGreaterThan(0);
    expect(analysis.requestCounts["thread/list"]).toBeGreaterThan(0);
    expect(analysis.threadList.requestMethods).toEqual(["thread/list"]);
    expect(analysis.threadList.requestVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/list",
          paramsKeys: ["archived", "limit"],
          archived: false,
          limit: 100,
        }),
        expect.objectContaining({
          method: "thread/list",
          paramsKeys: ["archived", "limit"],
          archived: true,
          limit: 100,
        }),
      ]),
    );
    expect(analysis.threadList.responseContainerKeys).toContain("data");
    expect(analysis.threadList.responseResultKeys).toContain("data");
    expect(analysis.threadList.identityFieldCounts.cwd).toBeGreaterThan(0);
    expect(analysis.threadList.identityFieldCounts.path).toBeGreaterThan(0);
    expect(analysis.threadList.identityFieldCounts.gitBranch).toBeGreaterThan(0);
    expect(analysis.threadList.sampleThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "019da321-9801-70f1-a2ba-103afa135831",
          cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
          gitBranch: "main",
        }),
      ]),
    );
  });
});
