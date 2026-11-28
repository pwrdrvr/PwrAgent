import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  UPDATE_PROGRESS_STATUS_LINES,
  updateProgressCopy,
  type AppUpdateProgressStatus,
} from "../update-progress";

// The live update card grew a row at `available` (Cancel) and another at the
// first byte report (the meter), and each one lifted the bottom-anchored
// card's top. It now draws the shared ProgressStrip, which holds its rows
// only if the copy keeps to them: every phase has a track and the same
// three steps, and the status line is a reserved line or the one-line meter.

const versionArb = fc.constantFrom("1.0.0", "1.6.0-beta.12", "10.20.300");

// Optional fields are left out, not set to undefined, as the updater sends them.
const downloadingArb = fc.record(
  {
    status: fc.constant("downloading" as const),
    direction: fc.constant("downgrade" as const),
    percent: fc.double({ min: -5, max: 110, noNaN: true }),
    transferred: fc.integer({ min: 0, max: 400_000_000 }),
    total: fc.integer({ min: 0, max: 400_000_000 }),
    bytesPerSecond: fc.integer({ min: 0, max: 90_000_000 }),
  },
  { requiredKeys: ["status"] },
);

const checkArb = fc.tuple(versionArb, fc.array(downloadingArb, { minLength: 1, maxLength: 8, size: "max" }))
  .map(([version, downloads]): AppUpdateProgressStatus[] => [
    { status: "checking" },
    { status: "available", version },
    // fast-check types an omitted key as `?: T | undefined`; it is omitted.
    ...downloads.map((download) => ({ ...download, version }) as AppUpdateProgressStatus),
  ]);

describe("update progress copy", () => {
  it("keeps three steps and a reserved status line or the meter from checking to the last byte", () => {
    fc.assert(
      fc.property(checkArb, (statuses) => {
        for (const status of statuses) {
          const copy = updateProgressCopy(status);
          expect(copy.steps.map((step) => step.key), status.status).toEqual([
            "check",
            "download",
            "restart",
          ]);
          if (copy.message === undefined) {
            expect(copy.meter, status.status).toBeDefined();
          } else if (/^\d{1,2}% downloaded$/u.test(copy.message)) {
            // Held by the widest of its kind, "100% downloaded".
            expect(UPDATE_PROGRESS_STATUS_LINES).toContain("100% downloaded");
          } else {
            expect(UPDATE_PROGRESS_STATUS_LINES, status.status).toContain(copy.message);
          }
          if (copy.percent !== undefined) {
            expect(copy.percent).toBeGreaterThanOrEqual(0);
            expect(copy.percent).toBeLessThanOrEqual(100);
          }
        }
      }),
      { numRuns: 80 },
    );
  });
});
