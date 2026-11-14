import { EventEmitter } from "node:events";
import { test, expect, vi } from "vitest";
import { transmitPacket } from "./link-transmission.mjs";

test.each([0, 100])("single-packet delivery waits for serialization plus a %i ms stall", async stallMs => {
  let release;
  const packet = Buffer.alloc(16000 + 14);
  const write = vi.fn(() => true);
  let requestedMs;
  const wait = ms => {
    requestedMs = ms;
    return new Promise(resolve => { release = resolve; });
  };
  const delivery = transmitPacket({ write }, packet, { mbps: 2, stallMs }, wait);
  expect(requestedMs).toBeCloseTo(64.056 + stallMs);
  expect(write).not.toHaveBeenCalled();
  release();
  await delivery;
  expect(write).toHaveBeenCalledExactlyOnceWith(packet);
  // The receiver adds 50 ms propagation after this serialization completes.
  expect(requestedMs + 50).toBeCloseTo(114.056 + stallMs);
});

test("socket backpressure still waits for drain after transmission delay", async () => {
  const socket = new EventEmitter();
  socket.write = vi.fn(() => false);
  let completed = false;
  const delivery = transmitPacket(socket, Buffer.alloc(1), { mbps: 2, stallMs: 0 }, async () => {})
    .then(() => { completed = true; });
  await Promise.resolve();
  expect(socket.write).toHaveBeenCalledOnce();
  expect(completed).toBe(false);
  socket.emit("drain");
  await delivery;
  expect(completed).toBe(true);
});
