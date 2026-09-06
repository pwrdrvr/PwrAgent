import { expect, it, vi } from "vitest";
import { FederationActivityLedger } from "../federation/federation-activity-ledger";
import { FederationTransferLedger } from "../federation/federation-transfer-ledger";
import { measureSqliteWrites, readSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

it("adds zero SQLite writes for transfer accounting, snapshots and reset", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  try {
    // Verify that instrumentation is live, rather than accepting an absent collector as zero.
    expect(readSqliteWriteMetrics()).toBeDefined();
    const ledger = new FederationActivityLedger(0);
    const transfers = new FederationTransferLedger();
    const { writes } = await measureSqliteWrites(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const info = { peerId: "peer", localInstanceId: "local", direction: "received" as const,
          byteCount: 116, dataByteCount: 100, at: index * 1_000,
          envelope: { kind: "response" as const, sourceInstanceId: "peer", targetInstanceId: "local" } };
        transfers.record(info);
        ledger.record(info);
        if (index % 100 === 0) { ledger.snapshot(index * 1_000); transfers.snapshot("peer"); }
      }
      ledger.reset(10_000_000);
      ledger.snapshot(10_000_000);
    });
    expectSqliteWriteBudget({ scenario: "federation-activity-monitor",
      note: "10,000 transfers, local snapshots and reset: in-memory only; 0 MB/day added WAL",
      writes });
    expect(writes.walBytes).toBe(0);
  } finally { db.close(); vi.unstubAllEnvs(); }
});
