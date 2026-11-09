import type Database from "better-sqlite3";
import {
  buildPullRequestStatusKey,
  resolvePullRequestIdentity,
  type PrSummary,
  type ThreadOverlayState,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";

/** Runs inside the v63 upgrade transaction, before any PR observers start. */
export function migratePrReferenceIdentities(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]).map((row) => row.name));
  if (tables.has("threads")) migrateDetachedReferences(db);
  if (tables.has("pr_status_watches")) migrateWatches(db);
}

function migrateDetachedReferences(db: Database.Database): void {
  const update = db.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?");
  const rows = db.prepare("SELECT thread_id, payload FROM threads").all() as {
    thread_id: string; payload: string;
  }[];
  for (const row of rows) {
    let overlay: ThreadOverlayState;
    try { overlay = JSON.parse(row.payload) as ThreadOverlayState; } catch { continue; }
    if (!overlay || typeof overlay !== "object") continue;
    const before = JSON.stringify(overlay);
    const replacements = new Map<string, Set<string>>();
    for (const pr of overlay.detachedPrs ?? []) {
      const oldKey = buildPullRequestStatusKey({
        provider: pr.provider, org: pr.org, repo: pr.repo, number: pr.number,
      });
      const targets = replacements.get(oldKey) ?? new Set<string>();
      targets.add(buildPullRequestStatusKey(pr));
      replacements.set(oldKey, targets);
    }
    if (overlay.detachedPrKeys) {
      overlay.detachedPrKeys = [...new Set(overlay.detachedPrKeys.flatMap((key) =>
        [...(replacements.get(key.trim().toLowerCase()) ?? [key])],
      ))].sort();
    }
    const normalize = (pr: PrSummary): PrSummary => ({ ...pr, ...resolvePullRequestIdentity(pr) });
    if (overlay.prs) overlay.prs = overlay.prs.map(normalize);
    if (overlay.detachedPrs) overlay.detachedPrs = overlay.detachedPrs.map(normalize);
    const payload = JSON.stringify(overlay);
    if (payload !== before) update.run(payload, row.thread_id);
  }
}

type WatchRow = {
  watch_id: string;
  backend: string;
  thread_id: string;
  pr_key: string;
  head_sha: string;
  status: string;
  created_at: number;
  payload: string;
};

function migrateWatches(db: Database.Database): void {
  const rows = db.prepare("SELECT watch_id, backend, thread_id, pr_key, head_sha, status, created_at, payload FROM pr_status_watches")
    .all() as WatchRow[];
  const watches = rows.flatMap((row) => {
    let watch: ThreadPullRequestWatchSummary;
    try { watch = JSON.parse(row.payload) as ThreadPullRequestWatchSummary; } catch { return []; }
    if (!watch || typeof watch.prUrl !== "string") return [];
    const identity = resolvePullRequestIdentity({
      provider: "", org: "", repo: "", number: 0, url: watch.prUrl,
    });
    if (!identity.org || !identity.repo || !identity.number) return [];
    return [{ row, watch: { ...watch, prKey: buildPullRequestStatusKey(identity), prNumber: identity.number } }];
  });
  // A corrected row can coexist with its legacy row. Keep an in-flight lease
  // first, otherwise the oldest active watch, and merge notification interests.
  watches.sort((a, b) => Number(b.row.status === "dispatching") - Number(a.row.status === "dispatching")
    || a.row.created_at - b.row.created_at || a.row.watch_id.localeCompare(b.row.watch_id));
  const active = new Map<string, (typeof watches)[number]>();
  for (const entry of watches) {
    if (entry.row.status !== "watching" && entry.row.status !== "dispatching") continue;
    const key = JSON.stringify([entry.row.backend, entry.row.thread_id, entry.watch.prKey, entry.row.head_sha]);
    const existing = active.get(key);
    if (!existing) {
      active.set(key, entry);
      continue;
    }
    existing.watch.notifyOn = [...new Set([...existing.watch.notifyOn, ...entry.watch.notifyOn])];
    existing.watch.failureHandledByAutoFix &&= entry.watch.failureHandledByAutoFix;
    entry.row.status = "superseded";
    db.prepare("UPDATE pr_status_watches SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL WHERE watch_id = ?")
      .run(entry.row.watch_id);
  }
  // Vacate old keys before assigning destinations so swaps cannot hit the
  // active-target unique index. Both phases are in the upgrade transaction.
  for (const { row, watch } of watches) {
    if (row.pr_key !== watch.prKey) {
      db.prepare("UPDATE pr_status_watches SET pr_key = ? WHERE watch_id = ?")
        .run(`identity-migration:${row.watch_id}`, row.watch_id);
    }
  }
  const update = db.prepare("UPDATE pr_status_watches SET pr_key = ?, notify_on_success = ?, notify_on_failure = ?, payload = ? WHERE watch_id = ?");
  for (const { row, watch } of watches) {
    const payload = JSON.stringify(watch);
    if (row.pr_key !== watch.prKey || payload !== row.payload) {
      update.run(watch.prKey, Number(watch.notifyOn.includes("success")), Number(watch.notifyOn.includes("failure")), payload, row.watch_id);
    }
  }
}
