import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

it("budgets first ACP worktree enrichment and zero-write repeated cache publication", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-acp-cache-")));
  const db = StateDb.open(path.join(root, "state.db"));
  const sessions = new AcpSessionStore(db);
  const cwd = path.join(root, ".worktrees", "member");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(cwd, ".codex", "environments"), { recursive: true });
  writeFileSync(path.join(cwd, ".codex", "environments", "environment.toml"), 'version = 1\nname = "Fixture"\n');
  sessions.upsertSession({ backendId: "acp:uninstalled", sessionId: "member", title: "Member", titleSource: "explicit",
    cwd, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" });
  const configPath = path.join(root, "config.toml");
  writeFileSync(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const desktop = new DesktopBackendRegistry({ codexClient, configStore, overlayStore: new SqliteOverlayStore(db), acpSessionStore: sessions,
    providerThreadSnapshotStore: new ProviderThreadSnapshotStore(db), discoverLocalAcpAgents: async () => [], messagingStore: null,
    pdfToolMcpServer: null, threadTitleGenerationService: null, acpWorktreeRepositoryResolver: async () => ({
      id: repo, path: repo, worktreePath: cwd, kind: "worktree", label: "repo" }) });
  const budgetFile = "acp-cache-enrichment-write-budgets.json";
  try {
    const cold = await measureSqliteWrites(() => desktop.listThreads({ callerReason: "navigation-snapshot" }));
    expect(cold.result[0]).toMatchObject({ linkedDirectories: [{ path: repo, worktreePath: cwd }], codexEnvironmentOptions: [{ name: "Fixture" }] });
    expectSqliteWriteBudget({ budgetFile, scenario: "first-acp-cache-enrichment", writes: cold.writes,
      note: "One existing first worktree mapping commit; 16480 WAL bytes (~1.648 MB/day at 100 newly resolved sessions); no timer" });
    const publisher = desktop as unknown as { publishRefreshedProviderThreadsToCache(refreshes: []): Promise<void> };
    const repeated = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) await publisher.publishRefreshedProviderThreadsToCache([]);
      for (let i = 0; i < 1000; i++) expect((await desktop.listThreads({ callerReason: "navigation-snapshot" }))[0])
        .toMatchObject({ codexEnvironmentOptions: [{ name: "Fixture" }] });
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "repeated-acp-cache-enrichment", writes: repeated.writes,
      note: "100 cache publications and 1000 cached reads retain directory/environment enrichment with zero SQLite writes (0 MB/day)" });
  } finally { await desktop.close(); await codexClient.close(); configStore.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
