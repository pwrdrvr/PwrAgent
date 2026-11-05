import { EventEmitter } from "node:events";
import fc from "fast-check";
import { expect, it } from "vitest";
import { FEDERATION_PROTOCOL_VERSION, type FederationProtocolEnvelope } from "@pwragent/shared";
import { scheduleFederationBlob, waitForFederationSendCapacity } from "../federation/federation-transport";
import { FederationRouter } from "../federation/federation-router";

it("a bulk sender waits when even one chunk is buffered", async () => {
  const raw = new EventEmitter();
  const socket = { bufferedAmount: 256 * 1024, readyState: 1 as const, _socket: raw };
  let sent = false;
  const waiting = waitForFederationSendCapacity(socket, 0).then(() => { sent = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toBe(false);
  socket.bufferedAmount = 0;
  raw.emit("drain");
  await waiting;
});

// A discrete-event link owns bufferedAmount. Transfer size is 400 x 256 KiB
// (100 MiB); transmit time is bytes / link rate, so the byte bound is also
// independent of link speed. Control frames bypass the shared bulk scheduler.
it("control queueing stays within one chunk throughout a 100 MiB transfer", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 400 }), async (controlAfterChunk) => {
    const raw = new EventEmitter();
    const socket = { bufferedAmount: 0, readyState: 1 as const, _socket: raw };
    let chunks = 0;
    let controlDelayBytes = Infinity;
    const writes = Array.from({ length: 400 }, () => scheduleFederationBlob(socket, async () => {
      await waitForFederationSendCapacity(socket, 0);
      socket.bufferedAmount += 256 * 1024;
      chunks++;
      if (chunks === controlAfterChunk) queueMicrotask(() => { controlDelayBytes = socket.bufferedAmount; });
      setImmediate(() => { socket.bufferedAmount = 0; raw.emit("drain"); });
    }));
    await Promise.all(writes);
    expect(controlDelayBytes).toBeLessThanOrEqual(256 * 1024);
  }), { numRuns: 10 });
});

it("a relay orders a blob barrier after data while control RPCs bypass it", async () => {
  const sent: FederationProtocolEnvelope[] = [];
  let release!: () => void;
  const drain = new Promise<void>((resolve) => { release = resolve; });
  const router = new FederationRouter({ localInstanceId: "gateway" });
  router.registerConnection({ peerId: "source", capabilities: ["gateway_relay", "resumable_blobs", "file_push"], sendEnvelope: () => undefined });
  router.registerConnection({ peerId: "target", capabilities: ["resumable_blobs"],
    sendEnvelope: (envelope) => { sent.push(envelope); },
    sendEnvelopeWithBackpressure: async (envelope) => { await drain; sent.push(envelope); },
  });
  const base = { id: "fixture", protocolVersion: FEDERATION_PROTOCOL_VERSION, sourceInstanceId: "source", targetInstanceId: "target", createdAt: 1 };
  const chunk = router.routeEnvelope({ sourcePeerId: "source", envelope: { ...base, kind: "blob_chunk", purpose: "file_push",
    transferId: "blob:fixture", chunkIndex: 0, chunkCount: 1, totalSize: 1, sha256: "0".repeat(64), name: "fixture", inputType: "localFile", data: Buffer.alloc(1) } });
  const checkpoint = router.routeEnvelope({ sourcePeerId: "source", envelope: { ...base, kind: "request", method: "file.push.checkpoint", params: { transferId: "blob:fixture" } } });
  await router.routeEnvelope({ sourcePeerId: "source", envelope: { ...base, kind: "request", method: "control", params: {} } });
  expect(sent.map((envelope) => envelope.kind === "request" ? envelope.method : envelope.kind)).toEqual(["control"]);
  release();
  await Promise.all([chunk, checkpoint]);
  expect(sent.map((envelope) => envelope.kind === "request" ? envelope.method : envelope.kind)).toEqual(["control", "blob_chunk", "file.push.checkpoint"]);
});
