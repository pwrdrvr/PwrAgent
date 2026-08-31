import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppServerFileInputItem,
  AppServerTurnInputItem,
  FederationBlobChunkEnvelope,
  FederationInstanceId,
  FederationProtocolEnvelope,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import {
  MAX_TURN_INPUT_ATTACHMENT_BYTES,
  sanitizeTurnAttachmentName,
  stageLocalTurnInputAttachment,
  stageTurnInputAttachment,
  type StagedTurnInputAttachment,
} from "../app-server/turn-input-attachment-files";
import { resolveActiveProfilePath } from "../profile";

export const FEDERATION_BLOB_CHUNK_BYTES = 512 * 1024;
export const FEDERATION_BLOB_WAIT_TIMEOUT_MS = 30_000;
const FEDERATION_BLOB_COMPLETED_RETENTION_MS = 10 * 60_000;
export const FEDERATION_TURN_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INCOMPLETE_FEDERATION_BLOBS_PER_SOURCE = 8;
export const MAX_BUFFERED_FEDERATION_BLOB_BYTES = 256 * 1024 * 1024;

export type FederationTurnInputBlobReference = {
  type: "federationBlob";
  transferId: string;
};

export type FederationWireTurnInputItem =
  | AppServerTurnInputItem
  | FederationTurnInputBlobReference;

type IncomingTransferMetadata = {
  transferId: string;
  chunkCount: number;
  totalSize: number;
  sha256: string;
  name: string;
  mimeType?: string;
  inputType: "localFile" | "localImage";
};

