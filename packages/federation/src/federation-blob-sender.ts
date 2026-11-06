import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { FEDERATION_PROTOCOL_VERSION, type FederationBlobChunkEnvelope } from "@pwragent/shared";
import type { FederationRpcEndpoint } from "./federation-rpc";
import type { FilePushResult, PushFederationFileOptions } from "./federation-file-push";
import { BLOB_CHUNK_BYTES, BLOB_COMMIT_BYTES, BLOB_WINDOW_CHUNKS, hashBlobFile, type BlobIdentity } from "./federation-resumable-blob";

export type BlobConnection = {
  rpc: Pick<FederationRpcEndpoint, "request">;
  send: (envelope: FederationBlobChunkEnvelope) => Promise<void>;
  /** Monotonic connection generation, not current connected status. */
  didDisconnect: () => boolean;
};

export type ResumableBlobTransport = {
  localInstanceId: string;
  targetInstanceId: string;
  connection: () => BlobConnection;
  isConnected?: () => boolean;
  waitForReconnect: (signal?: AbortSignal) => Promise<void>;
  cancel: (identity: BlobIdentity) => void;
};

/** Four chunks followed by an ordered barrier bound both endpoints' work.
 * RPCs have no deadline: only a dropped connection permits another begin. */
export async function pushResumableBlob(
  transport: ResumableBlobTransport,
  sourcePath: string,
  name: string | undefined,
  options: PushFederationFileOptions = {},
): Promise<FilePushResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!path.isAbsolute(sourcePath)) throw new Error("Blob source must be absolute.");
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
  let identity: BlobIdentity | undefined;
  let completed = false;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new Error("Select a regular file of at most 512 MiB.");
    identity = { sha256: await hashBlobFile(sourcePath), sizeBytes: before.size, senderToken: randomUUID() };
    let committed = 0;
    let sent = 0;
    let resumedFromBytes: number | undefined;
    let disconnectedAt: string | undefined;
    const progress = (link: "waiting" | "connected"): void => {
      options.onProgress?.(sent, before.size);
      options.onTransferProgress?.({ bytesCommitted: committed, bytesSent: sent, bytesTotal: before.size,
        ...(resumedFromBytes === undefined ? {} : { resumedFromBytes }),
        ...(link === "waiting" ? { disconnectedAt } : {}), link, transport: "resumable" });
    };
    while (true) {
      signal?.throwIfAborted();
      if (transport.isConnected?.() === false) {
        disconnectedAt = new Date().toISOString();
        sent = committed;
        progress("waiting");
        await transport.waitForReconnect(signal);
      }
      const connection = transport.connection();
      try {
        const begin = await connection.rpc.request<{ transferId: string; committedOffset: number }>({
          method: "file.push.begin", params: { ...identity, name: name ?? path.basename(sourcePath), binary: true }, timeoutMs: null, signal,
        });
        if (!begin.transferId.startsWith("blob:") || !Number.isSafeInteger(begin.committedOffset)
          || begin.committedOffset < committed || begin.committedOffset > before.size
          || (begin.committedOffset !== before.size && begin.committedOffset % BLOB_COMMIT_BYTES !== 0)) {
          throw new Error("Invalid receiver committed offset.");
        }
        if (begin.committedOffset > 0) resumedFromBytes ??= begin.committedOffset;
        committed = begin.committedOffset;
        sent = committed;
        progress("connected");
        disconnectedAt = undefined;
        let offset = committed;
        while (offset < before.size) {
          for (let i = 0; i < BLOB_WINDOW_CHUNKS && offset < before.size; i++) {
            signal?.throwIfAborted();
            const chunk = Buffer.alloc(Math.min(BLOB_CHUNK_BYTES, before.size - offset));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
            if (bytesRead !== chunk.length) throw new Error("Blob source changed while sending.");
            await abortableBlobSend(connection.send({
              id: `blob:${begin.transferId}:${offset}`, kind: "blob_chunk", purpose: "file_push",
              protocolVersion: FEDERATION_PROTOCOL_VERSION, sourceInstanceId: transport.localInstanceId,
              targetInstanceId: transport.targetInstanceId, createdAt: Date.now(),
              transferId: begin.transferId, chunkIndex: offset / BLOB_CHUNK_BYTES,
              chunkCount: Math.ceil(before.size / BLOB_CHUNK_BYTES), totalSize: before.size,
              sha256: identity.sha256, name: name ?? path.basename(sourcePath), inputType: "localFile", data: chunk,
            }), signal);
            offset += chunk.length;
          }
          const ack = await connection.rpc.request<{ receivedOffset: number; committedOffset: number }>({
            method: "file.push.checkpoint", params: { transferId: begin.transferId }, timeoutMs: null, signal,
          });
          if (ack.receivedOffset !== offset || !Number.isSafeInteger(ack.committedOffset)
            || ack.committedOffset < committed || ack.committedOffset > offset
            || (ack.committedOffset !== before.size && ack.committedOffset % BLOB_COMMIT_BYTES !== 0)) {
            throw new Error("Invalid blob acknowledgement.");
          }
          committed = ack.committedOffset;
          sent = ack.receivedOffset;
          progress("connected");
        }
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error("Blob source changed while sending.");
        }
        const result = await connection.rpc.request<FilePushResult>({
          method: "file.push.finish", params: { transferId: begin.transferId }, timeoutMs: null, signal,
        });
        if (result.sha256 !== identity.sha256 || result.sizeBytes !== before.size) throw new Error("Invalid blob receipt.");
        completed = true;
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (!connection.didDisconnect()) throw error;
        disconnectedAt ??= new Date().toISOString();
        sent = committed;
        progress("waiting");
        await transport.waitForReconnect(signal);
      }
    }
  } finally {
    await file.close();
    if (!completed && identity) transport.cancel(identity);
  }
}

// Cancellation need not wait for a slow socket to drain. A queued old session's
// frame may still leave the socket; cancel/new begin fences its transfer ID.
async function abortableBlobSend(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return await work;
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(() => { signal.removeEventListener("abort", abort); resolve(); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
