import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntegratedTerminalSessionSummary, TerminalSnapshot } from "../../shared/integrated-terminal";
import { TERMINAL_SNAPSHOT_LIMIT } from "./terminal-replay";

export type TerminalHistoryRecord = {
  version: 1;
  summary: IntegratedTerminalSessionSummary;
  snapshot: TerminalSnapshot;
  savedAt: number;
  /** Owner-side remote sessions remain bound to the authenticated opener. */
  peerId?: string;
};
const MAX_RECORDS = 64;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = TERMINAL_SNAPSHOT_LIMIT * 2 + 16_384;

/** Boundary-only file persistence. No input, raw stream journal, timer or SQL.
 * Caller supplies an instance-scoped directory to avoid shared-profile writers. */
export class TerminalHistoryStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly saved = new Map<string, number>();
  constructor(private readonly directory: string) {}

  async load(): Promise<TerminalHistoryRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const records: TerminalHistoryRecord[] = [];
    for (const name of files) {
      const file = path.join(this.directory, name);
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        if (info.size > MAX_FILE_BYTES || Date.now() - info.mtimeMs > MAX_AGE_MS) {
          await rm(file, { force: true });
          continue;
        }
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        if (!isRecord(value)) continue;
        records.push(value);
        this.saved.set(value.summary.sessionId, value.savedAt);
      } catch { /* A corrupt or concurrently removed cache is disposable. */ }
    }
    records.sort((a, b) => b.savedAt - a.savedAt);
    for (const record of records.slice(MAX_RECORDS)) await this.remove(record.summary.sessionId);
    return records.slice(0, MAX_RECORDS);
  }

  save(record: TerminalHistoryRecord): Promise<void> {
    return this.enqueue(async () => {
      const data = JSON.stringify(record);
      if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("Terminal history exceeds its byte budget.");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.file(record.summary.sessionId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
        this.saved.set(record.summary.sessionId, record.savedAt);
        const sorted = [...this.saved.entries()].sort((a, b) => b[1] - a[1]);
        for (const [id, savedAt] of sorted) {
          if (sorted.findIndex(([key]) => key === id) >= MAX_RECORDS || Date.now() - savedAt > MAX_AGE_MS) {
            await rm(this.file(id), { force: true });
            this.saved.delete(id);
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  remove(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.file(sessionId), { force: true });
      this.saved.delete(sessionId);
    });
  }

  private file(id: string): string {
    return path.join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function isRecord(value: unknown): value is TerminalHistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as TerminalHistoryRecord;
  const summary = record.summary;
  const snapshot = record.snapshot;
  return record.version === 1
    && Number.isFinite(record.savedAt)
    && Date.now() - record.savedAt < MAX_AGE_MS
    && !!summary && typeof summary.sessionId === "string" && summary.sessionId.length <= 256
    && typeof summary.threadKey === "string" && summary.threadKey.length <= 512
    && typeof summary.cwd === "string" && typeof summary.shell === "string"
    && Number.isFinite(summary.createdAt)
    && !!snapshot && typeof snapshot.data === "string"
    && Buffer.byteLength(snapshot.data) <= TERMINAL_SNAPSHOT_LIMIT
    && Number.isSafeInteger(snapshot.seq) && snapshot.seq >= 0
    && Number.isInteger(snapshot.cols) && snapshot.cols >= 2 && snapshot.cols <= 500
    && Number.isInteger(snapshot.rows) && snapshot.rows >= 2 && snapshot.rows <= 200;
}
