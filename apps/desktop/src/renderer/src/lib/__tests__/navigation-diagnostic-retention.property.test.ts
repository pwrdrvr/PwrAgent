import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { NavigationListingDiagnostics } from "../navigation-listing-diagnostics";

it("never retains extra caller payloads in a diagnostic slot", () => {
  const ring = new NavigationListingDiagnostics();
  // Also runs against the original always-on implementation, without a new API.
  const enable: unknown = Reflect.get(ring, "setEnabled");
  if (typeof enable === "function") Reflect.apply(enable, ring, [true]);
  const payload = { private: "PRIVATE ORIGINAL" };
  ring.record({ view: 1, effect: 1, phase: "demand", ...{ payload } });
  payload.private = "PRIVATE MUTATED";
  expect(JSON.stringify(ring.snapshot())).not.toContain("PRIVATE");
  const storage: unknown = Reflect.get(ring, "events");
  if (!Array.isArray(storage)) throw new Error("Expected fixed diagnostic slots");
  expect(storage.filter((entry) => entry !== undefined).every((entry) => typeof entry === "string")).toBe(true);
});

it("retains only serialized scalar records during enabled monitor intervals", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 20, maxLength: 80 }), (enabled) => {
    const ring = new NavigationListingDiagnostics();
    let expected = 0;
    let previous = false;
    for (const on of enabled) {
      ring.setEnabled(on);
      if (!on) expected = 0;
      if (on && !previous) expect(ring.snapshot().recorded).toBe(0);
      const event = { view: 1, effect: 1, phase: "demand" as const, count: 3,
        payload: { private: "DO NOT RETAIN" }, caller: "PRIVATE CALLER" };
      ring.record(event);
      event.count = 999;
      if (on) expected++;
      const snapshot = ring.snapshot();
      expect(snapshot.recorded).toBe(expected);
      expect(snapshot.events.every((entry) => entry.count === 3)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
      expect(JSON.stringify(snapshot)).not.toContain("DO NOT RETAIN");
      const storage: unknown = Reflect.get(ring, "events");
      expect(Array.isArray(storage)).toBe(true);
      if (Array.isArray(storage)) expect(storage.every((entry) => entry === undefined || typeof entry === "string")).toBe(true);
      previous = on;
    }
  }));
});

it("coalesces high-rate scrolling without timers, content or unbounded history", () => {
  const ring = new NavigationListingDiagnostics();
  let at = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => at);
  try {
    ring.setEnabled(true);
    for (let i = 0; i < 1000; i++) ring.recordInteraction("scroll");
    expect(ring.snapshot().events).toEqual([{ at, view: 0, effect: 0, phase: "interaction", interaction: "scroll", count: 1000, lastAt: at }]);
    at += 99;
    ring.recordInteraction("scroll");
    expect(ring.snapshot().events[0]).toMatchObject({ count: 1001, at: 1000, lastAt: 1099 });
    at++;
    ring.recordInteraction("scroll");
    expect(ring.snapshot().events).toHaveLength(2);
    ring.setEnabled(false);
    ring.recordInteraction("scroll");
    expect(ring.snapshot().events).toEqual([]);
  } finally { clock.mockRestore(); }
});
