import type { ClaudeUsageTotals } from "./claude-usage";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppServerThreadEntry, AppServerThreadSummary, BackendRateLimitSummary } from "@pwragent/shared";

/** Not a thread id, so list() never reads it as session metadata. */
const RATE_LIMITS_FILE = "rate-limits.json";

export type ClaudeSession = {
  thread: AppServerThreadSummary;
  cwd: string;
  /** Set only after the SDK confirms initialization; used by query({ resume }). */
  sdkSessionId?: string;
  /**
   * The folder whose Claude project holds `sdkSessionId`'s file, when the
   * thread has since moved to another cwd. Claude keeps a resumed session's
   * file where it was created. Absent means `cwd`.
   */
  sdkSessionDir?: string;
  /**
   * A fork's source session. Its first query resumes there with
   * `forkSession`, and the session Claude creates becomes `sdkSessionId`.
   */
  forkFromSdkSessionId?: string;
  /**
   * A thread PwrAgent runs for its own work, such as a task monitor. Held in
   * memory only, never listed, and never written to disk.
   */
  ephemeral?: boolean;
  /** At most one native title request, including failed requests, across restarts. */
  titleGenerationAttempted?: boolean;
  modelUsage?: ClaudeUsageTotals;
  contextWindow?: { usedTokens: number; modelContextWindow: number };
  /**
   * The SDK entry the next query resumes at, set by a rewind. Claude drops
   * every later entry from the conversation it continues, and keeps them in
   * the session file as another branch. Cleared once a query resumes there.
   */
  resumeSessionAt?: string;
  /** Each rewind, oldest first. */
  rewinds?: ClaudeRewindRecord[];
};

export type ClaudeRewindRecord = {
  /** The rewind's id in the thread's rewind log. Absent before undo. */
  id?: string;
  at: number;
  /** The desktop turn the rewind removed, with every later turn. */
  beforeTurnId: string;
  /** The SDK session that holds the removed turns. */
  sdkSessionId: string;
  /** The last entry of the removed branch, where an undo would resume. */
  removedLeafUuid?: string;
  restoredFiles?: string[];
  /** The history line that dropped the removed turns. */
  truncationId?: string;
  /**
   * What the rewind left the session at. Until the next turn changes it,
   * the rewind can be undone.
   */
  after?: { sdkSessionId?: string; resumeSessionAt?: string };
  /** What the rewind cleared, which an undo puts back. */
  before?: { resumeSessionAt?: string; modelUsage?: ClaudeUsageTotals; contextWindow?: ClaudeSession["contextWindow"] };
  /** The restored files' earlier contents, kept for an undo. */
  fileBackup?: boolean;
  undoneAt?: number;
};

/**
 * A history line that drops an entry and every entry recorded after it. The
 * history stays append-only, so a rewind survives a restart without
 * rewriting the file.
 */
type ClaudeTruncationRecord = {
  type: "pwragent_truncation";
  id: string;
  beforeEntryId: string;
  createdAt: number;
};

/** A history line that puts back what a truncation dropped. */
type ClaudeTruncationUndoRecord = {
  type: "pwragent_truncation_undo";
  truncationId: string;
  createdAt: number;
};

type ClaudeHistoryLine = AppServerThreadEntry | ClaudeTruncationRecord | ClaudeTruncationUndoRecord;

export type ClaudeRateLimitsRecord = {
  limits: BackendRateLimitSummary[];
  /** Hash of the account the limits describe; never the account's own identifiers. */
  account?: string;
  /** When Claude last reported these limits. Absent from files before it was recorded. */
  observedAt?: number;
  /** The account's subscription, as Claude names it (`max`, `pro`). */
  plan?: string;
};

/**
 * PwrAgent-owned metadata and append-only history. No transcript is stored in
 * SQLite, and no Claude authentication or provider-owned files are inspected.
 */
