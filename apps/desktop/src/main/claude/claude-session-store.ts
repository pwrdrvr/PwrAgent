import type { ClaudeUsageTotals } from "./claude-usage";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import type {
  AppServerThreadEntry, AppServerThreadSummary, AppServerThreadTurnMetadata, BackendRateLimitSummary,
} from "@pwragent/shared";
import type { ClaudeSessionMetadataStorage } from "@pwragent/owner-core/claude-profile-storage";
import { createClaudeSessionMetadataStorage } from "../storage/desktop-claude-profile-storage";
import { persistTranscriptEntryImages } from "../transcript-image-protocol";

/** Not a thread id, so list() never reads it as session metadata. */
const RATE_LIMITS_FILE = "rate-limits.json";
const sessionWrites = new Map<string, {
  writers: number;
  ready: Promise<() => Promise<void>>;
  closing?: Promise<void>;
}>();

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
  /**
   * Each time the thread continued in a new Claude session because Claude
   * Code had deleted the one it resumed, oldest first.
   */
  sessionRestarts?: { at: number; previousSdkSessionId: string }[];
  /**
   * The next query opens with PwrAgent's record of the earlier conversation.
   * Cleared once Claude confirms the new session.
   */
  primerPending?: boolean;
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

/**
 * A history line that ends a turn. Every entry of the turn takes its status
 * and times, so an entry saved while the turn ran is not written again just
 * to change its status. Files written before this record existed stamp each
 * entry instead, and read the same.
 */
export type ClaudeTurnEndRecord = {
  type: "pwragent_turn_end";
  turnId: string;
  status: NonNullable<AppServerThreadTurnMetadata["status"]>;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
};

type ClaudeHistoryLine = AppServerThreadEntry | ClaudeTruncationRecord | ClaudeTruncationUndoRecord | ClaudeTurnEndRecord;

