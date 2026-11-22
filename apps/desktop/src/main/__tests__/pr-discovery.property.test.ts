import fc from "fast-check";
import { expect, it } from "vitest";
import { selectRecentPrDiscoveryThreads } from "../pr-status/pr-discovery";

it("admits only genuinely recent access, capped at the 100 most recent threads", () => {
  const week = 7 * 24 * 60 * 60_000;
  const now = week * 2;
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 0, max: week }), { minLength: 101, maxLength: 120 }),
    fc.integer({ min: 0, max: 120 }),
    (ages, accessedCount) => {
      const keys = [...ages.map((age) => `accessed-${age}`), "unopened", "expired"];
      const access = new Map(ages.slice(0, accessedCount).map((age) => [`accessed-${age}`, now - age]));
      access.set("expired", now - week - 1);
      // Age, not inventory order or size, determines who fits in the pool.
      const expected = ages.slice(0, accessedCount).sort((left, right) => left - right)
        .slice(0, 100).map((age) => `accessed-${age}`);
      expect(selectRecentPrDiscoveryThreads(keys, access, now)).toEqual(expected);
    },
  ));
  expect(selectRecentPrDiscoveryThreads(["oldest-recent", "expired"], new Map([
    ["oldest-recent", now - week], ["expired", now - week - 1],
  ]), now)).toEqual(["oldest-recent"]);
});
