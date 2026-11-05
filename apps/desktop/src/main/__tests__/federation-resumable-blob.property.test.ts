import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { pushResumableBlob, type ResumableBlobTransport } from "@pwragent/federation/federation-blob-sender";
import { BLOB_CHUNK_BYTES, BLOB_COMMIT_BYTES, BLOB_RETENTION_MS, FederationResumableBlobReceiver } from "@pwragent/federation/federation-resumable-blob";
import { FederationFilePushReceiver, FILE_PUSH_METHODS } from "../federation/federation-file-push";

it("commits each prefix once across generated send/ack/drop/restart interleavings", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ event: fc.integer({ min: 1, max: 50 }), after: fc.boolean() }), { maxLength: 4 }),
    async (drops) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "blob-model-"));
      const data = Buffer.alloc(BLOB_COMMIT_BYTES + BLOB_CHUNK_BYTES + 3, 0x57);
      const source = path.join(root, "source");
      const received = path.join(root, "received");
      const makeReceiver = () => new FederationFilePushReceiver({ allowed: () => true, directory: () => received });
      let receiver = makeReceiver();
      let generation = 0;
      let event = 0;
      let connected = true;
      let durablePrefix = 0;
      let observedPrefix = 0;
      let begins = 0;
      const beginsPerGeneration = new Set<number>();
      const sentOffsets: number[] = [];
      const cancellations: Promise<unknown>[] = [];
      const drop = async (): Promise<never> => {
        connected = false;
        generation++;
        await receiver.dispose();
        receiver = makeReceiver();
        throw new Error("model: connection dropped");
      };
      const step = async <T>(work: () => Promise<T>): Promise<T> => {
        event++;
        if (event > 200) throw new Error("Transfer exceeded the model event budget.");
        const planned = drops.find((item) => item.event === event);
        if (planned && !planned.after) return await drop();
        const result = await work();
        if (planned?.after) return await drop();
        return result;
      };
      const transport: ResumableBlobTransport = {
        localInstanceId: "source", targetInstanceId: "receiver",
        waitForReconnect: async () => { connected = true; },
        cancel: (identity) => { cancellations.push(receiver.handle("source", FILE_PUSH_METHODS.cancel, identity)); },
        connection: () => {
          const current = generation;
          return {
            didDisconnect: () => current !== generation,
            rpc: { request: async <T>(request: { method: string; params: unknown; timeoutMs?: number | null }): Promise<T> => {
              expect(connected).toBe(true);
              expect(request.timeoutMs).toBeNull();
              return await step(async () => {
                const result = await receiver.handle("source", request.method, request.params);
                if (request.method === FILE_PUSH_METHODS.begin) {
                  // No logical begin is resent on a connection that stayed up.
                  expect(beginsPerGeneration.has(current)).toBe(false);
                  beginsPerGeneration.add(current);
                  begins++;
                  const offset = (result as { committedOffset: number }).committedOffset;
                  expect(offset).toBe(durablePrefix);
                }
                // Model a slow but live acknowledgement, without wall clocks.
                await Promise.resolve();
                await Promise.resolve();
                return result as T;
              });
            } },
            send: async (envelope) => await step(async () => {
              const offset = envelope.chunkIndex * BLOB_CHUNK_BYTES;
              expect(offset).toBeGreaterThanOrEqual(durablePrefix);
              sentOffsets.push(offset);
              await receiver.receiveBlob(envelope);
              const checkpoint = await receiver.handle("source", FILE_PUSH_METHODS.checkpoint, { transferId: envelope.transferId }) as { committedOffset: number };
              expect(checkpoint.committedOffset).toBeGreaterThanOrEqual(durablePrefix);
              durablePrefix = checkpoint.committedOffset;
            }),
          };
        },
      };
      try {
        await writeFile(source, data);
        const result = await pushResumableBlob(transport, source, "fixture", {
          onTransferProgress: (progress) => {
            expect(progress.bytesCommitted).toBeGreaterThanOrEqual(observedPrefix);
            observedPrefix = progress.bytesCommitted;
          },
        });
        expect((await readFile(result.path)).equals(data)).toBe(true);
        expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
        expect(durablePrefix).toBe(data.length);
        expect(observedPrefix).toBe(data.length);
        if (generation === 0) {
          expect(begins).toBe(1);
          expect(new Set(sentOffsets).size).toBe(sentOffsets.length);
        }
      } finally {
        await Promise.all(cancellations);
        await receiver.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  ), { numRuns: 15, examples: [[[{ event: 20, after: true }]], [[{ event: 25, after: true }]], [[]]] });
});

