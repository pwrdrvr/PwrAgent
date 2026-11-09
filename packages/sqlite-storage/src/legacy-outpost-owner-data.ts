import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { patchOwnerThreadMetadata, type OwnerThreadMetadataPatch, type OwnerThreadRecord } from "@pwragent/owner-core/thread-storage";
import type { OwnerJobRecord } from "@pwragent/owner-core/owner-job-storage";
import { SqliteOverlayStore } from "./overlay-store-sqlite";
import { projectOwnerJob, SqliteOwnerJobStore, withOwnerDataDurability } from "./owner-job-store";
import type { StateDb } from "./state-db";

const IMPORT_KEY = "outpost_owner_json_import_v1";
const BACKUP_DIRECTORY = "legacy-owner-backup-v1";
const FIELDS = ["archived", "model", "reasoningEffort", "serviceTier", "fastMode", "executionModeUpdatedAt",
  "reasoningEffortsByModel", "modelMigrationRevision", "modelSettingsManuallyUpdatedAt", "createdAt", "updatedAt", "cwd",
  "pinnedRank", "seenAt", "seenUpdatedAt", "archivedAt", "restoredAt", "archiveRetentionStartedAt", "subthreadOrder", "subthreadsCollapsed", "messagingFileTools", "nativeMembershipRetired"] as const;
export type OutpostThread = Record<string, unknown> & { id: string };

/** The old host projection maps to the same canonical owner facts desktop uses. */
export function outpostThreadMetadata(thread: OutpostThread): OwnerThreadMetadataPatch {
  const patch: OwnerThreadMetadataPatch = {
    executionMode: thread.sandbox === "workspace-write" ? "auto" : thread.sandbox === "danger-full-access" ? "full-access" : "default",
    title: typeof thread.title === "string" ? {
      text: thread.titleSource === "fallback" && thread.title === "New outpost thread" ? "Untitled thread" : thread.title,
      source: (thread.titleSource ?? "fallback") as NonNullable<OwnerThreadRecord["title"]>["source"],
      ...(typeof thread.titleNativeName === "string" ? { nativeName: thread.titleNativeName } : {}),
    } : undefined,
    parent: thread.parentThreadId !== undefined ? { backend: (thread.parentThreadBackend ?? "codex") as "codex",
      threadId: thread.parentThreadId as string,
      ...(thread.parentThreadInstanceId !== undefined ? { instanceId: thread.parentThreadInstanceId as string } : {}) } : undefined,
  };
  for (const field of FIELDS) if (thread[field] !== undefined) Object.assign(patch, { [field]: structuredClone(thread[field]) });
  return patch;
}

export function outpostThreadProjection(record: OwnerThreadRecord): OutpostThread {
  const thread: OutpostThread = { id: record.threadId, title: record.title?.text, titleSource: record.title?.source, titleNativeName: record.title?.nativeName,
    sandbox: record.executionMode === "auto" ? "workspace-write" : record.executionMode === "full-access" ? "danger-full-access" : "read-only",
    parentThreadId: record.parent?.threadId, parentThreadBackend: record.parent?.backend, parentThreadInstanceId: record.parent?.instanceId };
  for (const field of FIELDS) if (record[field] !== undefined) thread[field] = structuredClone(record[field]);
  if (record.archivedAt !== undefined || record.archiveRetentionStartedAt !== undefined || record.restoredAt !== undefined) {
    thread.archived = Math.max(record.archivedAt ?? -Infinity, record.archiveRetentionStartedAt ?? -Infinity)
      > (record.restoredAt ?? -Infinity);
  }
  return thread;
}

type Identity = { version: 1; workspace: string; codexHome: string };
type Manifest = { version: 1; identity: Identity; files: Array<{ name: string; sha256: string }> };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Existing adopted profiles carry their provenance in the durable manifest
 * and byte-exact backup. Reading it neither reimports nor repairs metadata. */
export function readCommittedOutpostImport(db: StateDb, directory: string): { threadIds: Set<string>; workspace?: string } {
  const saved = db.getMeta(IMPORT_KEY);
  if (!saved) return { threadIds: new Set() };
  const manifest: Manifest = JSON.parse(saved);
  if (manifest.version !== 1 || manifest.identity?.version !== 1 || !Array.isArray(manifest.files)
    || typeof manifest.identity.workspace !== "string") throw new Error("Invalid committed owner import");
  const file = manifest.files.find(file => file.name === "threads.json");
  if (!file) return { threadIds: new Set(), workspace: manifest.identity.workspace };
  const bytes = read(path.join(directory, BACKUP_DIRECTORY, "threads.json"));
  if (!bytes || hash(bytes) !== file.sha256) throw new Error("Legacy owner backup is missing or changed");
  const data = JSON.parse(bytes.toString("utf8"));
  if (data.version !== 1 || !Array.isArray(data.threads)
    || data.threads.some((thread: OutpostThread) => typeof thread?.id !== "string" || !thread.id || thread.id.length > 256)) {
    throw new Error("Invalid committed owner import identities");
  }
  return { threadIds: new Set(data.threads.map((thread: OutpostThread) => thread.id)), workspace: manifest.identity.workspace };
}

function read(file: string): Buffer | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? stat.uid)) throw new Error(`Expected an owned regular legacy file: ${file}`);
    return fs.readFileSync(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? stat.uid)
    || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error(`Expected a private directory owned by this user: ${directory}`);
}

function durableFile(file: string, bytes: Buffer): void {
  const prior = read(file);
  if (prior) {
    if (!prior.equals(bytes)) throw new Error(`Legacy backup differs from source: ${file}`);
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } catch (error) { try { fs.unlinkSync(temporary); } catch { /* Preserve storage refusal. */ } throw error; }
}

