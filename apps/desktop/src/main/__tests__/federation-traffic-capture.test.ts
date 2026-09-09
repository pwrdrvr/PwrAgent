import { afterEach, describe, expect, it, vi } from "vitest";
import { federationTrafficCaptureUntil, setFederationTrafficCapture } from "../federation/federation-traffic-capture";

afterEach(() => { setFederationTrafficCapture(false); vi.restoreAllMocks(); });

describe("Federation detailed traffic capture", () => {
  it("expires at 60 seconds without depending on a window or a timer callback", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(federationTrafficCaptureUntil()).toBeUndefined();
    setFederationTrafficCapture(true);
    expect(federationTrafficCaptureUntil()).toBe(61_000);
    expect(federationTrafficCaptureUntil(60_999)).toBe(61_000);
    expect(federationTrafficCaptureUntil(61_000)).toBeUndefined();
    expect(federationTrafficCaptureUntil(120_000)).toBeUndefined();
  });
  it("stops immediately and starts a fresh bounded capture only on request", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    setFederationTrafficCapture(true);
    setFederationTrafficCapture(false);
    expect(federationTrafficCaptureUntil()).toBeUndefined();
    now.mockReturnValue(5_000);
    setFederationTrafficCapture(true);
    expect(federationTrafficCaptureUntil()).toBe(65_000);
  });
});
