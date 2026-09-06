import { promises as fs } from "node:fs";
import { mapTokenMiserFiles, withTokenMiserFileOperation } from "./token-miser-file-io";

type Discovery<T> = {
  names: string[];
  records: Map<string, T | undefined>;
};

/**
 * The flat legacy store has no on-disk thread index. Retain only immutable
 * filename ownership, never mutable counters or observation payloads. Listing
 * names discovers other processes' additions/removals; known unrelated records
 * need no content read. Each cold discovery is shared by overlapping queries.
 */
export class TokenMiserRecordIndex<T extends { threadId: string }> {
  private readonly owners = new Map<string, string>();
  private discovery?: { version: string; result: Promise<Discovery<T>> };

  constructor(
    private readonly directory: string,
    private readonly read: (name: string) => Promise<T | undefined>,
  ) {}

  remember(name: string, threadId: string): void {
    this.owners.set(name, threadId);
    // A query started after this commit needs a new directory snapshot, even
    // if an older discovery is still reading records.
    this.discovery = undefined;
  }

  forget(name: string): void {
    this.owners.delete(name);
    this.discovery = undefined;
  }

  async list(threadId?: string): Promise<T[]> {
    // Atomic record replacements change the parent directory's timestamps.
    // A caller after another process's commit must not join an older discovery.
    const version = await this.directoryVersion();
    const discovery = this.discovery?.version === version
      ? this.discovery
      : { version, result: this.discover() };
    this.discovery = discovery;
    let snapshot: Discovery<T>;
    try {
      snapshot = await discovery.result;
    } finally {
      if (this.discovery === discovery) this.discovery = undefined;
    }
    const names = snapshot.names.filter((name) =>
      !threadId || this.owners.get(name) === threadId
    );
    const values = await mapTokenMiserFiles(names, async (name) => {
      const value = snapshot.records.has(name)
        ? snapshot.records.get(name)
        : await this.read(name);
      if (value) this.owners.set(name, value.threadId);
      return value;
    });
    return values
      .filter((value): value is T => value !== undefined)
      .filter((value) => !threadId || value.threadId === threadId);
  }

  private async directoryVersion(): Promise<string> {
    try {
      const stats = await withTokenMiserFileOperation(() =>
        fs.stat(this.directory, { bigint: true })
      );
      return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  private async discover(): Promise<Discovery<T>> {
    const entries = await withTokenMiserFileOperation(() => fs.readdir(this.directory))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const names = entries.filter((name) => name.endsWith(".json"));
    const present = new Set(names);
    for (const name of this.owners.keys()) {
      if (!present.has(name)) this.owners.delete(name);
    }
    const unknown = names.filter((name) => !this.owners.has(name));
    const values = await mapTokenMiserFiles(unknown, this.read);
    const records = new Map<string, T | undefined>();
    for (const [index, name] of unknown.entries()) {
      const value = values[index];
      records.set(name, value);
      if (value) this.owners.set(name, value.threadId);
    }
    return { names, records };
  }
}