type IncomingTransfer = {
  chunks: Map<number, Buffer>;
  completion: Promise<StagedTurnInputAttachment>;
  metadata?: IncomingTransferMetadata;
  receivedBytes: number;
  reject: (error: Error) => void;
  resolve: (attachment: StagedTurnInputAttachment) => void;
  sourceInstanceId: FederationInstanceId;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

export async function prepareOutgoingFederationTurnInput(params: {
  input: readonly AppServerTurnInputItem[];
  localInstanceId: FederationInstanceId;
  targetInstanceId: FederationInstanceId;
  sendEnvelope: (
    envelope: FederationProtocolEnvelope,
  ) => Promise<void> | void;
  privateStorageRoots?: readonly string[];
}): Promise<FederationWireTurnInputItem[]> {
  const prepared: FederationWireTurnInputItem[] = [];

  for (const item of params.input) {
    const staged = await stageTransferableInput(item, {
      privateStorageRoots: params.privateStorageRoots,
    });
    if (!staged) {
      if (item.type === "image" && item.url.startsWith("data:")) {
        throw new Error(
          "Inline image data could not be staged for federation transfer.",
        );
      }
      prepared.push(item);
      continue;
    }
    prepared.push(
      await sendStagedAttachment({
        attachment: staged,
        localInstanceId: params.localInstanceId,
        targetInstanceId: params.targetInstanceId,
        sendEnvelope: params.sendEnvelope,
      }),
    );
  }

  return prepared;
}

export function hasFederationTurnInputAttachments(
  input: readonly AppServerTurnInputItem[],
): boolean {
  return input.some(
    (item) =>
      item.type === "file"
      || item.type === "localFile"
      || item.type === "localImage"
      || (item.type === "image" && item.url.startsWith("data:"))
      || (item.type === "image" && item.url.startsWith("file:")),
  );
}

async function stageTransferableInput(
  item: AppServerTurnInputItem,
  options: { privateStorageRoots?: readonly string[] },
): Promise<StagedTurnInputAttachment | undefined> {
  if (item.type === "localImage" || item.type === "localFile") {
    return await stageLocalTurnInputAttachment(item, options);
  }
  if (item.type === "file") {
    return await stageTurnInputAttachment({
      type: "localFile",
      data: decodeBase64File(item),
      name: item.name,
      mimeType: item.mimeType,
    });
  }
  if (item.type !== "image") {
    return undefined;
  }
  if (item.url.startsWith("file:")) {
    const filePath = filePathFromUrl(item.url);
    if (!filePath) {
      throw new Error("Invalid local image file URL.");
    }
    return await stageLocalTurnInputAttachment({
      type: "localImage",
      ...(item.name ? { name: item.name } : {}),
      path: filePath,
    }, options);
  }
  const parsed = parseImageDataUrl(item.url);
  if (!parsed) {
    return undefined;
  }
  return await stageTurnInputAttachment({
    type: "localImage",
    data: parsed.data,
    name: item.name,
    mimeType: parsed.mimeType,
  });
}

function filePathFromUrl(value: string): string | undefined {
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function decodeBase64File(item: AppServerFileInputItem): Buffer {
  if (!/^[a-z0-9+/]*={0,2}$/iu.test(item.data) || item.data.length % 4 !== 0) {
    throw new Error(`File attachment ${item.name} has invalid base64 data.`);
  }
  return Buffer.from(item.data, "base64");
}

function parseImageDataUrl(
  url: string,
): { data: Buffer; mimeType: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(url);
  if (!match || (match[2]?.length ?? 0) % 4 !== 0) {
    return undefined;
  }
  const data = Buffer.from(match[2] ?? "", "base64");
  if (data.byteLength === 0) {
    return undefined;
  }
  return { data, mimeType: match[1] ?? "application/octet-stream" };
}

async function sendStagedAttachment(params: {
  attachment: StagedTurnInputAttachment;
  localInstanceId: FederationInstanceId;
  targetInstanceId: FederationInstanceId;
  sendEnvelope: (
    envelope: FederationProtocolEnvelope,
  ) => Promise<void> | void;
}): Promise<FederationTurnInputBlobReference> {
  const fileInfo = await stat(params.attachment.path);
  if (!fileInfo.isFile()) {
    throw new Error("Turn attachment path is not a regular file.");
  }
  if (fileInfo.size > MAX_TURN_INPUT_ATTACHMENT_BYTES) {
    throw new Error(
      `Turn attachment exceeds the ${MAX_TURN_INPUT_ATTACHMENT_BYTES}-byte limit.`,
    );
  }
  const transferId = randomUUID();
  const chunkCount = Math.max(
    1,
    Math.ceil(fileInfo.size / FEDERATION_BLOB_CHUNK_BYTES),
  );
  const sha256 = await hashFile(params.attachment.path);
  const name = sanitizeTurnAttachmentName(
    params.attachment.name,
    path.basename(params.attachment.path),
  );
  const mimeType = params.attachment.type === "localFile"
    ? params.attachment.mimeType
    : undefined;

  const file = await open(params.attachment.path, "r");
  try {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const remaining = fileInfo.size - chunkIndex * FEDERATION_BLOB_CHUNK_BYTES;
      const chunk = Buffer.allocUnsafe(
        Math.max(0, Math.min(FEDERATION_BLOB_CHUNK_BYTES, remaining)),
      );
      if (chunk.byteLength > 0) {
        const result = await file.read(chunk, 0, chunk.byteLength, null);
        if (result.bytesRead !== chunk.byteLength) {
          throw new Error(
            "Turn attachment changed while it was being transferred.",
          );
        }
      }
      await params.sendEnvelope({
        id: `federation-blob:${transferId}:${chunkIndex}`,
        kind: "blob_chunk",
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: params.localInstanceId,
        targetInstanceId: params.targetInstanceId,
        createdAt: Date.now(),
        transferId,
        chunkIndex,
        chunkCount,
        totalSize: fileInfo.size,
        sha256,
        name,
        ...(mimeType ? { mimeType } : {}),
        inputType: params.attachment.type,
        data: chunk,
      });
    }
  } finally {
    await file.close();
  }

  return { type: "federationBlob", transferId };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export class FederationTurnInputAttachmentReceiver {
  private readonly transfers = new Map<string, IncomingTransfer>();
  private bufferedBytes = 0;

  constructor(
    private readonly options: {
      resolveRoot?: () => string;
      now?: () => number;
    } = {},
  ) {}

  async receive(
    envelope: FederationBlobChunkEnvelope,
    sourceInstanceId: FederationInstanceId,
  ): Promise<void> {
    validateBlobChunk(envelope);
    const key = transferKey(sourceInstanceId, envelope.transferId);
    const transfer = this.getOrCreateTransfer(key, sourceInstanceId);
    const metadata = metadataFromEnvelope(envelope);
    if (transfer.metadata && !sameMetadata(transfer.metadata, metadata)) {
      this.failTransfer(key, transfer, new Error("Federation blob metadata changed between chunks."));
      throw new Error("Federation blob metadata changed between chunks.");
    }
    transfer.metadata ??= metadata;

    const previous = transfer.chunks.get(envelope.chunkIndex);
    const chunk = Buffer.from(envelope.data);
    if (previous) {
      if (!previous.equals(chunk)) {
        this.failTransfer(key, transfer, new Error("Federation blob chunk was replayed with different bytes."));
        throw new Error("Federation blob chunk was replayed with different bytes.");
      }
      return;
    }
    if (
      this.bufferedBytes + chunk.byteLength
      > MAX_BUFFERED_FEDERATION_BLOB_BYTES
    ) {
      this.failTransfer(
        key,
        transfer,
        new Error("Federation blob buffer limit exceeded."),
      );
      throw new Error("Federation blob buffer limit exceeded.");
    }
    transfer.chunks.set(envelope.chunkIndex, chunk);
    transfer.receivedBytes += chunk.byteLength;
    this.bufferedBytes += chunk.byteLength;
    if (transfer.receivedBytes > metadata.totalSize) {
      this.failTransfer(key, transfer, new Error("Federation blob exceeded its declared size."));
      throw new Error("Federation blob exceeded its declared size.");
    }
    if (transfer.chunks.size !== metadata.chunkCount) {
      this.armTransferTimeout(key, transfer);
      return;
    }
    clearTimeout(transfer.timeout);

    try {
      const attachment = await this.persistCompletedTransfer(
        sourceInstanceId,
        metadata,
        transfer.chunks,
      );
      transfer.settled = true;
      this.releaseBufferedChunks(transfer);
      clearTimeout(transfer.timeout);
      transfer.resolve(attachment);
      const cleanup = setTimeout(() => {
        if (this.transfers.get(key) === transfer) {
          this.transfers.delete(key);
        }
      }, FEDERATION_BLOB_COMPLETED_RETENTION_MS);
      cleanup.unref?.();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failTransfer(key, transfer, failure);
      throw failure;
    }
  }

  async resolveInput(
    input: readonly FederationWireTurnInputItem[],
    sourceInstanceId: FederationInstanceId,
  ): Promise<AppServerTurnInputItem[]> {
    return await Promise.all(
      input.map(async (item) => {
        if (!isFederationTurnInputBlobReference(item)) {
          assertSafeFederationInlineInput(item);
          return item;
        }
        const transfer = this.getOrCreateTransfer(
          transferKey(sourceInstanceId, item.transferId),
          sourceInstanceId,
        );
        return await transfer.completion;
      }),
    );
  }

  private getOrCreateTransfer(
    key: string,
    sourceInstanceId: FederationInstanceId,
  ): IncomingTransfer {
    const existing = this.transfers.get(key);
    if (existing) {
      return existing;
    }
    const incompleteForSource = [...this.transfers.values()].filter(
      (transfer) =>
        !transfer.settled
        && transfer.sourceInstanceId === sourceInstanceId,
    ).length;
    if (incompleteForSource >= MAX_INCOMPLETE_FEDERATION_BLOBS_PER_SOURCE) {
      throw new Error(
        "Too many incomplete federation blob transfers from this peer.",
      );
    }
    let resolve!: (attachment: StagedTurnInputAttachment) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<StagedTurnInputAttachment>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A malformed peer chunk can fail before the matching RPC reaches the
    // resolver. Keep the original rejecting promise for callers while also
    // marking it observed so an unaffiliated peer cannot cause an unhandled
    // rejection in the main process.
    void completion.catch(() => undefined);
    const transfer = {
      chunks: new Map<number, Buffer>(),
      completion,
      receivedBytes: 0,
      reject,
      resolve,
      sourceInstanceId,
      settled: false,
      timeout: setTimeout(() => undefined, 0),
    } satisfies IncomingTransfer;
    clearTimeout(transfer.timeout);
    this.armTransferTimeout(key, transfer);
    this.transfers.set(key, transfer);
    return transfer;
  }

  private armTransferTimeout(
    key: string,
    transfer: IncomingTransfer,
  ): void {
    clearTimeout(transfer.timeout);
    transfer.timeout = setTimeout(() => {
      this.failTransfer(
        key,
        transfer,
        new Error("Timed out waiting for federation attachment bytes."),
      );
    }, FEDERATION_BLOB_WAIT_TIMEOUT_MS);
    transfer.timeout.unref?.();
  }

  private failTransfer(
    key: string,
    transfer: IncomingTransfer,
    error: Error,
  ): void {
    if (transfer.settled) {
      return;
    }
    transfer.settled = true;
    clearTimeout(transfer.timeout);
    this.releaseBufferedChunks(transfer);
    transfer.reject(error);
    if (this.transfers.get(key) === transfer) {
      this.transfers.delete(key);
    }
  }

  private releaseBufferedChunks(transfer: IncomingTransfer): void {
    this.bufferedBytes = Math.max(
      0,
      this.bufferedBytes - transfer.receivedBytes,
    );
    transfer.receivedBytes = 0;
    transfer.chunks.clear();
  }

  private async persistCompletedTransfer(
    sourceInstanceId: FederationInstanceId,
    metadata: IncomingTransferMetadata,
    chunks: ReadonlyMap<number, Buffer>,
  ): Promise<StagedTurnInputAttachment> {
    const ordered = Array.from(
      { length: metadata.chunkCount },
      (_, index) => chunks.get(index),
    );
    if (ordered.some((chunk) => !chunk)) {
      throw new Error("Federation blob is missing one or more chunks.");
    }
    const data = Buffer.concat(ordered as Buffer[]);
    if (data.byteLength !== metadata.totalSize) {
      throw new Error("Federation blob size does not match its metadata.");
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== metadata.sha256) {
      throw new Error("Federation blob failed its SHA-256 integrity check.");
    }

    const root = this.options.resolveRoot?.()
      ?? resolveActiveProfilePath(path.join("state", "federation-turn-inputs"));
    const filePath = path.join(
      root,
      sanitizeTurnAttachmentName(sourceInstanceId, "peer"),
      digest,
      sanitizeTurnAttachmentName(metadata.name),
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    const persistedAt = new Date();
    await utimes(path.dirname(filePath), persistedAt, persistedAt);
    const existing = await stat(filePath).catch(() => undefined);
    let reusable = false;
    if (existing?.isFile() && existing.size === metadata.totalSize) {
      const existingData = await readFile(filePath).catch(() => undefined);
      reusable = Boolean(
        existingData
        && createHash("sha256").update(existingData).digest("hex") === digest,
      );
    }
    if (!reusable) {
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, data);
        await rename(temporaryPath, filePath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    } else {
      await Promise.all([
        utimes(filePath, persistedAt, persistedAt),
        utimes(path.dirname(filePath), persistedAt, persistedAt),
      ]);
    }

    void cleanupOldFederationTurnInputs(root, new Set([filePath])).catch(
      () => undefined,
    );

    return metadata.inputType === "localImage"
      ? { type: "localImage", name: metadata.name, path: filePath }
      : {
          type: "localFile",
          name: metadata.name,
          path: filePath,
          ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
          sizeBytes: metadata.totalSize,
        };
  }
}

async function cleanupOldFederationTurnInputs(
  root: string,
  excludedFiles: ReadonlySet<string>,
): Promise<void> {
  const cutoff = Date.now() - FEDERATION_TURN_INPUT_MAX_AGE_MS;
  const peerEntries = await readdir(root).catch(() => []);
  await Promise.all(
    peerEntries.map(async (peerEntry) => {
      const peerPath = path.join(root, peerEntry);
      const digestEntries = await readdir(peerPath).catch(() => []);
      await Promise.all(
        digestEntries.map(async (digestEntry) => {
          const digestPath = path.join(peerPath, digestEntry);
          const children = await readdir(digestPath).catch(() => []);
          if (
            children.some((child) =>
              excludedFiles.has(path.join(digestPath, child))
            )
          ) {
            return;
          }
          const info = await stat(digestPath).catch(() => undefined);
          if (info?.isDirectory() && info.mtimeMs < cutoff) {
            await rm(digestPath, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
        }),
      );
    }),
  );
}

function assertSafeFederationInlineInput(item: AppServerTurnInputItem): void {
  if (
    item.type === "localImage"
    || item.type === "localFile"
    || item.type === "file"
    || (
      item.type === "image"
      && (item.url.startsWith("data:") || item.url.startsWith("file:"))
    )
  ) {
    throw new Error(
      "Federation turn attachments must use a verified blob transfer reference.",
    );
  }
}

export function isFederationTurnInputBlobReference(
  value: FederationWireTurnInputItem,
): value is FederationTurnInputBlobReference {
  return value.type === "federationBlob"
    && typeof value.transferId === "string"
    && value.transferId.length > 0
    && value.transferId.length <= 120;
}

function validateBlobChunk(envelope: FederationBlobChunkEnvelope): void {
  if (
    !envelope.transferId
    || envelope.transferId.length > 120
    || !Number.isSafeInteger(envelope.chunkIndex)
    || envelope.chunkIndex < 0
    || !Number.isSafeInteger(envelope.chunkCount)
    || envelope.chunkCount < 1
    || envelope.chunkIndex >= envelope.chunkCount
    || !Number.isSafeInteger(envelope.totalSize)
    || envelope.totalSize < 0
    || envelope.totalSize > MAX_TURN_INPUT_ATTACHMENT_BYTES
    || !/^[a-f0-9]{64}$/u.test(envelope.sha256)
    || !envelope.name
    || envelope.name.length > 200
    || !(envelope.data instanceof Uint8Array)
    || envelope.data.byteLength > FEDERATION_BLOB_CHUNK_BYTES
    || (envelope.inputType !== "localFile" && envelope.inputType !== "localImage")
  ) {
    throw new Error("Invalid federation blob chunk.");
  }
  const expectedChunkCount = Math.max(
    1,
    Math.ceil(envelope.totalSize / FEDERATION_BLOB_CHUNK_BYTES),
  );
  const expectedChunkSize = envelope.chunkIndex < expectedChunkCount - 1
    ? FEDERATION_BLOB_CHUNK_BYTES
    : envelope.totalSize
      - (expectedChunkCount - 1) * FEDERATION_BLOB_CHUNK_BYTES;
  if (
    envelope.chunkCount !== expectedChunkCount
    || envelope.data.byteLength !== expectedChunkSize
  ) {
    throw new Error("Invalid federation blob chunk geometry.");
  }
}

function metadataFromEnvelope(
  envelope: FederationBlobChunkEnvelope,
): IncomingTransferMetadata {
  return {
    transferId: envelope.transferId,
    chunkCount: envelope.chunkCount,
    totalSize: envelope.totalSize,
    sha256: envelope.sha256,
    name: envelope.name,
    ...(envelope.mimeType ? { mimeType: envelope.mimeType } : {}),
    inputType: envelope.inputType,
  };
}

function sameMetadata(
  left: IncomingTransferMetadata,
  right: IncomingTransferMetadata,
): boolean {
  return left.transferId === right.transferId
    && left.chunkCount === right.chunkCount
    && left.totalSize === right.totalSize
    && left.sha256 === right.sha256
    && left.name === right.name
    && left.mimeType === right.mimeType
    && left.inputType === right.inputType;
}

function transferKey(
  sourceInstanceId: FederationInstanceId,
  transferId: string,
): string {
  return `${sourceInstanceId}\u0000${transferId}`;
}
