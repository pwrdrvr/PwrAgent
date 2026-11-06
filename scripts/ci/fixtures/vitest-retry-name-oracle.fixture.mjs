import { describe, expect, it } from "vitest";

const firstRun = process.env.PWRAGENT_RETRY_NAME_ORACLE_PHASE === "first";

it("top-level (case)", () => expect(firstRun).toBe(false));
describe("suite [one]", () => {
  it("nested + case", () => expect(firstRun).toBe(false));
  describe("deeper (two)", () => {
    it("nested .* case", () => expect(firstRun).toBe(false));
    it("passing case must not be retried", () => expect(firstRun).toBe(true));
  });
});
