import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import { BLOB_CHUNK_BYTES, BLOB_COMMIT_BYTES, FederationResumableBlobReceiver } from "@pwragent/federation/federation-resumable-blob";

it.skipIf(process.env.PWRAGENT_MEASURE_BLOB_COMMIT !== "1")("measures durable blob commit cost on the current filesystem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-commit-measurement-"));
  const receiver = new FederationResumableBlobReceiver({ directory: () => root });
  const sizeBytes = 64 * 1024 * 1024;
  const identity = { sha256: "0".repeat(64), sizeBytes, name: "measurement" };
  const chunk = Buffer.alloc(BLOB_CHUNK_BYTES, 0x57);
  const commitMs: number[] = [];
  const writeMs: number[] = [];
  try {
    const { transferId } = await receiver.begin("source", identity);
    const started = performance.now();
    for (let offset = 0; offset < sizeBytes; offset += chunk.length) {
      const before = performance.now();
      await receiver.chunk("source", {
        id: `measurement:${offset}`, kind: "blob_chunk", purpose: "file_push",
        protocolVersion: FEDERATION_PROTOCOL_VERSION, sourceInstanceId: "source", targetInstanceId: "target",
        createdAt: Date.now(), transferId, chunkIndex: offset / chunk.length, chunkCount: sizeBytes / chunk.length,
        totalSize: sizeBytes, sha256: identity.sha256, name: identity.name, inputType: "localFile", data: chunk,
      });
      const elapsed = performance.now() - before;
      // The boundary chunk includes its write, part fsync, atomic sidecar
      // write/fsync/rename, and both directory fsyncs. This is an upper bound
      // on fsync cost, measured on the actual receiver rather than a stub.
      (offset + chunk.length === receiver.checkpoint("source", transferId).committedOffset ? commitMs : writeMs).push(elapsed);
    }
    expect(receiver.checkpoint("source", transferId).committedOffset).toBe(sizeBytes);
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const totalMs = sorted.reduce((sum, value) => sum + value, 0);
      return { count: sorted.length, totalMs, meanMs: totalMs / sorted.length,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] };
    };
    const result = { platform: process.platform, sizeBytes, commitBytes: BLOB_COMMIT_BYTES,
      elapsedMs: performance.now() - started, durableBoundary: stats(commitMs), ordinaryWrite: stats(writeMs) };
    await mkdir(".local", { recursive: true });
    await writeFile(".local/federation-blob-commit.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
