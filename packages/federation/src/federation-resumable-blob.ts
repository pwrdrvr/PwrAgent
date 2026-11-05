import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FederationBlobChunkEnvelope } from "@pwragent/shared";
import type { FilePushResult } from "./federation-file-push";

export const BLOB_CHUNK_BYTES = 256 * 1024;
export const BLOB_WINDOW_CHUNKS = 4;
/** Every acknowledged window has a durable resume boundary, including small files. */
export const BLOB_COMMIT_BYTES = BLOB_CHUNK_BYTES * BLOB_WINDOW_CHUNKS;
export const BLOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024 * 1024;

export type BlobIdentity = { sha256: string; sizeBytes: number; senderToken?: string };

type Sidecar = {
  peerId: string;
  senderToken?: string;
  sha256: string;
  sizeBytes: number;
  name: string;
  committedOffset: number;
  updatedAt: number;
  result?: FilePushResult;
};
type Transfer = {
  state: Sidecar;
  folder: string;
  file: FileHandle;
  receivedOffset: number;
  failure?: unknown;
};

export async function hashBlobFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filePath)) hash.update(bytes);
  return hash.digest("hex");
}

function contentKey(peerId: string, sha256: unknown, sizeBytes: unknown): string {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
    || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 0 || sizeBytes > MAX_BYTES) throw new Error("Invalid blob identity.");
  return createHash("sha256").update(JSON.stringify([peerId, sha256, sizeBytes])).digest("hex");
}

/** Called through the file receiver's ordered queue. Only a sidecar offset
 * acknowledged after fsync is a resume boundary; speculative tail bytes go. */
