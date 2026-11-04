import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { pushResumableBlob, type ResumableBlobTransport } from "@pwragent/federation/federation-blob-sender";
import { BLOB_CHUNK_BYTES, BLOB_COMMIT_BYTES } from "@pwragent/federation/federation-resumable-blob";
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
