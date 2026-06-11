import { describe, expect, it } from "vitest";
import { formatTokenCount, formatUsd } from "../subagent-format";

describe("formatUsd", () => {
  it("keeps three decimals for sub-cent runs", () => {
    expect(formatUsd(0.047)).toBe("$0.047");
    expect(formatUsd(0.032)).toBe("$0.032");
    expect(formatUsd(0.00084)).toBe("$0.001");
  });

  it("trims to two decimals when the thousandths digit is zero", () => {
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(0.04)).toBe("$0.04");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("uses plain cents at ten cents and above", () => {
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(0.13)).toBe("$0.13");
    expect(formatUsd(1.239)).toBe("$1.24");
  });
});

describe("formatTokenCount", () => {
  it("groups thousands", () => {
    expect(formatTokenCount(303488)).toBe("303,488");
    expect(formatTokenCount(0)).toBe("0");
  });
});
