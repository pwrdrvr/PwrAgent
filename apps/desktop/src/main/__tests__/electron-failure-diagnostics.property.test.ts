import fc from "fast-check";
import type { TestInfo } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { ElectronFailureDiagnostics } from "../../../e2e/fixtures/electron-failure-diagnostics";

describe("Electron failure diagnostics", () => {
  it("attaches each owner's pre-close snapshot only for a failed attempt, regardless of close count", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.nat({ max: 4 }), { maxLength: 5 }),
      fc.constantFrom<TestInfo["status"]>("passed", "failed", "timedOut", "skipped", "interrupted"),
      async (closeCounts, status) => {
        const diagnostics = new ElectronFailureDiagnostics();
        const owners = closeCounts.map((closeCount, index) => {
          let closed = false;
          const snapshot = { listings: { events: [index] }, git: { buckets: [index] } };
          const read = vi.fn(async () => {
            expect(closed).toBe(false);
            return snapshot;
          });
          const capture = diagnostics.register(read);
          return { closeCount, snapshot, read, close: async () => {
            await capture();
            closed = true;
          } };
        });
        for (const owner of owners) {
          for (let i = 0; i < owner.closeCount; i++) await owner.close();
        }
        const attach = vi.fn(async () => {});
        await diagnostics.attach({ status, attach });
        // The attempt outcome, owned by Playwright, decides artifact retention.
        const failed = status === "failed" || status === "timedOut" || status === "interrupted";
        expect(attach.mock.calls).toHaveLength(failed ? owners.length : 0);
        for (const [index, owner] of owners.entries()) {
          expect(owner.read).toHaveBeenCalledTimes(failed || owner.closeCount > 0 ? 1 : 0);
          if (failed) expect(attach).toHaveBeenNthCalledWith(index + 1, `main-process-timing-${index + 1}.json`, {
            body: JSON.stringify(owner.snapshot, null, 2), contentType: "application/json",
          });
        }
      },
    ));
  });

  it("reports an unavailable owner without copying error text or preventing other snapshots", async () => {
    const diagnostics = new ElectronFailureDiagnostics();
    diagnostics.register(async () => { throw new Error("private path and request text"); });
    diagnostics.register(async () => ({ listings: {}, git: {} }));
    const attach = vi.fn(async () => {});
    await diagnostics.attach({ status: "failed", attach });
    expect(attach).toHaveBeenNthCalledWith(1, "main-process-timing-1.json", {
      body: JSON.stringify({ unavailable: "evaluation-failed" }, null, 2), contentType: "application/json",
    });
    expect(attach).toHaveBeenCalledTimes(2);
  });
});
