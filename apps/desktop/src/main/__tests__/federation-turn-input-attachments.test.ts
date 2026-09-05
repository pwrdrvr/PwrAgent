import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
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
  portableTurnInputAttachments,
  stageQueuedFileInputs,
  TURN_INPUT_ATTACHMENT_MAX_AGE_MS,
  turnInputAttachmentRoot,
} from "../app-server/turn-input-attachment-files";
import {
  FEDERATION_BLOB_CHUNK_BYTES,
  FEDERATION_BLOB_WAIT_TIMEOUT_MS,
  FEDERATION_TURN_INPUT_MAX_AGE_MS,
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
  it("stages recovered file bytes before draft persistence and preserves empty files", async () => {
    await createTestRoot();
    const input = await stageQueuedFileInputs([
      { type: "file", name: "notes.txt", mimeType: "text/plain", data: "AQID" },
      { type: "file", name: "empty.txt", mimeType: "text/plain", data: "" },
    ]);
    expect(input.every((item) => item.type === "localFile")).toBe(true);
    expect(JSON.stringify(input)).not.toContain('"data"');
    for (const [index, item] of input.entries()) {
      if (item.type !== "localFile") throw new Error("Expected staged file");
      expect(await readFile(item.path)).toEqual(index === 0 ? Buffer.from([1, 2, 3]) : Buffer.alloc(0));
    }
  });

  it("recovers owner-local queued attachments and round-trips their bytes through the existing upload seam", async () => {
    await createTestRoot();
    const image = await stageTurnInputAttachment({ type: "localImage", name: "diagram.png", data: Buffer.from([1, 2, 3]) });
    const file = await stageTurnInputAttachment({ type: "localFile", name: "notes.txt", mimeType: "text/plain", data: Buffer.from("Unicode Ω\n\nsecond paragraph") });
    const portable = await portableTurnInputAttachments([{ type: "text", text: "# Full prompt" }, image, file]);
    expect(portable).toEqual([
      { type: "text", text: "# Full prompt" },
      { type: "image", name: "diagram.png", url: "data:image/png;base64,AQID" },
      expect.objectContaining({ type: "file", name: "notes.txt", data: Buffer.from("Unicode Ω\n\nsecond paragraph").toString("base64") }),
    ]);
    const envelopes: FederationBlobChunkEnvelope[] = [];
    await prepareOutgoingFederationTurnInput({ input: portable, localInstanceId: "viewer", targetInstanceId: "owner", sendEnvelope: collectBlobChunks(envelopes) });
    expect(envelopes.map((envelope) => envelope.data)).toEqual([Buffer.from([1, 2, 3]), Buffer.from("Unicode Ω\n\nsecond paragraph")]);
    await expect(portableTurnInputAttachments([{ type: "localFile", path: "/missing/queued-attachment.txt" }])).rejects.toThrow();
  });

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

  it("awaits each asynchronous chunk writer before reading the next chunk", async () => {
    await createTestRoot();
    const sourcePath = path.join(turnInputAttachmentRoot(), "slow-source.bin");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      Buffer.alloc(FEDERATION_BLOB_CHUNK_BYTES + 1, 0x5a),
    );
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sendCount = 0;
    const preparing = prepareOutgoingFederationTurnInput({
      input: [{ type: "localFile", name: "slow-source.bin", path: sourcePath }],
      localInstanceId: "source_one",
      targetInstanceId: "owner_one",
      sendEnvelope: async () => {
        sendCount += 1;
        if (sendCount === 1) {
          await firstReleased;
        }
      },
    });

    await vi.waitFor(() => expect(sendCount).toBe(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(sendCount).toBe(1);
    releaseFirst();
    await preparing;
    expect(sendCount).toBe(2);
  });

  it("treats the receive deadline as an inactivity timeout", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestRoot();
      const data = Buffer.alloc(FEDERATION_BLOB_CHUNK_BYTES * 2 + 1, 0x2a);
      const transferId = "progressing-transfer";
      const receiver = new FederationTurnInputAttachmentReceiver({
        resolveRoot: () => path.join(root, "receiver"),
      });
      const resolved = receiver.resolveInput(
        [{ type: "federationBlob", transferId }],
        "source_one",
      );
      const metadata = {
        chunkCount: 3,
        sha256: sha256(data),
        totalSize: data.byteLength,
        transferId,
      };

      await receiver.receive(blobEnvelope({
        ...metadata,
        chunkIndex: 0,
        data: data.subarray(0, FEDERATION_BLOB_CHUNK_BYTES),
      }), "source_one");
      await vi.advanceTimersByTimeAsync(FEDERATION_BLOB_WAIT_TIMEOUT_MS - 1);
      await receiver.receive(blobEnvelope({
        ...metadata,
        chunkIndex: 1,
        data: data.subarray(
          FEDERATION_BLOB_CHUNK_BYTES,
          FEDERATION_BLOB_CHUNK_BYTES * 2,
        ),
      }), "source_one");
      await vi.advanceTimersByTimeAsync(FEDERATION_BLOB_WAIT_TIMEOUT_MS - 1);
      await receiver.receive(blobEnvelope({
        ...metadata,
        chunkIndex: 2,
        data: data.subarray(FEDERATION_BLOB_CHUNK_BYTES * 2),
      }), "source_one");

      await expect(resolved).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("expires old receiver-owned blob files after a later transfer", async () => {
    const root = await createTestRoot();
    const receiverRoot = path.join(root, "receiver");
    const stalePath = path.join(
      receiverRoot,
      "source_one",
      "a".repeat(64),
      "stale.png",
    );
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, Buffer.from([1]));
    const staleDate = new Date(Date.now() - FEDERATION_TURN_INPUT_MAX_AGE_MS - 1);
    await utimes(path.dirname(stalePath), staleDate, staleDate);

    const receiver = new FederationTurnInputAttachmentReceiver({
      resolveRoot: () => receiverRoot,
    });
    await receiver.receive(blobEnvelope({ transferId: "cleanup-trigger" }), "source_one");

    await vi.waitFor(async () => {
      expect(await stat(stalePath).catch(() => undefined)).toBeUndefined();
    });
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

  it("refreshes reused local staging directories before age cleanup", async () => {
    await createTestRoot();
    const data = Uint8Array.from([7, 8, 9]);
    const staged = await stageTurnInputAttachment({
      type: "localImage",
      data,
      name: "reused.png",
    });
    const staleDate = new Date(Date.now() - TURN_INPUT_ATTACHMENT_MAX_AGE_MS - 1);
    await utimes(staged.path, staleDate, staleDate);
    await utimes(path.dirname(staged.path), staleDate, staleDate);

    const reused = await stageTurnInputAttachment({
      type: "localImage",
      data,
      name: "reused.png",
    });
    expect((await stat(path.dirname(reused.path))).mtimeMs)
      .toBeGreaterThan(staleDate.getTime());
    await stageTurnInputAttachment({
      type: "localImage",
      data: Uint8Array.from([1, 2, 3]),
      name: "cleanup-trigger.png",
    });

    await vi.waitFor(async () => {
      await expect(readFile(reused.path)).resolves.toEqual(Buffer.from(data));
    });
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