export class FederationResumableBlobReceiver {
  private readonly transfers = new Map<string, Transfer>();
  private readonly roots = new Set<string>();
  private expiry?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    directory: () => string;
    onCompleted?: (peerId: string, file: FilePushResult) => void;
    now?: () => number;
    schedule?: (work: () => Promise<void>) => void;
  }) {}

  async initialize(): Promise<void> {
    const directory = this.options.directory();
    if (!path.isAbsolute(directory)) return;
    const root = path.join(directory, ".pwragent-resumable");
    this.roots.add(root);
    this.startExpiry();
    await this.expire(root);
  }

  private startExpiry(): void {
    this.expiry ??= setInterval(() => {
      // Maintenance joins the same queue as writes and cancellation.
      this.options.schedule?.(async () => {
        for (const folder of this.roots) await this.expire(folder);
      });
    }, 60_000);
    this.expiry.unref();
  }

  async begin(peerId: string, args: BlobIdentity & { name: string }): Promise<{
    transferId: string; committedOffset: number;
  }> {
    const key = contentKey(peerId, args.sha256, args.sizeBytes);
    if (args.senderToken !== undefined && (typeof args.senderToken !== "string" || !/^[a-f0-9-]{36}$/.test(args.senderToken))) {
      throw new Error("Invalid blob send owner.");
    }
    const directory = this.options.directory();
    if (!path.isAbsolute(directory)) throw new Error("Incoming files folder must be absolute.");
    const root = path.join(directory, ".pwragent-resumable");
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.roots.add(root);
    await this.expire(root);
    this.startExpiry();
    const folder = path.join(root, key);
    if (this.transfers.size >= 4 && ![...this.transfers.values()].some((transfer) => transfer.folder === folder)) {
      throw new Error("Incoming blob transfer limit reached.");
    }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let state: Sidecar;
    try {
      state = JSON.parse(await readFile(path.join(folder, "offset.json"), "utf8"));
      if (state.peerId !== peerId || state.sha256 !== args.sha256 || state.sizeBytes !== args.sizeBytes
        || !Number.isSafeInteger(state.committedOffset)
        || state.committedOffset < 0 || state.committedOffset > args.sizeBytes
        || (state.committedOffset !== args.sizeBytes && state.committedOffset % BLOB_COMMIT_BYTES !== 0)) {
        throw new Error("Invalid blob sidecar.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { peerId, sha256: args.sha256, sizeBytes: args.sizeBytes, name: args.name,
        senderToken: args.senderToken, committedOffset: 0, updatedAt: this.now() };
    }
    if (state.senderToken !== args.senderToken && !state.result) {
      throw new Error("This blob belongs to another send. Cancel that send or wait for its expiry.");
    }
    state.senderToken = args.senderToken;
    for (const [id, transfer] of this.transfers) {
      if (transfer.folder === folder) {
        await transfer.file.close();
        this.transfers.delete(id);
      }
    }
    const filePath = path.join(folder, "data.part");
    const file = await open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if ((await file.stat()).size < state.committedOffset) throw new Error("Committed blob bytes are missing.");
      await file.truncate(state.committedOffset);
      const transfer: Transfer = { state, folder, file, receivedOffset: state.committedOffset };
      await this.persist(transfer);
      const transferId = `blob:${randomUUID()}`;
      this.transfers.set(transferId, transfer);
      return { transferId, committedOffset: state.committedOffset };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async chunk(peerId: string, envelope: FederationBlobChunkEnvelope): Promise<void> {
    const transfer = this.get(peerId, envelope.transferId);
    try {
      const { state } = transfer;
      const offset = envelope.chunkIndex * BLOB_CHUNK_BYTES;
      const expected = Math.min(BLOB_CHUNK_BYTES, state.sizeBytes - offset);
      if (state.result || envelope.purpose !== "file_push" || !Number.isSafeInteger(envelope.chunkIndex)
        || offset !== transfer.receivedOffset || expected <= 0 || envelope.data.byteLength !== expected
        || envelope.totalSize !== state.sizeBytes || envelope.sha256 !== state.sha256
        || envelope.chunkCount !== Math.ceil(state.sizeBytes / BLOB_CHUNK_BYTES)) {
        throw new Error("Invalid binary blob offset, identity, or size.");
      }
      let written = 0;
      while (written < envelope.data.byteLength) {
        const result = await transfer.file.write(envelope.data, written, envelope.data.byteLength - written, offset + written);
        if (!result.bytesWritten) throw new Error("Unable to append incoming blob.");
        written += result.bytesWritten;
      }
      transfer.receivedOffset += written;
      state.updatedAt = this.now();
      if (transfer.receivedOffset - state.committedOffset >= BLOB_COMMIT_BYTES
        || transfer.receivedOffset === state.sizeBytes) await this.commit(transfer);
    } catch (error) {
      // blob_chunk has no individual reply. The following barrier surfaces it.
      transfer.failure = error;
      throw error;
    }
  }

  checkpoint(peerId: string, id: string): { receivedOffset: number; committedOffset: number } {
    const transfer = this.get(peerId, id);
    return { receivedOffset: transfer.receivedOffset, committedOffset: transfer.state.committedOffset };
  }

  async finish(peerId: string, id: string): Promise<FilePushResult> {
    const transfer = this.get(peerId, id);
    const { state } = transfer;
    if (state.result && !(await stat(state.result.path).catch(() => undefined))?.isFile()) state.result = undefined;
    if (!state.result) {
      if (transfer.receivedOffset !== state.sizeBytes) throw new Error("Incomplete blob.");
      await this.commit(transfer);
      const source = path.join(transfer.folder, "data.part");
      if (await hashBlobFile(source) !== state.sha256) throw new Error("Blob SHA-256 mismatch.");
      // Deterministic, peer-scoped publication makes finish safe to repeat after
      // losing its reply, even across a receiver restart. Never overwrite a file.
      const key = path.basename(transfer.folder);
      const extension = path.extname(state.name);
      const destination = path.join(path.dirname(path.dirname(transfer.folder)),
        `${state.name.slice(0, state.name.length - extension.length)} (${key.slice(0, 16)})${extension}`);
      try {
        try {
          await link(source, destination);
        } catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await copyFile(source, destination, constants.COPYFILE_EXCL);
          const target = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await target.sync(); } finally { await target.close(); }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await stat(destination)).size !== state.sizeBytes || await hashBlobFile(destination) !== state.sha256) {
          throw new Error("Blob publication path already contains different bytes.");
        }
      }
      await syncDirectory(path.dirname(destination));
      state.result = { path: destination, sizeBytes: state.sizeBytes, sha256: state.sha256 };
      await this.persist(transfer);
    }
    this.options.onCompleted?.(peerId, state.result);
    await transfer.file.close();
    this.transfers.delete(id);
    return state.result;
  }

  async cancel(peerId: string, args: BlobIdentity): Promise<void> {
    const key = contentKey(peerId, args.sha256, args.sizeBytes);
    const folder = path.join(this.options.directory(), ".pwragent-resumable", key);
    const state = await readFile(path.join(folder, "offset.json"), "utf8").then((value) => JSON.parse(value) as Sidecar).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // A cancellation held offline must not erase a newer send of the same
    // content when the link returns. Its logical owner survives reconnects.
    if (state && state.senderToken !== args.senderToken) return;
    for (const [id, transfer] of this.transfers) {
      if (transfer.folder === folder) {
        await transfer.file.close();
        this.transfers.delete(id);
      }
    }
    await rm(folder, { force: true, recursive: true });
  }

  async disconnect(peerId: string): Promise<void> {
    await this.closeTransfers([...this.transfers].filter(([, transfer]) => transfer.state.peerId === peerId));
  }

  async dispose(): Promise<void> {
    clearInterval(this.expiry);
    await this.closeTransfers([...this.transfers]);
  }

  private async closeTransfers(entries: [string, Transfer][]): Promise<void> {
    const results = await Promise.allSettled(entries.map(async ([id, transfer]) => {
      try { await this.persist(transfer); } finally {
        try { await transfer.file.close(); } finally { this.transfers.delete(id); }
      }
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Unable to suspend incoming blobs.");
  }

  private get(peerId: string, id: string): Transfer {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.state.peerId !== peerId) throw new Error("Blob transfer does not belong to this peer.");
    if (transfer.failure) throw transfer.failure;
    return transfer;
  }

  private async commit(transfer: Transfer): Promise<void> {
    await transfer.file.sync();
    transfer.state.committedOffset = transfer.receivedOffset;
    await this.persist(transfer);
  }

  private async persist(transfer: Transfer): Promise<void> {
    transfer.state.updatedAt = this.now();
    const temporary = path.join(transfer.folder, "offset.tmp");
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(transfer.state));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path.join(transfer.folder, "offset.json"));
    await syncDirectory(transfer.folder);
    await syncDirectory(path.dirname(transfer.folder));
  }

  private async expire(root: string): Promise<void> {
    const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      const folder = path.join(root, entry);
      const active = [...this.transfers.entries()].filter(([, transfer]) => transfer.folder === folder);
      if (active.some(([, transfer]) => transfer.state.updatedAt >= this.now() - BLOB_RETENTION_MS)) continue;
      const metadata = await readFile(path.join(folder, "offset.json"), "utf8")
        .then((value) => JSON.parse(value) as Sidecar).catch(() => undefined);
      const updatedAt = metadata && Number.isFinite(metadata.updatedAt) ? metadata.updatedAt : (await stat(folder)).mtimeMs;
      if (updatedAt >= this.now() - BLOB_RETENTION_MS) continue;
      for (const [id, transfer] of active) {
        await transfer.file.close();
        this.transfers.delete(id);
      }
      await rm(folder, { recursive: true, force: true });
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  // Windows does not permit fsync on directory handles.
  if (process.platform === "win32") return;
  const directory = await open(directoryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
