import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { pushResumableBlob, type ResumableBlobTransport } from "@pwragent/federation/federation-blob-sender";
import { BLOB_CHUNK_BYTES } from "@pwragent/federation/federation-resumable-blob";
import { FederationFilePushReceiver, FILE_PUSH_METHODS } from "../federation/federation-file-push";

type Progress = { bytesCommitted: number; bytesSent?: number; bytesTotal: number; link: "connected" | "waiting" };

async function transferSmallBlob(fill: number, dropAfterChunks?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "small-blob-model-"));
  const source = path.join(root, "source");
  const data = Buffer.alloc(2 * 1024 * 1024, fill);
  const makeReceiver = () => new FederationFilePushReceiver({ allowed: () => true, directory: () => path.join(root, "received") });
  let receiver = makeReceiver();
  let generation = 0;
  let sentChunks = 0;
  let resumedOffset = 0;
  let finishStarted = false;
  const begins: number[] = [];
  const progressBeforeFinish: Progress[] = [];
  const progress: Progress[] = [];
  const transport: ResumableBlobTransport = {
    localInstanceId: "source", targetInstanceId: "target",
    waitForReconnect: async () => undefined,
    cancel: () => undefined,
    connection: () => {
      const current = generation;
      return {
        didDisconnect: () => current !== generation,
        rpc: { request: async <T>(request: { method: string; params: unknown; timeoutMs?: number | null }): Promise<T> => {
          expect(request.timeoutMs).toBeNull();
          if (request.method === FILE_PUSH_METHODS.finish) finishStarted = true;
          const result = await receiver.handle("source", request.method, request.params);
          if (request.method === FILE_PUSH_METHODS.begin) {
            // One begin per generation; a live connection never retries.
            expect(begins).toHaveLength(current);
            resumedOffset = (result as { committedOffset: number }).committedOffset;
            begins.push(resumedOffset);
          }
          return result as T;
        } },
        send: async (envelope) => {
          expect(envelope.chunkIndex * BLOB_CHUNK_BYTES).toBeGreaterThanOrEqual(resumedOffset);
          await receiver.receiveBlob(envelope);
          sentChunks++;
          if (generation === 0 && sentChunks === dropAfterChunks) {
            generation++;
            await receiver.dispose();
            receiver = makeReceiver();
            throw new Error("model: connection dropped after chunk delivery");
          }
        },
      };
    },
  };
  try {
    await writeFile(source, data);
    const result = await pushResumableBlob(transport, source, "fixture", {
      onTransferProgress: (update) => {
        progress.push(update);
        if (!finishStarted) progressBeforeFinish.push(update);
      },
    });
    expect((await readFile(result.path)).equals(data)).toBe(true);
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    return { begins, progress, progressBeforeFinish };
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

it("a 2 MiB transfer resumes its durable first MiB after a drop at 1.5 MiB", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 7 }), fc.integer({ min: 0, max: 255 }), async (dropChunk, fill) => {
    const { begins, progress } = await transferSmallBlob(fill, dropChunk);
    expect(begins).toEqual([0, 1024 * 1024]);
    expect(progress.some((update) => update.link === "waiting")).toBe(true);
    let committed = 0;
    for (const update of progress) {
      expect(update.bytesCommitted).toBeGreaterThanOrEqual(committed);
      committed = update.bytesCommitted;
    }
  }), { numRuns: 8, examples: [[6, 0x57]] });
});

it("a 2 MiB transfer reports increasing acknowledged bytesSent before finish", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 255 }), async (fill) => {
    const { begins, progressBeforeFinish } = await transferSmallBlob(fill);
    expect(begins).toEqual([0]);
    expect(progressBeforeFinish.map((update) => update.bytesSent)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    expect(progressBeforeFinish[1].bytesCommitted).toBe(1024 * 1024);
  }), { numRuns: 5 });
});