/** The transcript a history describes: latest revisions, truncations and turn ends applied. */
function historyEntries(lines: readonly ClaudeHistoryLine[]): AppServerThreadEntry[] {
  const undone = new Set(lines.flatMap((line) =>
    line.type === "pwragent_truncation_undo" ? [line.truncationId] : []));
  const turnEnds = new Map<string, ClaudeTurnEndRecord>();
  // Revisions of a tool entry append rather than rewriting history.
  const entries = new Map<string, AppServerThreadEntry>();
  for (const entry of lines) {
    if (entry.type === "pwragent_truncation_undo") continue;
    if (entry.type === "pwragent_turn_end") {
      turnEnds.set(entry.turnId, entry);
      continue;
    }
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
  // A turn's end covers every entry of the turn, including a revision saved
  // after it, such as a task row the turn's task settled later.
  return [...entries.values()].map((entry) => {
    const end = entry.turn ? turnEnds.get(entry.turn.id) : undefined;
    if (!end) return entry;
    return {
      ...entry,
      turn: {
        id: end.turnId, status: end.status,
        ...(end.startedAt !== undefined ? { startedAt: end.startedAt } : {}),
        ...(end.completedAt !== undefined ? { completedAt: end.completedAt } : {}),
      },
    };
  });
}

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
  private readonly memory = new Map<string, { session: string; lines: ClaudeHistoryLine[] }>();
  /** Ended ephemeral threads. A late write for one must not create a file. */
  private readonly forgotten = new Set<string>();
  private readonly mutationContext = new AsyncLocalStorage<{ id: string; active: boolean }>();

  private readonly metadata: ClaudeSessionMetadataStorage<ClaudeSession>;

  constructor(
    private readonly root: string,
    private readonly imageRoot = path.join(root, "images"),
  ) {
    this.metadata = createClaudeSessionMetadataStorage<ClaudeSession>(root);
  }

  /** Starts holding an ephemeral session in memory. */
  holdEphemeral(session: ClaudeSession): void {
    this.memory.set(session.thread.id, { session: JSON.stringify({ ...session, ephemeral: true }), lines: [] });
  }

  /** Drops an ephemeral session. A later save or append for it does nothing. */
  forgetEphemeral(id: string): void {
    if (!this.memory.delete(id)) return;
    this.forgotten.add(id);
    // Late writes land within seconds of the end; recent ids are enough.
    if (this.forgotten.size > 256) this.forgotten.delete(this.forgotten.values().next().value!);
  }

  /** Whether an ephemeral session was dropped. Its late writes do nothing, and a read fails. */
  isForgotten(id: string): boolean {
    return this.forgotten.has(id);
  }

  private file(id: string, suffix: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude thread id.");
    return path.join(this.root, `${id}.${suffix}`);
  }

  /** One thread mutation across profile-sharing instances. Contention fails
   * closed. The directory lock works even when
   * metadata is absent and is released after the complete read/check/write. */
  async withMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
    const file = this.file(id, "json");
    const current = this.mutationContext.getStore();
    if ((current?.id === id && current.active) || this.memory.has(id)) return await work();
    const release = await this.acquireMutationLock(file);
    const scope = { id, active: true };
    try { return await this.mutationContext.run(scope, work); }
    finally { scope.active = false; await release(); }
  }

  private async acquireMutationLock(file: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { return await lock(file, { realpath: false, retries: 0, stale: 60_000, update: 10_000 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new Error("Claude thread is being changed in another PwrAgent instance. Try again when it finishes.", { cause: error });
      }
      throw error;
    }
  }

  /** Concurrent publishers in this process share admission until all writes
   * finish, preserving image-publication coalescing across store objects. */
  private async withWrite<T>(id: string, work: () => Promise<T>): Promise<T> {
    const current = this.mutationContext.getStore();
    if (current?.id === id && current.active) return await work();
    const file = path.resolve(this.file(id, "json"));
    let admission = sessionWrites.get(file);
    if (!admission || admission.closing) {
      const closing = admission?.closing;
      admission = { writers: 0, ready: closing
        ? closing.then(async () => await this.acquireMutationLock(file))
        : this.acquireMutationLock(file) };
      sessionWrites.set(file, admission);
    }
    admission.writers += 1;
    const scope = { id, active: true };
    let release: (() => Promise<void>) | undefined;
    try {
      release = await admission.ready;
      return await this.mutationContext.run(scope, work);
    } finally {
      scope.active = false;
      if (--admission.writers === 0) {
        admission.closing = release?.() ?? Promise.resolve();
        try { await admission.closing; }
        finally { if (sessionWrites.get(file) === admission) sessionWrites.delete(file); }
      }
    }
  }

  async read(id: string): Promise<ClaudeSession> {
    const held = this.memory.get(id);
    if (held) return JSON.parse(held.session) as ClaudeSession;
    return await this.metadata.read(id);
  }

  async save(session: ClaudeSession): Promise<void> {
    if (session.ephemeral) {
      const held = this.memory.get(session.thread.id);
      if (held) held.session = JSON.stringify(session);
      return;
    }
    await this.withWrite(session.thread.id, async () => {
      const destination = this.file(session.thread.id, "json");
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    });
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

  /**
   * Moves whenever a session file is created, replaced or removed: every write
   * here renames a temporary file into the directory. Archive cleanup uses it
   * to notice a writer outside this process without rereading every session.
   */
  async changeToken(): Promise<string> {
    return await this.metadata.changeToken();
  }

  async list(options: { requireComplete?: boolean } = {}): Promise<ClaudeSession[]> {
    return await this.metadata.list(options);
  }

  /** Delete only PwrAgent's files. Metadata goes last so failed cleanup is retried. */
  async delete(id: string): Promise<void> {
    await this.withMutation(id, async () => {
      const metadata = this.file(id, "json");
      await rm(this.file(id, "jsonl"), { force: true });
      await rm(this.rewindBackupDirectory(id), { recursive: true, force: true });
      await rm(path.join(this.imageRoot, id), { recursive: true, force: true });
      await rm(metadata, { force: true });
    });
  }

  /**
   * Append entries, then `turnEnd` when given, in one write. A turn end
   * gives every entry of its turn the turn's final status.
   */
  async append(
    id: string, entries: AppServerThreadEntry[],
    turnEnd?: Omit<ClaudeTurnEndRecord, "type" | "createdAt">,
  ): Promise<void> {
    if ((entries.length === 0 && !turnEnd) || this.forgotten.has(id)) return;
    const record: ClaudeTurnEndRecord[] = turnEnd ? [{ type: "pwragent_turn_end", ...turnEnd, createdAt: Date.now() }] : [];
    const held = this.memory.get(id);
    if (held) {
      held.lines.push(...[...entries, ...record].map((line) => JSON.parse(JSON.stringify(line)) as ClaudeHistoryLine));
      return;
    }
    await this.withWrite(id, async () => {
      const destination = this.file(id, "jsonl");
      const retained = await persistTranscriptEntryImages(
        entries, path.join(this.imageRoot, id),
      );
      await appendFile(destination, [...retained, ...record].map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
    });
  }

  /** Drop `beforeEntryId` and every entry recorded after it; returns the truncation's id. */
  async truncate(id: string, beforeEntryId: string): Promise<string> {
    const record: ClaudeTruncationRecord = {
      type: "pwragent_truncation", id: `truncation:${randomUUID()}`, beforeEntryId, createdAt: Date.now(),
    };
    await this.withWrite(id, async () => {
      await appendFile(this.file(id, "jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    });
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
      } else if (line.type === "pwragent_turn_end") {
        // Ends a turn recorded before the truncation; it adds no entry.
        continue;
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
    await this.withWrite(id, async () => {
      await appendFile(this.file(id, "jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    });
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
    return historyEntries(held ? held.lines : await this.lines(id));
  }
}