it("cancel removes the part file and sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-cancel-"));
  const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
  try {
    const identity = { sha256: "0".repeat(64), sizeBytes: 1 };
    await receiver.handle("source", FILE_PUSH_METHODS.begin, { ...identity, name: "fixture", binary: true });
    await receiver.handle("source", FILE_PUSH_METHODS.cancel, identity);
    expect(await readdir(path.join(root, ".pwragent-resumable"))).toEqual([]);
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("expires abandoned partials after 24 hours using the receiver's clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-expiry-"));
  let now = Date.now();
  const receiver = new FederationResumableBlobReceiver({ directory: () => root, now: () => now });
  try {
    await receiver.begin("source", { sha256: "0".repeat(64), sizeBytes: 1, name: "old" });
    now += BLOB_RETENTION_MS - 1000;
    await receiver.disconnect("source");
    const [old] = await readdir(path.join(root, ".pwragent-resumable"));
    now += 2000;
    await receiver.initialize();
    expect(await readdir(path.join(root, ".pwragent-resumable"))).toContain(old);
    now += BLOB_RETENTION_MS;
    await receiver.initialize();
    await receiver.begin("source", { sha256: "1".repeat(64), sizeBytes: 1, name: "new" });
    expect(await readdir(path.join(root, ".pwragent-resumable"))).not.toContain(old);
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels promptly while the socket has a blocked blob send", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-abort-"));
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  try {
    const source = path.join(root, "source");
    await writeFile(source, "fixture");
    const transfer = pushResumableBlob({ localInstanceId: "source", targetInstanceId: "target",
      connection: () => ({ didDisconnect: () => false,
        rpc: { request: async <T>() => ({ transferId: "blob:fixture", committedOffset: 0 }) as T },
        send: async () => { entered(); await blocked; },
      }), waitForReconnect: async () => undefined, cancel: () => { cancelled = true; },
    }, source, "fixture", { signal: controller.signal });
    const failure = transfer.catch((error: unknown) => error);
    await sending;
    controller.abort(new Error("fixture cancelled"));
    expect((await failure as Error).message).toBe("fixture cancelled");
    expect(cancelled).toBe(true);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

it("one send cannot replace or cancel another send of identical content", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (first, second) => {
    fc.pre(first !== second);
    const root = await mkdtemp(path.join(os.tmpdir(), "blob-ownership-"));
    const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
    const identity = { sha256: "0".repeat(64), sizeBytes: 1 };
    try {
      const active = await receiver.handle("source", FILE_PUSH_METHODS.begin, {
        ...identity, name: "fixture", binary: true, senderToken: first,
      }) as { transferId: string };
      await expect(receiver.handle("source", FILE_PUSH_METHODS.begin, {
        ...identity, name: "fixture", binary: true, senderToken: second,
      })).rejects.toThrow("another send");
      await receiver.handle("source", FILE_PUSH_METHODS.cancel, { ...identity, senderToken: second });
      await expect(receiver.handle("source", FILE_PUSH_METHODS.checkpoint, active)).resolves.toMatchObject({ committedOffset: 0 });
    } finally {
      await receiver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 10 });
});

it("peer-supplied begin fields cannot forge a completed file receipt", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 128 }), async (sizeBytes) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blob-receipt-"));
    const completed: unknown[] = [];
    const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root,
      onCompleted: (_peer, file) => { completed.push(file); } });
    try {
      const victim = path.join(root, "other-owned-fixture");
      await writeFile(victim, Buffer.alloc(sizeBytes));
      const begin = await receiver.handle("source", FILE_PUSH_METHODS.begin, {
        name: "fixture", binary: true, sha256: "0".repeat(64), sizeBytes,
        result: { path: victim, sizeBytes, sha256: "0".repeat(64) },
        committedOffset: sizeBytes, receivedOffset: sizeBytes,
      }) as { transferId: string };
      await expect(receiver.handle("source", FILE_PUSH_METHODS.finish, begin)).rejects.toThrow("Incomplete blob");
      expect(completed).toEqual([]);
    } finally {
      await receiver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 10 });
});
