import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
    const directory = openSync(path.dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    // Preserve the original storage failure even if cleanup also fails.
    try { unlinkSync(temporary); } catch { /* A renamed file is already gone. */ }
    throw error;
  }
}

export class JobStore {
  constructor(directory, identity) {
    this.directory = path.join(directory, "jobs");
    privateDirectory(this.directory);
    const files = readdirSync(this.directory).filter((file) => file.endsWith(".json"));
    const identityFile = path.join(directory, "identity.json");
    try {
      if (JSON.stringify(JSON.parse(readFileSync(identityFile, "utf8"))) !== JSON.stringify(identity)) {
        throw new Error("This headless state belongs to a different workspace or Codex home");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (files.length) throw new Error("Headless identity is missing for an existing job registry", { cause: error });
      atomicJson(identityFile, identity);
    }
    this.jobs = new Map();
    for (const file of files) {
      const job = JSON.parse(readFileSync(path.join(this.directory, file), "utf8"));
      if (job.version !== 1 || !validId(job.id) || file !== `${job.id}.json`
        || (!ACTIVE.has(job.status) && !TERMINAL.has(job.status))) {
        throw new Error(`Invalid headless job record: ${file}`);
      }
      this.jobs.set(job.id, job);
      if (ACTIVE.has(job.status)) {
        this.save({ ...job, status: "unknown", reason: "Daemon stopped before a terminal outcome was recorded; no work was replayed" });
      }
    }
  }

  save(job) {
    const saved = { ...job, updatedAt: new Date().toISOString() };
    atomicJson(path.join(this.directory, `${job.id}.json`), saved);
    this.jobs.set(job.id, saved);
    return saved;
  }

  get(id) {
    if (!validId(id)) throw new Error("Invalid job ID");
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }
}
