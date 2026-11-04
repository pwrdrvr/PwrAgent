import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { FEDERATION_PROTOCOL_VERSION, type FederationProtocolEnvelope, type ThreadHandoffPackage } from "@pwragent/shared";
import { encodeThreadHandoff } from "../federation/thread-handoff-package";
import { federationTransportCodecForTest } from "../federation/federation-transport";
import { encodeFederationFramePayload } from "@pwragent/federation/federation-frame-codec";

// Opt-in reproducible measurement, excluded from routine unit-test cost.
// PWRAGENT_MEASURE_BLOB_WIRE=1 pnpm test .../federation-blob-wire-measurement.test.ts
it.runIf(process.env.PWRAGENT_MEASURE_BLOB_WIRE === "1")("measures both wire encodings on the same 8.8 MiB source corpus", async () => {
  const buffers: Buffer[] = [];
  const collect = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (entry.name === "__tests__" || entry.name === "fixtures") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) buffers.push(await readFile(file));
    }
  };
  await collect(path.resolve("apps/desktop/src/main"));
  await collect(path.resolve("packages/federation/src"));
  const corpus = Buffer.concat(buffers);
  const size = Math.floor(8.8 * 1024 * 1024);
  const raw = Buffer.concat(Array.from({ length: Math.ceil(size / corpus.length) }, () => corpus)).subarray(0, size);
  const pkg: ThreadHandoffPackage = { version: 2, handoffId: "00000000-0000-0000-0000-000000000000",
    sourceThreadId: "fixture", historyDigest: "0".repeat(64), rolloutBase64: raw.toString("base64") };
  const oldPackage = await encodeThreadHandoff(pkg, false);
  const binaryPackage = await encodeThreadHandoff(pkg);
  const envelope = { id: "federation-request:00000000-0000-0000-0000-000000000000", protocolVersion: FEDERATION_PROTOCOL_VERSION,
    sourceInstanceId: "source-fixture", targetInstanceId: "target-fixture", createdAt: 1 };
  const count = (data: Buffer, binary: boolean, brotli: boolean): number => {
    let bytes = 0;
    for (let offset = 0; offset < data.length; offset += 256 * 1024) {
      const chunk = data.subarray(offset, offset + 256 * 1024);
      const message: FederationProtocolEnvelope = binary ? { ...envelope, kind: "blob_chunk", purpose: "file_push",
        transferId: "blob:00000000-0000-0000-0000-000000000000", chunkIndex: offset / (256 * 1024),
        chunkCount: Math.ceil(data.length / (256 * 1024)), totalSize: data.length, sha256: "0".repeat(64),
        name: "fixture.pwragent-handoff", inputType: "localFile", data: chunk,
      } : { ...envelope, kind: "request", method: "file.push.chunk", params: {
        transferId: "00000000-0000-0000-0000-000000000000", offset, dataBase64: chunk.toString("base64"),
      } };
      const frame = federationTransportCodecForTest.encodeEnvelope(message);
      bytes += encodeFederationFramePayload({ json: frame, compressionEnabled: brotli && !binary }).length;
    }
    return bytes;
  };
  const result = { rawBytes: raw.length, sampleSha256: createHash("sha256").update(raw).digest("hex"),
    rawGzipBytes: gzipSync(raw).length, oldPackageBytes: oldPackage.length, binaryPackageBytes: binaryPackage.length,
    beforeWithoutBrotli: count(oldPackage, false, false), beforeWithBrotli: count(oldPackage, false, true),
    after: count(binaryPackage, true, false) };
  expect(result.after).toBeLessThan(result.beforeWithBrotli);
  await mkdir(".local", { recursive: true });
  await writeFile(".local/federation-blob-wire.json", JSON.stringify(result, null, 2));
  console.info("federation-blob-wire", JSON.stringify(result));
});
