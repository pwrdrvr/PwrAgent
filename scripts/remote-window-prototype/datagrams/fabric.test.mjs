import { expect, test } from "vitest";
import { createFabric } from "./fabric.mts";

test("pushes through a handler-free Noise gateway with multiple unacknowledged batches", async () => {
  const previous = process.env.PWRAGENT_HOME;
  const received = [], release = [];
  const fabric = await createFabric(async params => params, async (role, batch) => {
    received.push({ role, batch });
    await new Promise(resolve => release.push(resolve));
  });
  try {
    const pending = Array.from({ length: 6 }, (_, i) => fabric.push("source", {
      epoch: 7, sequence: i + 1, channel: "feedback", items: [JSON.stringify({ kind: "manifest", revision: i })],
    }));
    await viWait(() => received.length === 6);
    expect(received.every(r => r.role === "viewer")).toBe(true);
    // All six crossed the actual encrypted transport before any receiver ACK.
    expect(fabric.wire.peakPushInFlight).toBe(6);
    expect(await fabric.signal({ transport: "federation" })).toEqual({ transport: "federation" });
    for (const resolve of release.splice(0)) resolve();
    expect(await Promise.all(pending)).toHaveLength(6);
    expect(fabric.wire.bytes).toBeGreaterThan(0);
    await expect(fabric.push("viewer", { epoch: 7, sequence: 1, channel: "media", items: [] })).rejects.toThrow();
  } finally {
    for (const resolve of release) resolve();
    await fabric.close();
    if (previous === undefined) delete process.env.PWRAGENT_HOME; else process.env.PWRAGENT_HOME = previous;
  }
});
async function viWait(check) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("push_delivery_timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
