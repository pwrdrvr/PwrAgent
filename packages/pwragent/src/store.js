import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ACTIVE = new Set(["starting", "running", "interrupting"]);
export const TERMINAL = new Set(["completed", "failed", "interrupted", "blocked", "unknown"]);
export const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Expected a private directory owned by this user: ${directory}`);
  }
}

export function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    // Windows rejects directory fsync. The file is synced before rename on every host.
    if (process.platform !== "win32") {
      const directory = openSync(path.dirname(file), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    // Preserve the original storage failure even if cleanup also fails.
    try { unlinkSync(temporary); } catch { /* A renamed file is already gone. */ }
    throw error;
  }
}

export class JobStore {
  constructor(directory, identity, profileRuntime) {
    this.directory = path.join(directory, "jobs");
    const storage = profileRuntime.openOwnerStorage(directory, identity);
    this.storage = storage.jobs;
    this.threadRegistry = storage.threads;
    this.inventory = storage.inventory;
    this.retainedOwners = storage.retainedOwners;
    this.acpSessions = storage.acpSessions;
    this.claudeSessions = storage.claudeSessions;
    this.durableTurnRequests = storage.durableTurnRequests;
    // Existing runtime consumers retain point reads and iteration, without a
    // second mutable registry that could diverge from the profile database.
    this.jobs = {
      get: id => this.storage.get(id),
      values: () => this.storage.list().values(),
      get size() { return storage.jobs.count(); },
    };
  }

  save(job) {
    return this.storage.save({ ...job, updatedAt: new Date().toISOString() });
  }

  get(id) {
    if (!validId(id)) throw new Error("Invalid job ID");
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }
}
