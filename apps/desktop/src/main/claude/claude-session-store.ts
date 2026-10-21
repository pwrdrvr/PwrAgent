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
  modelUsage?: ClaudeUsageTotals;
  contextWindow?: { usedTokens: number; modelContextWindow: number };
};

/**
 * PwrAgent-owned metadata and append-only history. No transcript is stored in
 * SQLite, and no Claude authentication or provider-owned files are inspected.
 */
export class ClaudeSessionStore {
  constructor(private readonly root: string) {}

  private file(id: string, suffix: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude thread id.");
    return path.join(this.root, `${id}.${suffix}`);
  }

  async read(id: string): Promise<ClaudeSession> {
    const session = JSON.parse(await readFile(this.file(id, "json"), "utf8")) as ClaudeSession;
    if (session.thread?.id !== id || session.thread.source !== "claude" || !session.cwd) {
      throw new Error(`Invalid Claude session metadata: ${id}`);
    }
    return session;
  }

  async save(session: ClaudeSession): Promise<void> {
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
  async readRateLimits(): Promise<BackendRateLimitSummary[]> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.root, RATE_LIMITS_FILE), "utf8"));
      return Array.isArray(value) ? value.filter((limit): limit is BackendRateLimitSummary =>
        Boolean(limit) && typeof limit.name === "string" && typeof limit.limitId === "string") : [];
    } catch {
      return [];
    }
  }

  async saveRateLimits(limits: BackendRateLimitSummary[]): Promise<void> {
    const destination = path.join(this.root, RATE_LIMITS_FILE);
    if (limits.length === 0) {
      await rm(destination, { force: true });
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(limits), { mode: 0o600 });
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
    if (entries.length === 0) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await appendFile(this.file(id, "jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  }

  async entries(id: string): Promise<AppServerThreadEntry[]> {
    try {
      const text = await readFile(this.file(id, "jsonl"), "utf8");
      // Revisions of a tool entry append rather than rewriting history.
      const entries = new Map<string, AppServerThreadEntry>();
      for (const line of text.split("\n").filter(Boolean)) {
        // appendFile is not atomic: a crash can leave a torn final line.
        // Skip it rather than make the whole transcript unreadable.
        let entry: AppServerThreadEntry;
        try { entry = JSON.parse(line) as AppServerThreadEntry; }
        catch { continue; }
        entries.set(entry.id, entry);
      }
      return [...entries.values()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
