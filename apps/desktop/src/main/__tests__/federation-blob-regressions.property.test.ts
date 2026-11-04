import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { expect, it } from "vitest";
import { encodeThreadHandoff } from "../federation/thread-handoff-package";
import { FederationFilePushReceiver, FILE_PUSH_METHODS } from "../federation/federation-file-push";

// Oracle: a raw-byte gzip, with a small allowance for the manifest. Base64
// phase shifts between source lines defeat the compressor's dictionary.
it("packages raw history within the raw gzip budget", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 40, max: 100 }), async (count) => {
    const raw = Buffer.from(Array.from({ length: count }, (_, i) =>
      JSON.stringify({ type: "message", index: i, text: "repeatable source text and tool output ".repeat(30 + i % 7) })).join("\n"));
    const encoded = await encodeThreadHandoff({ version: 2,
      handoffId: "00000000-0000-0000-0000-000000000000", sourceThreadId: "fixture",
      historyDigest: "0".repeat(64), rolloutBase64: raw.toString("base64") });
    expect(encoded.length).toBeLessThanOrEqual(gzipSync(raw).length + 300);
  }), { numRuns: 10 });
});

// The receiver, including its on-disk sidecar, is the oracle for begin.
it("begin reports a durable offset for a content-addressed transfer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-regression-"));
  const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
  try {
    const result = await receiver.handle("peer", FILE_PUSH_METHODS.begin, {
      name: "fixture", sizeBytes: 100, sha256: "0".repeat(64), binary: true,
    }) as { committedOffset: number };
    expect(result.committedOffset).toBe(0);
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
