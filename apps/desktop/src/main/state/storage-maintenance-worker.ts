import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { StateDb } from "./state-db.js";
import {
  claimStorageMaintenance, compactStorage, eligibleStorageThreads, fenceStorageRetention, observeStorageArchive, readStorageMaintenance,
  storageDetailStatements, writeStorageMaintenance,
  type StorageThreadIdentity,
} from "./storage-maintenance.js";
import type { StorageMaintenanceStatus } from "../../shared/storage-maintenance.js";

type Request = { dbPath: string; historyEnabled: boolean; archived: StorageThreadIdentity[]; active: StorageThreadIdentity[] };
const sleep = () => new Promise((resolve) => setTimeout(resolve, 5));
let started = false;
process.parentPort?.on("message", (event: { data: Request }) => {
  if (started) return;
  started = true;
  void run(event.data).then(() => setImmediate(() => process.exit(0))).catch(() => {
    process.parentPort?.postMessage({ phase: "error", message: "Storage optimization could not finish. Your remaining data is intact; PwrAgent will try again on a later startup." });
    setImmediate(() => process.exit(1));
  });
});

async function run(request: Request): Promise<void> {
  const state = StateDb.open(request.dbPath);
  const db = state.raw;
  db.pragma("busy_timeout=100");
  db.pragma("wal_autocheckpoint=0");
  let status: StorageMaintenanceStatus = {
    phase: "cleanup", historyEnabled: request.historyEnabled,
    beforeBytes: (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number),
    completedThreads: 0, eligibleThreads: 0,
  };
  const send = (patch: Partial<StorageMaintenanceStatus>) => {
    status = { ...status, ...patch };
    process.parentPort?.postMessage(status);
  };
  try {
    const admitted = claimStorageMaintenance(db);
    if (!admitted) { send({ phase: "deferred", message: "Storage was already checked today." }); return; }
    const activeKeys = new Set(request.active.map((id) => JSON.stringify([id.backend, id.threadId])));
    const archivedThreads = request.archived.filter((id) => !activeKeys.has(JSON.stringify([id.backend, id.threadId])));
    // Conservatively start unknown archive ages now. Positive active evidence
    // clears receipts; absent/disconnected providers never do.
    for (const [identities, archived] of [[request.active, false], [archivedThreads, true]] as const) {
      for (let i = 0; i < identities.length; i += 100) {
        db.transaction(() => {
          for (const id of identities.slice(i, i + 100)) {
            const now = Date.now();
            const verifiedArchiveTime = archived && Number.isFinite(id.archivedAt) && id.archivedAt! > 0 && id.archivedAt! <= now;
            observeStorageArchive(db, id.backend, id.threadId, archived, verifiedArchiveTime ? id.archivedAt! : now, verifiedArchiveTime);
          }
        }).immediate();
        await sleep();
      }
    }
    const eligible = request.historyEnabled ? eligibleStorageThreads(db, archivedThreads, Date.now()) : [];
    send({ eligibleThreads: eligible.length });
    for (const identity of eligible) {
      let fenced = false;
      for (const operation of storageDetailStatements(db, identity)) {
        while (true) {
          const walPath = request.dbPath + "-wal";
          const bytesBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
          const startedAt = performance.now();
          const changes = db.transaction(() => {
            // An observed unarchive from another connection cancels this thread.
            if (!eligibleStorageThreads(db, [identity], Date.now()).length) return 0;
            if (!fenced) fenceStorageRetention(db, identity);
            return operation.statement.run(...operation.parameters).changes;
          }).immediate();
          fenced = true;
          if (!changes) break;
          const bytesWritten = fs.statSync(walPath).size - bytesBefore;
          if (performance.now() - startedAt > 8 || bytesWritten > 1024 * 1024) {
            const limitIndex = operation.parameters.length - 1;
            operation.parameters[limitIndex] = Math.max(1, Math.floor(Number(operation.parameters[limitIndex]) / 2));
          }
          await sleep();
          // Avoid building an unbounded WAL behind a pinned reader.
          if (fs.existsSync(request.dbPath + "-wal") && fs.statSync(request.dbPath + "-wal").size > 64 * 1024 * 1024) {
            const checkpoint = db.pragma("wal_checkpoint(PASSIVE)") as Array<{ log: number; checkpointed: number }>;
            if (checkpoint[0].log > checkpoint[0].checkpointed) {
              send({ phase: "deferred", message: "Another connection is holding older data open. Cleanup will continue on a later startup." });
              return;
            }
            db.pragma("wal_checkpoint(TRUNCATE)");
          }
        }
      }
      send({ completedThreads: status.completedThreads + 1 });
      await sleep();
    }
    state.cleanupExpired(Date.now(), 0);
    const available = fs.statfsSync(request.dbPath);
    const required = status.beforeBytes * 3;
    if (available.bavail * available.bsize < required) {
      send({ phase: "deferred", message: "Cleanup finished, but there is not enough free disk space to compact safely. PwrAgent will try again later." });
      return;
    }
    send({ phase: "vacuum" });
    await sleep();
    const afterBytes = compactStorage(db);
    db.transaction(() => writeStorageMaintenance(db, {
      ...readStorageMaintenance(db), completedAt: Date.now(), ownerPid: undefined,
    })).immediate();
    send({ phase: "complete", afterBytes });
  } finally {
    state.close();
  }
}