export class ClaudeSessionStore {
  /** Ephemeral sessions and their entries, by thread id. */
  private readonly memory = new Map<string, { session: string; entries: AppServerThreadEntry[] }>();
  /** Ended ephemeral threads. A late write for one must not create a file. */
  private readonly forgotten = new Set<string>();

  constructor(private readonly root: string) {}

  /** Starts holding an ephemeral session in memory. */
  holdEphemeral(session: ClaudeSession): void {
    this.memory.set(session.thread.id, { session: JSON.stringify({ ...session, ephemeral: true }), entries: [] });
  }

  /** Drops an ephemeral session. A later save or append for it does nothing. */
  forgetEphemeral(id: string): void {
    if (!this.memory.delete(id)) return;
    this.forgotten.add(id);
    // Late writes land within seconds of the end; recent ids are enough.
    if (this.forgotten.size > 256) this.forgotten.delete(this.forgotten.values().next().value!);
  }

  private file(id: string, suffix: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude thread id.");
    return path.join(this.root, `${id}.${suffix}`);
  }

  async read(id: string): Promise<ClaudeSession> {
    const held = this.memory.get(id);
    if (held) return JSON.parse(held.session) as ClaudeSession;
    const session = JSON.parse(await readFile(this.file(id, "json"), "utf8")) as ClaudeSession;
    if (session.thread?.id !== id || session.thread.source !== "claude" || !session.cwd) {
      throw new Error(`Invalid Claude session metadata: ${id}`);
    }
    return session;
  }

