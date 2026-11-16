import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PwrAgentMessagingAttachmentSummary, PwrAgentMessagingResponse } from "@pwragent/shared";

export const ORIGINAL_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ORIGINAL_ATTACHMENT_CACHE_LIMITS = { maxRecords: 256, maxOriginalBytes: 256 * 1024 * 1024 };
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{64}$/u;

export type OriginalAttachmentScope = { backend: string; threadId: string; provider?: string; instanceId?: string };
export type OriginalAttachmentInput = { data: Uint8Array; name: string; mimeType?: string };
export type VerifiedOriginalAttachment = { attachment: PwrAgentMessagingAttachmentSummary; data: Uint8Array };
export type OriginalAttachmentConsumer = (
  original: VerifiedOriginalAttachment, reauthorize: () => Promise<boolean>,
) => Promise<PwrAgentMessagingResponse>;
type RecordMetadata = PwrAgentMessagingAttachmentSummary & { scopeKey: string; actorKey: string };

export class OriginalAttachmentError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "invalid_arguments", message: string) {
    super(message);
  }
}

/** PwrAgent-owned files, independent of provider transcripts and preview caches.
 * Only IDs and authenticated host scope select records; no caller supplies a
 * source path. A single store serializes intake/eviction/export in this owner.
 */
export class MessagingOriginalAttachmentStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly limits = ORIGINAL_ATTACHMENT_CACHE_LIMITS,
  ) {}

  static actorKey(channel: unknown, actorId: string): string {
    return digest(JSON.stringify([channel, actorId]));
  }

  async retain(params: OriginalAttachmentInput & {
    scope: OriginalAttachmentScope; actorKey: string; eventId: string; attachmentKey: string; receivedAt?: number;
  }): Promise<PwrAgentMessagingAttachmentSummary> {
    return this.serial(async () => {
      if (params.data.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new OriginalAttachmentError("invalid_arguments", "Original exceeds the 10 MiB received-file limit. Send a smaller file.");
      }
      await this.ensureRoot();
      const records = await this.records();
      const scopeKey = scopeDigest(params.scope);
      const attachmentId = digest(JSON.stringify([scopeKey, params.actorKey, params.eventId, params.attachmentKey]));
      const existing = records.find((record) => record.attachmentId === attachmentId);
      if (existing) return summary(existing);
      const receivedAt = params.receivedAt ?? this.now();
      if (!Number.isSafeInteger(receivedAt) || receivedAt + ORIGINAL_ATTACHMENT_RETENTION_MS <= this.now()) throw unavailable();
      const record: RecordMetadata = {
        attachmentId, scopeKey, actorKey: params.actorKey,
        name: [...params.name.slice(0, 255)].filter((character) => character.charCodeAt(0) >= 32
          && character.charCodeAt(0) !== 127).join("") || "attachment",
        mimeType: safeMimeType(params.mimeType),
        sizeBytes: params.data.byteLength, sha256: digest(params.data), receivedAt,
        expiresAt: receivedAt + ORIGINAL_ATTACHMENT_RETENTION_MS,
      };
      let totalBytes = records.reduce((sum, item) => sum + item.sizeBytes, 0);
      while (records.length >= this.limits.maxRecords || totalBytes + record.sizeBytes > this.limits.maxOriginalBytes) {
        const oldest = records.shift();
        if (!oldest) break;
        await rm(this.directory(oldest.attachmentId), { recursive: true, force: true });
        totalBytes -= oldest.sizeBytes;
      }
      const staging = path.join(this.root, `.pending-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await writeFile(path.join(staging, "original"), params.data, { mode: 0o600, flag: "wx" });
        await writeFile(path.join(staging, "metadata.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
        await rename(staging, this.directory(attachmentId));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return summary(record);
    });
  }

  async list(scope: OriginalAttachmentScope, actorKey?: string, after?: string): Promise<{
    attachments: PwrAgentMessagingAttachmentSummary[]; nextCursor?: string;
  }> {
    return this.serial(async () => {
      await this.ensureRoot();
      const records = (await this.records()).filter((record) =>
        this.matches(record, scope, actorKey)
      ).sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
      if (after !== undefined && !ID_PATTERN.test(after)) {
        throw new OriginalAttachmentError("invalid_arguments", "Use the nextCursor returned by list_messaging_attachments.");
      }
      const page = records.filter((record) => !after || record.attachmentId > after).slice(0, 26);
      return {
        attachments: page.slice(0, 25).map(summary),
        ...(page.length > 25 ? { nextCursor: page[24]!.attachmentId } : {}),
      };
    });
  }

  /** Host-only byte snapshot for authenticated Federation export. Paths never
   * cross this boundary; the receiver chooses its own private staging path. */
  async read(scope: OriginalAttachmentScope, attachmentId: string, actorKey: string): Promise<VerifiedOriginalAttachment> {
    return this.serial(async () => {
      await this.ensureRoot();
      const record = (await this.records()).find((item) => item.attachmentId === attachmentId
        && this.matches(item, scope, actorKey));
      if (!record) throw unavailable();
      return { attachment: summary(record), data: await verifiedOriginalAttachmentBytes(
        path.join(this.directory(record.attachmentId), "original"), record,
      ) };
    });
  }

  /** Export to a fixed, generated sibling, never to a model/provider path.
   * The backend's ordinary filesystem tools own the final destination write
   * and its sandbox/approval checks. No overwrite/move/delete API is exposed.
   */
  async export(scope: OriginalAttachmentScope, attachmentId: string, actorKey?: string): Promise<{
    attachment: PwrAgentMessagingAttachmentSummary; path: string;
  }> {
    return this.serial(async () => {
      await this.ensureRoot();
      const record = (await this.records()).find((item) => item.attachmentId === attachmentId
        && this.matches(item, scope, actorKey));
      if (!record) throw unavailable();
      const directory = this.directory(record.attachmentId);
      const data = await verifiedOriginalAttachmentBytes(path.join(directory, "original"), record);
      // A remote filename is display data only. It never becomes a local path.
      const exportPath = path.join(directory, "export");
      const staging = path.join(directory, `.export-${randomUUID()}`);
      try {
        await writeFile(staging, data, { flag: "wx", mode: 0o600 });
        try {
          // An exclusive link publishes complete bytes without replacing an
          // existing file, symlink or hard link. Repeated exports verify it.
          await link(staging, exportPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        await rm(staging, { force: true });
      }
      try {
        await verifiedOriginalAttachmentBytes(exportPath, record);
      } catch {
        throw new OriginalAttachmentError("forbidden", "The original is retained, but its generated export was changed or replaced. It cannot be safely reused or overwritten. Reattach the file as a new message to create a fresh export.");
      }
      return { attachment: summary(record), path: exportPath };
    });
  }

  private matches(record: RecordMetadata, scope: OriginalAttachmentScope, actorKey?: string): boolean {
    return record.scopeKey === scopeDigest(scope) && (!actorKey || actorKey === record.actorKey);
  }

  private directory(attachmentId: string): string {
    if (!ID_PATTERN.test(attachmentId)) throw unavailable();
    return path.join(this.root, attachmentId);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw unavailable();
  }

  private async records(): Promise<RecordMetadata[]> {
    const result: RecordMetadata[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.root, entry.name);
      if (entry.name.startsWith(".pending-")) {
        if (this.now() - (await lstat(directory)).mtimeMs > ORIGINAL_ATTACHMENT_RETENTION_MS) {
          await rm(directory, { recursive: true, force: true });
        }
        continue;
      }
      if (!ID_PATTERN.test(entry.name)) continue;
      let record: RecordMetadata;
      try {
        const metadata = await open(path.join(directory, "metadata.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await metadata.stat();
          if (!stat.isFile() || stat.size > 4096) continue;
          record = JSON.parse(await metadata.readFile("utf8")) as RecordMetadata;
        } finally { await metadata.close(); }
      } catch { continue; }
      if (record.attachmentId !== entry.name || !ID_PATTERN.test(record.scopeKey) || !ID_PATTERN.test(record.actorKey)
        || !ID_PATTERN.test(record.sha256) || typeof record.name !== "string" || record.name.length > 255
        || typeof record.mimeType !== "string" || record.mimeType !== safeMimeType(record.mimeType)
        || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || record.sizeBytes > MAX_ATTACHMENT_BYTES
        || !Number.isSafeInteger(record.receivedAt) || !Number.isSafeInteger(record.expiresAt)) continue;
      if (record.expiresAt <= this.now()) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      result.push(record);
    }
    return result.sort((a, b) => a.receivedAt - b.receivedAt || a.attachmentId.localeCompare(b.attachmentId));
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
}

function summary(record: RecordMetadata): PwrAgentMessagingAttachmentSummary {
  const { attachmentId, name, mimeType, sizeBytes, sha256, receivedAt, expiresAt } = record;
  return { attachmentId, name, mimeType, sizeBytes, sha256, receivedAt, expiresAt };
}

function safeMimeType(value?: string): string {
  return value && value.length <= 127 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(value)
    ? value.toLowerCase() : "application/octet-stream";
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeDigest(scope: OriginalAttachmentScope): string {
  return digest(JSON.stringify([scope.backend, scope.threadId, scope.provider, scope.instanceId]));
}

function unavailable(): OriginalAttachmentError {
  return new OriginalAttachmentError("not_found", "Original attachment is unavailable in this thread. It may have expired (7 days), reached the cache limit, or never downloaded. Ask the sender to attach it again.");
}

export async function verifiedOriginalAttachmentBytes(filePath: string, record: PwrAgentMessagingAttachmentSummary): Promise<Uint8Array> {
  try {
    // Explicit lstat also covers platforms where O_NOFOLLOW is unavailable.
    const observed = await lstat(filePath);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1) throw unavailable();
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== record.sizeBytes || stat.nlink !== 1
        || stat.ino !== observed.ino || stat.dev !== observed.dev) throw unavailable();
      const data = Buffer.alloc(record.sizeBytes);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat();
      if (offset !== record.sizeBytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || after.ctimeMs !== stat.ctimeMs || digest(data) !== record.sha256) throw unavailable();
      return data;
    } finally { await file.close(); }
  } catch { throw unavailable(); }
}
