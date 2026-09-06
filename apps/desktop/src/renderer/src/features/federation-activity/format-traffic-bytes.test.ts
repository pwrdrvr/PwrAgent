import { describe, expect, it } from "vitest";
import { formatTrafficBytes, trafficByteUnit } from "./format-traffic-bytes";

describe("network byte display", () => {
  it.each([
    [0, "0 KB"], [1, "<0.01 KB"], [1_000, "1 KB"],
    [31_826, "31.83 KB"], [4_260_270, "4.26 MB"],
    [50_000_000_000, "50 GB"], [1_000_000_000_000, "1 TB"],
  ])("formats %s bytes as %s", (value, expected) => {
    expect(formatTrafficBytes(value)).toBe(expected);
  });
  it("uses the same decimal scale for chart units", () => {
    expect(trafficByteUnit(400)).toEqual({ scale: 1000, unit: "KB" });
    expect(trafficByteUnit(4_000_000)).toEqual({ scale: 1_000_000, unit: "MB" });
  });
});
