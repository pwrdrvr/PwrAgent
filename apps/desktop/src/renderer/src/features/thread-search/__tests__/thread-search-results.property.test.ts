import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadSearchRemoteInstance } from "@pwragent/shared/contracts/thread-search";
import {
  describeRemoteInstances,
  orderThreadSearchResults,
} from "../ThreadSearchPanel";

type Timed = { id: number; updatedAt?: number; createdAt?: number };

const timed = fc
  .array(
    fc.record({
      // A small range, so equal times are common.
      updatedAt: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
      createdAt: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
    }),
    { maxLength: 12 },
  )
  .map((rows): Timed[] => rows.map((row, id) => ({ id, ...row })));

const timeOf = (row: Timed): number => row.updatedAt ?? row.createdAt ?? 0;

describe("orderThreadSearchResults", () => {
  it("leaves the search's own ranking alone for Best match", () => {
    fc.assert(fc.property(timed, (rows) => {
      expect(orderThreadSearchResults(rows, "relevance")).toEqual(rows);
    }));
  });

  // Oracle: "Latest" shows every result once, never an older one above a
  // newer one, and two results of the same age in the order the search
  // ranked them. A result with no time counts as the oldest.
  it("orders Latest by last activity and keeps the ranking between equal times", () => {
    fc.assert(fc.property(timed, (rows) => {
      const before = rows.map((row) => row.id);
      const ordered = orderThreadSearchResults(rows, "latest");
      expect(rows.map((row) => row.id)).toEqual(before);
      expect(ordered.map((row) => row.id).toSorted((a, b) => a - b)).toEqual(before);
      for (let index = 1; index < ordered.length; index += 1) {
        const above = ordered[index - 1];
        const below = ordered[index];
        expect(timeOf(above)).toBeGreaterThanOrEqual(timeOf(below));
        if (timeOf(above) === timeOf(below)) expect(above.id).toBeLessThan(below.id);
      }
    }));
  });
});

const instances = fc
  .array(
    fc.record({
      state: fc.constantFrom("done", "searching", "failed", "cancelled"),
      resultCount: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((rows): ThreadSearchRemoteInstance[] => rows.map((row, index) => ({
    instanceId: `i${index}`,
    instanceLabel: `Machine-${index}`,
    resultCount: row.resultCount,
    ...(row.state === "searching" ? { searching: true } : {}),
    ...(row.state === "failed" ? { failed: true } : {}),
    ...(row.state === "cancelled" ? { cancelled: true } : {}),
  })));

describe("describeRemoteInstances", () => {
  // Oracle: the summary names an instance exactly when it has something to
  // report (results, a search still running, a failure, a stop), states how
  // many others had no match, and the tooltip names every instance.
  it("names the instances with something to report and counts the rest", () => {
    fc.assert(fc.property(instances, (rows) => {
      const { summary, detail } = describeRemoteInstances(rows);
      let quiet = 0;
      for (const row of rows) {
        const notable = Boolean(row.failed || row.cancelled || row.searching)
          || row.resultCount > 0;
        if (!notable) quiet += 1;
        // The trailing space or bracket keeps Machine-1 from matching Machine-10.
        expect(summary.includes(`${row.instanceLabel} `)).toBe(notable);
        expect(detail).toContain(`${row.instanceLabel} `);
      }
      const counted = /no matches on (\d+) (?:other )?instances?/.exec(summary);
      expect(Number(counted?.[1] ?? 0)).toBe(quiet);
    }));
  });

  it("reads as a sentence fragment in each shape", () => {
    const done = (label: string, resultCount: number): ThreadSearchRemoteInstance =>
      ({ instanceId: label, instanceLabel: label, resultCount });
    expect(describeRemoteInstances([done("A", 0), done("B", 0), done("C", 0)]).summary)
      .toBe("Remote: no matches on 3 instances");
    expect(describeRemoteInstances([done("A", 2), done("B", 0)]).summary)
      .toBe("Remote: A (2), no matches on 1 other instance");
    expect(describeRemoteInstances([done("A", 2), { ...done("B", 0), searching: true }]))
      .toEqual({ summary: "Remote: A (2), B searching", detail: "Remote: A (2), B searching" });
  });
});
