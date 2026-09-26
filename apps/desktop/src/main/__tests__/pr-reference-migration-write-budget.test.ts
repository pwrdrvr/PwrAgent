import { afterEach, expect, it, vi } from "vitest";
import { migratePrReferenceIdentities } from "../state/migrate-pr-reference-identities";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("rekeys 100 detach references and watches in one upgrade commit with no recurring writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-pr-identity-budget-");
  const db = StateDb.open(temp.dbPath);
  try {
    db.raw.transaction(() => {
      for (let number = 1; number <= 100; number += 1) {
        const prKey = `github.com/fork/project#${number}`;
        const prUrl = `https://github.com/upstream/project/pull/${number}`;
        db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:thread-${number}`, JSON.stringify({
          backend: "codex", threadId: `thread-${number}`,
          detachedPrKeys: [prKey],
          detachedPrs: [{ provider: "github.com", org: "fork", repo: "project", number, url: prUrl, state: "pending" }],
        }));
        db.raw.prepare(`INSERT INTO pr_status_watches(
          watch_id, backend, thread_id, pr_key, head_sha, notify_on_success, notify_on_failure,
          status, attempt_count, created_at, updated_at, payload
        ) VALUES (?, 'codex', ?, ?, 'head', 1, 1, 'watching', 0, 1, 1, ?)`)
          .run(`watch-${number}`, `thread-${number}`, prKey, JSON.stringify({
            watchId: `watch-${number}`, backend: "codex", threadId: `thread-${number}`,
            prKey, prUrl, prNumber: number, headSha: "head", createdAt: 1,
            notifyOn: ["success", "failure"], failureHandledByAutoFix: false,
          }));
      }
    })();
    const migrate = db.raw.transaction(() => migratePrReferenceIdentities(db.raw));
    const initial = await measureSqliteWrites(() => migrate());
    expect(initial.writes.commits).toBe(1);
    expectSqliteWriteBudget({
      scenario: "pr-reference-identity-upgrade",
      writes: initial.writes,
      note: "100 detach references and 100 watches rekeyed in one upgrade transaction; runs once per profile, 0 MB/day recurring writes",
    });
    const repeated = await measureSqliteWrites(() => migratePrReferenceIdentities(db.raw));
    expect(repeated.writes.commits).toBe(0);
    expectSqliteWriteBudget({
      scenario: "pr-reference-identity-upgrade-unchanged",
      writes: repeated.writes,
      note: "Revisiting 100 corrected detach references and watches is read-only; 0 commits and 0 MB/day recurring writes",
    });
  } finally {
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});
