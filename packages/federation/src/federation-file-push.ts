import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FederationCapability } from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";
import { receivingFolderError } from "./receiving-folder-error";

export const FILE_PUSH_CHUNK_BYTES = 256 * 1024;
export const FILE_PUSH_MAX_BYTES = 512 * 1024 * 1024;
const MAX_TRANSFERS = 4;
const IDLE_MS = 60_000;
export const FILE_PUSH_METHODS = {
  begin: "file.push.begin",
  chunk: "file.push.chunk",
  finish: "file.push.finish",
  cancel: "file.push.cancel",
} as const;
export const FILE_PUSH_METHOD_CAPABILITIES: Record<string, FederationCapability> =
  Object.fromEntries(Object.values(FILE_PUSH_METHODS).map((method) => [method, "file_push"]));

export type FilePushResult = { path: string; sizeBytes: number; sha256: string };
type Transfer = {
  peerId: string;
  name: string;
  size: number;
  received: number;
  directory: string;
  staging: string;
  file: FileHandle;
  hash: ReturnType<typeof createHash>;
  timer: ReturnType<typeof setTimeout>;
};

function filename(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 180
    || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(value) || /^[. ]|[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) {
    throw new Error("Use a plain filename without paths, control characters, or reserved names.");
  }
  return value;
}

/** Receiver-owned paths and end-to-end peer ownership, including gateway relays.
 * Requests are bounded and serialized so concurrent chunks/finish/cancel cannot
 * race a write or publish a partially validated file. No per-chunk persistence. */
export class FederationFilePushReceiver {
  private readonly transfers = new Map<string, Transfer>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private disposed = false;

  constructor(private readonly options: {
    allowed: () => boolean;
    directory: () => string;
    onCompleted?: (peerId: string, result: FilePushResult) => void;
    formatError?: typeof receivingFolderError;
  }) {}

  private receivingError(error: unknown, directory: string, operation: string): Error {
    return (this.options.formatError ?? receivingFolderError)(error, directory, operation);
  }

  handle(peerId: string, method: string, input: unknown): Promise<unknown> {
    if (this.disposed || this.pending >= 32) {
      return Promise.reject(new Error("File receiver is unavailable or busy."));
    }
    this.pending++;
    const work = this.tail.then(() => this.receive(peerId, method, input));
    this.tail = work.catch(() => undefined);
    return work.finally(() => { this.pending--; });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.tail;
    await Promise.all([...this.transfers.keys()].map((id) => this.remove(id)));
  }

