import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FederationBlobChunkEnvelope,
  FederationProtocolEnvelope,
} from "@pwragent/shared";
import { imageInputFileRoot } from "../app-server/image-input-files";
import {
  stageTurnInputAttachment,
  turnInputAttachmentRoot,
} from "../app-server/turn-input-attachment-files";
import {
  FEDERATION_BLOB_CHUNK_BYTES,
  FederationTurnInputAttachmentReceiver,
  MAX_INCOMPLETE_FEDERATION_BLOBS_PER_SOURCE,
  prepareOutgoingFederationTurnInput,
} from "../federation/federation-turn-input-attachments";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("federation turn input attachments", () => {
  it("stages data URLs and existing PwrAgent image inputs before binary upload", async () => {
    const root = await createTestRoot();
    const existingBytes = Buffer.from([9, 8, 7, 6]);
    const existingPath = path.join(imageInputFileRoot(), "existing.png");
    await mkdir(path.dirname(existingPath), { recursive: true });
    await writeFile(existingPath, existingBytes);
    const envelopes: FederationBlobChunkEnvelope[] = [];

    const prepared = await prepareOutgoingFederationTurnInput({
      input: [
        {
          type: "image",
          name: "pasted.png",
          url: "data:image/png;base64,AQID",
        },
        { type: "localImage", name: "existing.png", path: existingPath },
      ],
      localInstanceId: "source_one",
      targetInstanceId: "owner_one",
      privateStorageRoots: [path.join(root, "profiles", "test")],
      sendEnvelope: (envelope) => {
        if (envelope.kind === "blob_chunk") {
          envelopes.push(envelope);
        }
      },
    });

    expect(prepared).toEqual([
      { type: "federationBlob", transferId: expect.any(String) },
      { type: "federationBlob", transferId: expect.any(String) },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("base64");
    expect(JSON.stringify(prepared)).not.toContain(existingPath);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(envelopes[1]?.data).toEqual(existingBytes);
  });

  it("round-trips multi-chunk bytes into receiver-owned verified paths", async () => {
    await createTestRoot();
    const sourcePath = path.join(turnInputAttachmentRoot(), "source.bin");
    const data = Buffer.alloc(FEDERATION_BLOB_CHUNK_BYTES + 3, 0x5a);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, data);
    const envelopes: FederationBlobChunkEnvelope[] = [];
    const prepared = await prepareOutgoingFederationTurnInput({
      input: [{ type: "localFile", name: "source.bin", path: sourcePath }],
      localInstanceId: "source_one",
      targetInstanceId: "owner_one",
      sendEnvelope: collectBlobChunks(envelopes),
    });
    const receiverRoot = path.join(path.dirname(turnInputAttachmentRoot()), "received");
    const receiver = new FederationTurnInputAttachmentReceiver({
      resolveRoot: () => receiverRoot,
    });
    const resolved = receiver.resolveInput(prepared, "source_one");

    for (const envelope of envelopes) {
      await receiver.receive(envelope, "source_one");
    }

    const input = await resolved;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      type: "localFile",
      name: "source.bin",
      path: expect.stringMatching(/received/u),
    });
    const receivedPath = input[0]?.type === "localFile" ? input[0].path : "";
    await expect(readFile(receivedPath)).resolves.toEqual(data);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.data).toHaveLength(FEDERATION_BLOB_CHUNK_BYTES);
    expect(envelopes[1]?.data).toHaveLength(3);
  });

  it("rejects peer paths and malformed chunk geometry", async () => {
    const receiver = new FederationTurnInputAttachmentReceiver({
      resolveRoot: () => path.join(os.tmpdir(), "unused-federation-inputs"),
    });
    await expect(receiver.resolveInput(
      [{ type: "localImage", path: "/tmp/peer-controlled.png" }],
      "source_one",
    )).rejects.toThrow(/verified blob transfer reference/u);

    await expect(receiver.receive(blobEnvelope({
      chunkCount: 1_000_000,
      data: Uint8Array.from([1]),
      totalSize: 1,
    }), "source_one")).rejects.toThrow(/geometry/u);
    await expect(receiver.receive(blobEnvelope({
      chunkCount: 2,
      data: new Uint8Array(FEDERATION_BLOB_CHUNK_BYTES - 1),
      totalSize: FEDERATION_BLOB_CHUNK_BYTES + 1,
    }), "source_one")).rejects.toThrow(/geometry/u);
    await expect(receiver.receive(blobEnvelope({
      chunkCount: 2,
      chunkIndex: 1,
      data: new Uint8Array(0),
      totalSize: FEDERATION_BLOB_CHUNK_BYTES + 1,
    }), "source_one")).rejects.toThrow(/geometry/u);
  });

  it("caps incomplete transfers per authenticated source", async () => {
    const receiver = new FederationTurnInputAttachmentReceiver();
    for (
      let index = 0;
      index < MAX_INCOMPLETE_FEDERATION_BLOBS_PER_SOURCE;
      index += 1
    ) {
      await receiver.receive(blobEnvelope({
        chunkCount: 2,
        data: new Uint8Array(FEDERATION_BLOB_CHUNK_BYTES),
        totalSize: FEDERATION_BLOB_CHUNK_BYTES + 1,
        transferId: `transfer-${index}`,
      }), "source_one");
    }

    await expect(receiver.receive(blobEnvelope({
      chunkCount: 2,
      data: new Uint8Array(FEDERATION_BLOB_CHUNK_BYTES),
      totalSize: FEDERATION_BLOB_CHUNK_BYTES + 1,
      transferId: "transfer-over-limit",
    }), "source_one")).rejects.toThrow(/Too many incomplete/u);

    await expect(receiver.receive(blobEnvelope({
      chunkCount: 2,
      data: new Uint8Array(FEDERATION_BLOB_CHUNK_BYTES),
      totalSize: FEDERATION_BLOB_CHUNK_BYTES + 1,
      transferId: "other-peer-transfer",
    }), "source_two")).resolves.toBeUndefined();
  });

  it("replaces corrupt content-addressed receiver files and reuses verified files", async () => {
    const root = await createTestRoot();
    const receiverRoot = path.join(root, "receiver");
    const data = Buffer.from([1, 3, 3, 7]);
    const digest = sha256(data);
    const destination = path.join(
      receiverRoot,
      "source_one",
      digest,
      "screen.png",
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from([9, 9, 9, 9]));
    const corruptInode = (await stat(destination)).ino;
    const envelope = blobEnvelope({
      data,
      name: "screen.png",
      sha256: digest,
      totalSize: data.byteLength,
      transferId: "replace-corrupt",
    });
    const receiver = new FederationTurnInputAttachmentReceiver({
      resolveRoot: () => receiverRoot,
    });
    const resolved = receiver.resolveInput(
      [{ type: "federationBlob", transferId: envelope.transferId }],
      "source_one",
    );
    await receiver.receive(envelope, "source_one");
    await resolved;

    await expect(readFile(destination)).resolves.toEqual(data);
    expect((await stat(destination)).ino).not.toBe(corruptInode);

    const verifiedInode = (await stat(destination)).ino;
    const reuseEnvelope = {
      ...envelope,
      id: "blob-reuse",
      transferId: "reuse-verified",
    };
    const reused = receiver.resolveInput(
      [{ type: "federationBlob", transferId: reuseEnvelope.transferId }],
      "source_one",
    );
    await receiver.receive(reuseEnvelope, "source_one");
    await reused;
    expect((await stat(destination)).ino).toBe(verifiedInode);
  });

  it("atomically replaces corrupt local staged content and reuses verified content", async () => {
    await createTestRoot();
    const data = Uint8Array.from([4, 5, 6]);
    const first = await stageTurnInputAttachment({
      type: "localImage",
      data,
      name: "paste.png",
    });
    await writeFile(first.path, Buffer.from([0, 0, 0]));
    const corruptInode = (await stat(first.path)).ino;

    const replaced = await stageTurnInputAttachment({
      type: "localImage",
      data,
      name: "paste.png",
    });
    await expect(readFile(replaced.path)).resolves.toEqual(Buffer.from(data));
    expect((await stat(replaced.path)).ino).not.toBe(corruptInode);

    const verifiedInode = (await stat(replaced.path)).ino;
    await stageTurnInputAttachment({
      type: "localImage",
      data,
      name: "paste.png",
    });
    expect((await stat(replaced.path)).ino).toBe(verifiedInode);
  });
});

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-federation-input-"));
  temporaryRoots.push(root);
  vi.stubEnv("PWRAGENT_HOME", root);
  vi.stubEnv("PWRAGENT_PROFILE", "test");
  return root;
}

function collectBlobChunks(
  chunks: FederationBlobChunkEnvelope[],
): (envelope: FederationProtocolEnvelope) => void {
  return (envelope) => {
    if (envelope.kind === "blob_chunk") {
      chunks.push(envelope);
    }
  };
}

function blobEnvelope(
  overrides: Partial<FederationBlobChunkEnvelope> = {},
): FederationBlobChunkEnvelope {
  const data = overrides.data ?? Uint8Array.from([1]);
  return {
    id: "blob-1",
    kind: "blob_chunk",
    protocolVersion: 1,
    sourceInstanceId: "source_one",
    targetInstanceId: "owner_one",
    createdAt: 1_000,
    transferId: "transfer-1",
    chunkIndex: 0,
    chunkCount: 1,
    totalSize: data.byteLength,
    sha256: sha256(data),
    name: "screen.png",
    inputType: "localImage",
    data,
    ...overrides,
  };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
