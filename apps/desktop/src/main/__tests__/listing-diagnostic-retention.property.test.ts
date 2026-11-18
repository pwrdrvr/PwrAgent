import fc from "fast-check";
import { expect, it } from "vitest";
import { ListingDiagnostics } from "../diagnostics/listing-diagnostics";

it("does no record work while disabled and stores no caller objects while enabled", async () => {
  const ring = new ListingDiagnostics();
  const fields = { get caller(): string { throw new Error("disabled record inspected caller"); } };
  expect(() => ring.record("ipc", "start", fields)).not.toThrow();
  expect(await ring.trace("ipc", fields, async () => 42)).toBe(42);
  expect(ring.snapshot().recorded).toBe(0);
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 20, maxLength: 80 }), (enabled) => {
    let expected = 0;
    ring.setEnabled(false);
    for (const on of enabled) {
      ring.setEnabled(on);
      if (!on) expected = 0;
      const fields = { rows: 3, payload: { private: "DO NOT RETAIN" } };
      ring.record("ipc", "start", fields);
      fields.rows = 999;
      if (on) expected++;
      expect(ring.snapshot().recorded).toBe(expected);
      expect(ring.snapshot().events.every((event) => event.rows === 3)).toBe(true);
      const storage: unknown = Reflect.get(ring, "ring");
      expect(Array.isArray(storage)).toBe(true);
      if (Array.isArray(storage)) expect(storage.every((entry) => entry === undefined || typeof entry === "string")).toBe(true);
      expect(JSON.stringify(ring.snapshot())).not.toContain("DO NOT RETAIN");
    }
  }));
});

it("does not join old asynchronous history to a newly enabled monitor", async () => {
  const ring = new ListingDiagnostics();
  ring.setEnabled(true);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const old = ring.trace("provider", {}, async () => {
    await gate;
    return ring.trace("provider-rpc", {}, async () => 42);
  });
  ring.setEnabled(false);
  ring.setEnabled(true);
  finish();
  expect(await old).toBe(42);
  const events = ring.snapshot().events;
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ stage: "provider-rpc", phase: "start" });
  expect(events[0]?.parentId).toBeUndefined();
});

it.each([false, true])("preserves operation completion ordering with monitoring enabled=%s", async (enabled) => {
  const ring = new ListingDiagnostics();
  ring.setEnabled(enabled);
  const order: string[] = [];
  const read = ring.trace("workflow", {}, async () => { order.push("operation"); return 42; });
  const settled = read.then((value) => { order.push("settled"); return value; });
  queueMicrotask(() => { order.push("tick"); });
  expect(await settled).toBe(42);
  expect(order).toEqual(["operation", "tick", "settled"]);
});
