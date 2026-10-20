import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppServerThreadEntry, AppServerThreadSummary } from "@pwragent/shared";

export type ClaudeSession = {
  thread: AppServerThreadSummary;
  cwd: string;
  /** Set only after the SDK confirms initialization; used by query({ resume }). */
  sdkSessionId?: string;
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

  async list(): Promise<ClaudeSession[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((name) => this.read(name.slice(0, -5))));
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
        const entry = JSON.parse(line) as AppServerThreadEntry;
        entries.set(entry.id, entry);
      }
      return [...entries.values()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
