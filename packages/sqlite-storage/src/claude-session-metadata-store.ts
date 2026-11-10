import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ClaudeProfileSessionMetadata, ClaudeSessionMetadataStorage } from "@pwragent/owner-core/claude-profile-storage";

/** Reads only PwrAgent-owned *.json metadata, never history or SDK session files. */
export class ClaudeSessionMetadataStore<T extends ClaudeProfileSessionMetadata = ClaudeProfileSessionMetadata>
implements ClaudeSessionMetadataStorage<T> {
  constructor(private readonly root: string) {}

  async read(id: string): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude thread id.");
    const session = JSON.parse(await readFile(path.join(this.root, `${id}.json`), "utf8")) as T;
    if (session.thread?.id !== id || session.thread.source !== "claude" || !session.cwd) {
      throw new Error(`Invalid Claude session metadata: ${id}`);
    }
    return session;
  }

  async list(options: { requireComplete?: boolean } = {}): Promise<T[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // One unreadable sidecar must not hide every other Claude thread.
    const sessions = await Promise.allSettled(names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map(name => this.read(name.slice(0, -5))));
    if (options.requireComplete) {
      const failed = sessions.find(session => session.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    return sessions.flatMap(session => session.status === "fulfilled" ? [session.value] : []);
  }

  async changeToken(): Promise<string> {
    try {
      const entry = await stat(this.root, { bigint: true });
      return `${entry.ino}:${entry.mtimeNs}:${entry.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
}