/** Backups precede one database transaction; retirement follows its durable marker. */
export function adoptOutpostOwnerData(db: StateDb, directory: string, identity: Identity): {
  threads: SqliteOverlayStore; jobs: SqliteOwnerJobStore;
} {
  privateDirectory(directory);
  privateDirectory(path.join(directory, "jobs"));
  const threads = new SqliteOverlayStore(db);
  const jobs = new SqliteOwnerJobStore(db);
  const legacyNames = (): string[] => [
    ...(read(path.join(directory, "threads.json")) ? ["threads.json"] : []),
    ...fs.readdirSync(path.join(directory, "jobs")).filter(name => name.endsWith(".json")).map(name => `jobs/${name}`),
  ].sort();
  const identityFile = path.join(directory, "identity.json");
  const identityBytes = read(identityFile);
  const names = legacyNames();
  const previous = db.getMeta(IMPORT_KEY);
  if (identityBytes) {
    if (JSON.stringify(JSON.parse(identityBytes.toString("utf8"))) !== JSON.stringify(identity)) throw new Error("This headless state belongs to a different workspace or Codex home");
  } else {
    if (names.length || jobs.count() || previous) throw new Error("Headless identity is missing for an existing job registry");
    durableFile(identityFile, Buffer.from(JSON.stringify(identity) + "\n"));
  }
  let manifest: Manifest;
  if (previous) {
    manifest = JSON.parse(previous);
    if (manifest.version !== 1 || JSON.stringify(manifest.identity) !== JSON.stringify(identity)) throw new Error("This headless state belongs to a different workspace or Codex home");
    if (!Array.isArray(manifest.files) || manifest.files.some(file => typeof file?.name !== "string"
      || !/^(threads\.json|jobs\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json)$/.test(file.name)
      || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Invalid legacy owner import manifest");
    if (names.some(name => !manifest.files.some(file => file.name === name))) throw new Error("Legacy owner JSON appeared after SQLite adoption; refusing to replay it");
  } else {
    const files = names.map(name => ({ name, bytes: read(path.join(directory, name))! }));
    const importedThreads: OutpostThread[] = [];
    const importedJobs: OwnerJobRecord[] = [];
    const ids = new Set<string>();
    for (const file of files) {
      const data = JSON.parse(file.bytes.toString("utf8"));
      if (file.name === "threads.json") {
        if (data.version !== 1 || !Array.isArray(data.threads)) throw new Error("Invalid headless thread registry");
        for (const thread of data.threads) {
          if (typeof thread?.id !== "string" || !thread.id || thread.id.length > 256 || ids.has(thread.id)) throw new Error("Invalid headless thread registry identity");
          ids.add(thread.id);
          importedThreads.push(thread);
        }
      } else {
        const job = projectOwnerJob(data);
        if (file.name !== `jobs/${job.id}.json`) throw new Error(`Invalid headless job record: ${file.name}`);
        importedJobs.push(job);
      }
    }
    manifest = { version: 1, identity, files: files.map(file => ({ name: file.name, sha256: hash(file.bytes) })) };
    if (files.length) {
      const backup = path.join(directory, BACKUP_DIRECTORY);
      privateDirectory(backup);
      privateDirectory(path.join(backup, "jobs"));
      durableFile(path.join(backup, "identity.json"), read(identityFile)!);
      for (const file of files) durableFile(path.join(backup, file.name), file.bytes);
      durableFile(path.join(backup, "manifest.json"), Buffer.from(JSON.stringify(manifest) + "\n"));
      syncDirectory(directory);
    }
    withOwnerDataDurability(db, () => db.raw.transaction(() => {
      for (const thread of importedThreads) {
        const ref = { backend: "codex" as const, threadId: thread.id };
        const current = threads.readOwnerThreadMetadata(ref);
        const imported = patchOwnerThreadMetadata(undefined, ref, outpostThreadMetadata(thread));
        // Existing canonical facts win; missing facts are filled from legacy.
        threads.mergeOwnerThreadMetadata(ref, { ...imported, ...current });
      }
      for (const job of importedJobs) {
        const current = jobs.get(job.id);
        if (current && JSON.stringify(current) !== JSON.stringify(job)) throw new Error(`Conflicting headless job identity: ${job.id}`);
        jobs.save(job);
        if (job.threadId && !threads.readOwnerThreadMetadata({ backend: "codex", threadId: job.threadId })) {
          threads.mergeOwnerThreadMetadata({ backend: "codex", threadId: job.threadId }, outpostThreadMetadata({
            id: job.threadId, title: `Thread ${job.threadId.slice(0, 8)}`, titleSource: "fallback", createdAt: job.createdAt ? Date.parse(job.createdAt) : 0,
            messagingFileTools: job.messagingFileTools === true, cwd: job.cwd || identity.workspace, sandbox: job.sandbox, model: job.model,
          }));
        }
      }
      jobs.recover();
      db.setMeta(IMPORT_KEY, JSON.stringify(manifest));
    }).immediate());
  }
  // A restart after any partial retirement reuses the committed import. It
  // never reads the backup as a new registry or overwrites later owner edits.
  for (const file of manifest.files) {
    const source = path.join(directory, file.name);
    const bytes = read(source);
    if (!bytes) continue;
    if (hash(bytes) !== file.sha256) throw new Error(`Legacy owner JSON changed after import: ${file.name}`);
    const backup = read(path.join(directory, BACKUP_DIRECTORY, file.name));
    if (!backup || hash(backup) !== file.sha256) throw new Error(`Legacy owner backup is missing or changed: ${file.name}`);
    fs.unlinkSync(source);
    syncDirectory(path.dirname(source));
  }
  jobs.recover();
  return { threads, jobs };
}
