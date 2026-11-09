import { projectRetainedOwnerThread, retainsOwnerThread, type RetainedOwnerThreadStorage } from "@pwragent/owner-core/retained-owner-thread-storage";
import type { OwnerJobRecord } from "@pwragent/owner-core/owner-job-storage";
import { SqliteOverlayStore } from "./overlay-store-sqlite";
import { SqliteOwnerJobStore } from "./owner-job-store";
import { readCommittedOutpostImport } from "./legacy-outpost-owner-data";
import type { StateDb } from "./state-db";

/** A read projection over existing metadata/jobs and the committed import proof. */
export class RetainedOwnerThreadStore implements RetainedOwnerThreadStorage {
  private readonly threads: SqliteOverlayStore;
  private readonly jobs: SqliteOwnerJobStore;

  constructor(private readonly db: StateDb, private readonly headlessDirectory: string) {
    this.threads = new SqliteOverlayStore(db);
    this.jobs = new SqliteOwnerJobStore(db);
  }

  list() {
    const imported = readCommittedOutpostImport(this.db, this.headlessDirectory);
    const jobs = new Map<string, OwnerJobRecord>();
    for (const job of this.jobs.list()) {
      if (!job.threadId) continue;
      const previous = jobs.get(job.threadId);
      if (!previous || (job.createdAt ?? "") > (previous.createdAt ?? "")) jobs.set(job.threadId, job);
    }
    const ids = new Set([...imported.threadIds, ...jobs.keys()]);
    if (!ids.size) return [];
    const records = new Map(this.threads.readOwnerThreadMetadataList().filter(record => record.backend === "codex")
      .map(record => [record.threadId, record]));
    return [...ids].filter(id => retainsOwnerThread(records.get(id), imported.threadIds.has(id), jobs.get(id)))
      .map(id => projectRetainedOwnerThread(id, records.get(id), jobs.get(id), imported.workspace));
  }

  confirmNativeThreads(threadIds: readonly string[]): void {
    const imported = readCommittedOutpostImport(this.db, this.headlessDirectory).threadIds;
    const candidates = [...new Set(threadIds)].filter(id => imported.has(id));
    if (!candidates.length) return;
    // The current fact is read inside the transaction. A late positive walk
    // cannot overwrite a retirement committed after that walk was admitted.
    this.db.raw.transaction(() => {
      for (const threadId of candidates) {
        const identity = { backend: "codex" as const, threadId };
        const record = this.threads.readOwnerThreadMetadata(identity);
        if (record && record.nativeMembershipRetired === undefined && record.title?.nativeName === undefined) {
          this.threads.mergeOwnerThreadMetadata(identity, { nativeMembershipRetired: false });
        }
      }
    })();
  }
}