  async save(session: ClaudeSession): Promise<void> {
    if (session.ephemeral) {
      const held = this.memory.get(session.thread.id);
      if (held) held.session = JSON.stringify(session);
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = this.file(session.thread.id, "json");
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Account-wide limits last reported by Claude, so a restart does not start blank. */
  async readRateLimits(): Promise<ClaudeRateLimitsRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(this.root, RATE_LIMITS_FILE), "utf8"));
    } catch {
      return { limits: [] };
    }
    // The first release wrote a bare array, with no account.
    const record = Array.isArray(value) ? { limits: value } : value;
    if (!record || typeof record !== "object" || !("limits" in record) || !Array.isArray(record.limits)) {
      return { limits: [] };
    }
    const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number);
    const limits = record.limits.flatMap((limit: unknown): BackendRateLimitSummary[] => {
      if (!limit || typeof limit !== "object" || !("name" in limit) || !("limitId" in limit)
        || typeof limit.name !== "string" || typeof limit.limitId !== "string") return [];
      const { usedPercent, resetAt, ...row } = limit as BackendRateLimitSummary;
      // A meter without a reading draws nothing; a reset without a time is no reset.
      if (usedPercent !== undefined && !finite(usedPercent)) return [];
      return [{
        ...row,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(finite(resetAt) ? { resetAt } : {}),
      }];
    });
    const account = "account" in record && typeof record.account === "string" ? record.account : undefined;
    const observedAt = "observedAt" in record && finite(record.observedAt) ? record.observedAt : undefined;
    const plan = "plan" in record && typeof record.plan === "string" && record.plan ? record.plan : undefined;
    return {
      limits,
      ...(account ? { account } : {}),
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(plan ? { plan } : {}),
    };
  }

  async saveRateLimits(
    limits: BackendRateLimitSummary[],
    account?: string,
    reading: Pick<ClaudeRateLimitsRecord, "observedAt" | "plan"> = {},
  ): Promise<void> {
    const destination = path.join(this.root, RATE_LIMITS_FILE);
    if (limits.length === 0) {
      await rm(destination, { force: true });
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const record: ClaudeRateLimitsRecord = {
      limits,
      ...(account ? { account } : {}),
      ...(reading.observedAt !== undefined ? { observedAt: reading.observedAt } : {}),
      ...(reading.plan ? { plan: reading.plan } : {}),
    };
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async list(): Promise<ClaudeSession[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // One unreadable metadata file must not hide every other Claude thread.
    const sessions = await Promise.allSettled(names.filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((name) => this.read(name.slice(0, -5))));
    return sessions.flatMap((session) => session.status === "fulfilled" ? [session.value] : []);
  }

  async append(id: string, entries: AppServerThreadEntry[]): Promise<void> {
    if (entries.length === 0 || this.forgotten.has(id)) return;
    const held = this.memory.get(id);
    if (held) {
      held.entries.push(...entries.map((entry) => JSON.parse(JSON.stringify(entry)) as AppServerThreadEntry));
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.file(id, "jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  }

  /** Drop `beforeEntryId` and every entry recorded after it; returns the truncation's id. */
  async truncate(id: string, beforeEntryId: string): Promise<string> {
    const record: ClaudeTruncationRecord = {
      type: "pwragent_truncation", id: `truncation:${randomUUID()}`, beforeEntryId, createdAt: Date.now(),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.file(id, "jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    return record.id;
  }

  /**
   * Whether `truncationId` can still be undone: it is in effect, and no
   * entry was recorded after it. A later entry belongs to the conversation
   * the truncation left, which an undo would interleave with the old one.
   */
  async canUndoTruncation(id: string, truncationId: string): Promise<boolean> {
    let found = false;
    const undone = new Set<string>();
    for (const line of await this.lines(id)) {
      if (line.type === "pwragent_truncation_undo") {
        undone.add(line.truncationId);
      } else if (line.type === "pwragent_truncation") {
        if (line.id === truncationId) found = true;
      } else if (found) {
        return false;
      }
    }
    return found && !undone.has(truncationId);
  }

  /** Put back the entries `truncationId` dropped. */
  async undoTruncation(id: string, truncationId: string): Promise<void> {
    const record: ClaudeTruncationUndoRecord = {
      type: "pwragent_truncation_undo", truncationId, createdAt: Date.now(),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.file(id, "jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  /**
   * A directory for the files a rewind restored, as they were before it.
   * PwrAgent owns it, beside the thread's history.
   */
  rewindBackupDirectory(id: string, rewindId?: string): string {
    if (rewindId !== undefined && !/^[0-9a-f-]{36}$/i.test(rewindId)) throw new Error("Invalid rewind id.");
    const directory = path.join(path.dirname(this.file(id, "json")), "rewind-backups", id);
    return rewindId === undefined ? directory : path.join(directory, rewindId);
  }

  private async lines(id: string): Promise<ClaudeHistoryLine[]> {
    let text: string;
    try {
      text = await readFile(this.file(id, "jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).flatMap((line) => {
      // appendFile is not atomic: a crash can leave a torn final line.
      // Skip it rather than make the whole transcript unreadable.
      try { return [JSON.parse(line) as ClaudeHistoryLine]; }
      catch { return []; }
    });
  }

  async entries(id: string): Promise<AppServerThreadEntry[]> {
    const held = this.memory.get(id);
    // Revisions of a tool entry append; the latest revision keeps its first place.
    if (held) return [...new Map(held.entries.map((entry) => [entry.id, entry])).values()];
    const lines = await this.lines(id);
    const undone = new Set(lines.flatMap((line) =>
      line.type === "pwragent_truncation_undo" ? [line.truncationId] : []));
    // Revisions of a tool entry append rather than rewriting history.
    const entries = new Map<string, AppServerThreadEntry>();
    for (const entry of lines) {
      if (entry.type === "pwragent_truncation_undo") continue;
      if (entry.type === "pwragent_truncation") {
        if (undone.has(entry.id)) continue;
        // Map keys keep the order entries were first recorded in.
        let removing = false;
        for (const key of entries.keys()) {
          if (key === entry.beforeEntryId) removing = true;
          if (removing) entries.delete(key);
        }
        continue;
      }
      entries.set(entry.id, entry);
    }
    return [...entries.values()];
  }
}