  private async receive(peerId: string, method: string, input: unknown): Promise<unknown> {
    if (this.disposed) throw new Error("File receiver is shutting down.");
    const args = input as Record<string, unknown> | null;
    if (!args || typeof args !== "object") throw new Error("Invalid file transfer request.");
    if (!this.options.allowed() && method !== FILE_PUSH_METHODS.cancel) {
      throw new Error("This machine does not allow incoming files.");
    }
    if (method === FILE_PUSH_METHODS.begin) {
      const name = filename(args.name);
      const size = args.sizeBytes;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > FILE_PUSH_MAX_BYTES) {
        throw new Error("Files must be at most 512 MiB.");
      }
      if (this.transfers.size >= MAX_TRANSFERS) throw new Error("Incoming file transfer limit reached.");
      const configured = this.options.directory();
      if (!path.isAbsolute(configured)) throw new Error("Incoming files folder must be an absolute path.");
      let directory: string;
      let staging: string;
      try {
        await fs.mkdir(configured, { recursive: true });
        directory = await fs.realpath(configured);
        staging = await fs.mkdtemp(path.join(directory, ".pwragent-transfer-"));
      } catch (error) {
        throw this.receivingError(error, configured, "stage a file");
      }
      try {
        const file = await fs.open(path.join(staging, "data"), "wx", 0o600);
        const id = randomUUID();
        const timer = this.expiry(id);
        this.transfers.set(id, { peerId, name, size, received: 0, directory, staging, file, hash: createHash("sha256"), timer });
        return { transferId: id, chunkBytes: FILE_PUSH_CHUNK_BYTES };
      } catch (error) {
        try {
          await fs.rm(staging, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new Error(`${this.receivingError(error, directory, "stage a file").message} Transfer staging could not be removed: "${staging}" (${(cleanupError as NodeJS.ErrnoException).code ?? "unknown error"}).`, { cause: error });
        }
        throw this.receivingError(error, directory, "stage a file");
      }
    }
    const id = typeof args.transferId === "string" ? args.transferId : "";
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.peerId !== peerId) throw new Error("File transfer not found for this peer.");
    clearTimeout(transfer.timer);
    transfer.timer = this.expiry(id);
    try {
      if (method === FILE_PUSH_METHODS.cancel) {
        await this.remove(id);
        return { cancelled: true };
      }
      if (method === FILE_PUSH_METHODS.chunk) {
        if (args.offset !== transfer.received || typeof args.dataBase64 !== "string"
          || args.dataBase64.length > Math.ceil(FILE_PUSH_CHUNK_BYTES / 3) * 4) {
          throw new Error("Invalid file chunk size or offset.");
        }
        const bytes = Buffer.from(args.dataBase64, "base64");
        if (!bytes.length || bytes.length > FILE_PUSH_CHUNK_BYTES
          || bytes.toString("base64") !== args.dataBase64
          || transfer.received + bytes.length > transfer.size) {
          throw new Error("Invalid file chunk content.");
        }
        let written = 0;
        while (written < bytes.length) {
          const result = await transfer.file.write(bytes, written, bytes.length - written);
          if (!result.bytesWritten) throw new Error("Unable to write incoming file.");
          written += result.bytesWritten;
        }
        transfer.hash.update(bytes);
        transfer.received += bytes.length;
        return { receivedBytes: transfer.received };
      }
      if (method !== FILE_PUSH_METHODS.finish) throw new Error("Unknown file transfer method.");
      const sha256 = transfer.hash.digest("hex");
      if (transfer.received !== transfer.size || args.sha256 !== sha256) {
        throw new Error("Incoming file size or checksum did not match.");
      }
      await transfer.file.sync();
      await transfer.file.close();
      if (this.disposed || !this.options.allowed()) throw new Error("Incoming files are disabled.");
      // Prefer atomic publication. Some privacy policies/filesystems allow
      // writes but deny hard links; copy only verified bytes with EXCL there.
      // The fallback may be visible while copying, but never replaces a path
      // (including symlinks). Node attempts to remove its new destination on
      // copy failure; if the OS blocks that too, report the remaining path.
      const extension = path.extname(transfer.name);
      const stem = transfer.name.slice(0, transfer.name.length - extension.length);
      for (let suffix = 0; suffix < 1000; suffix++) {
        const name = suffix ? `${stem} (${suffix})${extension}` : transfer.name;
        const destination = path.join(transfer.directory, name);
        try {
          const source = path.join(transfer.staging, "data");
          try {
            await fs.link(source, destination);
          } catch (error) {
            if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            try {
              await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
            } catch (copyError) {
              if ((copyError as NodeJS.ErrnoException).code === "EEXIST") throw copyError;
              const diagnostic = this.receivingError(copyError, transfer.directory, "finalize a file");
              const remaining = await fs.lstat(destination).then(() => true, () => false);
              const partial = remaining ? ` A file remains at "${destination}" and may be an incomplete copy. Review it before retrying; it will not be overwritten.` : "";
              throw new Error(`${diagnostic.message} Hard-link finalization also failed (${(error as NodeJS.ErrnoException).code}).${partial}`, { cause: copyError });
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw this.receivingError(error, transfer.directory, "finalize a file");
        }
        try {
          await this.remove(id);
        } catch (error) {
          throw new Error(`Incoming file was saved to "${destination}", but staging cleanup failed for "${transfer.staging}": ${this.receivingError(error, transfer.directory, "remove transfer staging").message}`, { cause: error });
        }
        const result = { path: destination, sizeBytes: transfer.size, sha256 } satisfies FilePushResult;
        this.options.onCompleted?.(peerId, result);
        return result;
      }
      throw new Error("Too many files with this name in the incoming folder.");
    } catch (error) {
      try {
        await this.remove(id);
      } catch (cleanupError) {
        throw new Error(`${this.receivingError(error, transfer.directory, "receive a file").message} Transfer staging could not be removed: "${transfer.staging}" (${(cleanupError as NodeJS.ErrnoException).code ?? "unknown error"}).`, { cause: error });
      }
      throw this.receivingError(error, transfer.directory, "receive a file");
    }
  }

  private expiry(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.tail = this.tail.then(async () => {
        if (this.transfers.get(id)?.timer === timer) await this.remove(id);
      }).catch(() => undefined);
    }, IDLE_MS);
    timer.unref();
    return timer;
  }

  private async remove(id: string): Promise<void> {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    this.transfers.delete(id);
    clearTimeout(transfer.timer);
    await transfer.file.close().catch(() => undefined);
    await fs.rm(transfer.staging, { recursive: true, force: true });
  }
}

export function registerFilePushHandlers(router: FederationRouter, receiver: FederationFilePushReceiver): void {
  for (const method of Object.values(FILE_PUSH_METHODS)) {
    router.registerHandler(method, (envelope) => receiver.handle(envelope.sourceInstanceId, method, envelope.params));
  }
}

/** One acknowledged chunk at a time bounds memory and socket pressure on both
 * direct and gateway-relayed routes. A failed transfer is explicitly cancelled;
 * lost connections fall back to the receiver's idle expiry. */
export type PushFederationFileOptions = {
  /** Aborting sends `file.push.cancel` and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after each acknowledged chunk with bytes the receiver holds. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
};

export async function pushFederationFile(
  rpc: Pick<FederationRpcEndpoint, "request">,
  sourcePath: string | Uint8Array,
  name?: string,
  options: PushFederationFileOptions = {},
): Promise<FilePushResult> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const bytes = typeof sourcePath === "string" ? undefined
    : Buffer.from(sourcePath.buffer, sourcePath.byteOffset, sourcePath.byteLength);
  if (typeof sourcePath === "string" && !path.isAbsolute(sourcePath)) throw new Error("The source file path must be absolute.");
  const file = typeof sourcePath === "string" ? await fs.open(sourcePath, "r") : undefined;
  let transferId: string | undefined;
  try {
    const stat = file ? await file.stat() : { size: bytes!.byteLength, mtimeMs: 0, isFile: () => true };
    if (!stat.isFile() || stat.size > FILE_PUSH_MAX_BYTES) throw new Error("Select a regular file of at most 512 MiB.");
    const begin = await rpc.request<{ transferId: string }>({ method: FILE_PUSH_METHODS.begin, params: { name: filename(name ?? (typeof sourcePath === "string" ? path.basename(sourcePath) : "file")), sizeBytes: stat.size } });
    transferId = begin.transferId;
    onProgress?.(0, stat.size);
    const hash = createHash("sha256");
    const buffer = bytes ? undefined : Buffer.alloc(FILE_PUSH_CHUNK_BYTES);
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = bytes ? Math.min(FILE_PUSH_CHUNK_BYTES, stat.size - offset)
        : (await file!.read(buffer!, 0, Math.min(buffer!.length, stat.size - offset), offset)).bytesRead;
      if (!bytesRead) throw new Error("Source file changed during transfer.");
      const chunk = bytes ? bytes.subarray(offset, offset + bytesRead) : buffer!.subarray(0, bytesRead);
      hash.update(chunk);
      await rpc.request({ method: FILE_PUSH_METHODS.chunk, params: { transferId, offset, dataBase64: chunk.toString("base64") } });
      offset += bytesRead;
      onProgress?.(offset, stat.size);
      signal?.throwIfAborted();
    }
    const after = file ? await file.stat() : stat;
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Source file changed during transfer.");
    signal?.throwIfAborted();
    // Finalization can copy the whole file on volumes that deny hard links.
    // Wait for the result or peer disconnect rather than timing out mid-copy.
    return await rpc.request<FilePushResult>({ method: FILE_PUSH_METHODS.finish, params: { transferId, sha256: hash.digest("hex") }, timeoutMs: null });
  } catch (error) {
    if (transferId) {
      await rpc.request({ method: FILE_PUSH_METHODS.cancel, params: { transferId }, timeoutMs: 5_000 }).catch(() => undefined);
    }
    throw error;
  } finally {
    await file?.close();
  }
}

/** Single-use receipts exist only in the receiver process that acknowledged the
 * authenticated source. A path, hash, or a receipt from another peer is never
 * enough authority to load provider-owner files. Restart drops this authority. */
export class FederationFilePushReceipts {
  private readonly receipts = new Map<string, { peerId: string; file: FilePushResult; expires: number }>();

  record(peerId: string, file: FilePushResult): void {
    if (this.receipts.size >= 128) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(file.path, { peerId, file: { ...file }, expires: Date.now() + 5 * 60_000 });
  }

  clear(): void { this.receipts.clear(); }

  async consume(peerId: string, input: FilePushResult, maxBytes: number): Promise<Uint8Array> {
    const receipt = input && this.receipts.get(input.path);
    if (!receipt || receipt.peerId !== peerId || receipt.expires < Date.now()
      || receipt.file.sizeBytes !== input.sizeBytes || receipt.file.sha256 !== input.sha256) {
      throw new Error("No acknowledged file receipt belongs to this authenticated source.");
    }
    // Claim before awaiting disk I/O; overlapping requests cannot deliver twice.
    this.receipts.delete(input.path);
    if (input.sizeBytes <= 0 || input.sizeBytes > maxBytes) throw new Error("The received file exceeds the messaging upload limit.");
    const handle = await fs.open(receipt.file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== input.sizeBytes) throw new Error("The received file changed after acknowledgement.");
      const bytes = Buffer.alloc(input.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
        throw new Error("The received file changed after acknowledgement.");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
