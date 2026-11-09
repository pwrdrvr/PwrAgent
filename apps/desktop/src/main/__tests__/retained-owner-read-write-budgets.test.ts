import path from "node:path";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { StateDb } from "../storage/state-db";
import { RetainedOwnerThreadStore } from "../storage/retained-owner-thread-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { OwnerConformanceCodexTransport } from "./fixtures/owner-conformance-codex-transport";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/owner-conformance-codex-transport")).OwnerConformanceCodexTransport,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const budgetFile = "retained-owner-read-write-budgets.json";

it("confirms multiple imported native identities in one boundary transaction", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = retainedOwnerFixture(false, ["imported", "second"]);
  try {
    const confirmed = await measureSqliteWrites(() => f.retained.confirmNativeThreads(["imported", "second"]));
    expectSqliteWriteBudget({ budgetFile, scenario: "desktop-import-batch-confirmation", writes: confirmed.writes,
      note: "Two first positive native confirmations share one boundary transaction; no per-item commit or timer" });
    expect(f.retained.list()).toEqual([]);
  } finally { f.close(); vi.unstubAllEnvs(); }
});

it("budgets actual desktop native confirmation once and passive owner retention at zero commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const f = retainedOwnerFixture(false);
  const configPath = path.join(f.root, "config.toml");
  writeFileSync(configPath, "");
  const config = new DesktopConfigStore({ configPath });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  OwnerConformanceCodexTransport.reset();
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: f.overlay, configStore: config,
    retainedOwnerThreadStorage: f.retained, providerThreadSnapshotStore: null, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  try {
    const list = () => registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false, callerReason: "thread-id-lookup" });
    expect((await list()).map(thread => thread.id)).toEqual(["imported"]);
    OwnerConformanceCodexTransport.threads.set("imported", { id: "imported", name: "", preview: "", cwd: f.root, createdAt: 1, updatedAt: 2, turns: [] });
    const confirmation = await measureSqliteWrites(list);
    expect(confirmation.result.map(thread => thread.id)).toEqual(["imported"]);
    expect((await f.overlay.getThreadMetadata({ backend: "codex", threadId: "imported" }))?.nativeMembershipRetired).toBe(false);
    expectSqliteWriteBudget({ budgetFile, scenario: "desktop-import-native-confirmation", writes: confirmation.writes,
      note: "One first positive native observation of a pending fallback import; existing metadata port, one boundary commit, no native-name acknowledgement" });
    const repeated = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) await list();
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "desktop-confirmation-repeated", writes: repeated.writes,
      note: "Twenty repeated actual desktop native observations do not rewrite confirmed import metadata; zero commits" });
    OwnerConformanceCodexTransport.threads.clear();
    expect((await list()).map(thread => thread.id)).toEqual([]);
    f.jobs.save({ version: 1, id: "accepted", status: "completed", fingerprint: "immutable-input", threadId: "accepted-owner", turnId: "confirmed-turn",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" });
    const passive = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) expect(f.retained.list().map(thread => thread.id)).toEqual(["accepted-owner"]);
      for (let i = 0; i < 10; i++) {
        const reopened = StateDb.open(f.dbPath, { profileName: "fixture" });
        try { expect(new RetainedOwnerThreadStore(reopened, f.directory).list().map(thread => thread.id)).toEqual(["accepted-owner"]); }
        finally { reopened.close(); }
      }
      expect((await list()).map(thread => thread.id)).toEqual(["accepted-owner"]);
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "retained-owner-passive-reopen", writes: passive.writes,
      note: "1000 committed-provenance/job reads, ten storage reopens and an actual desktop owner list; zero commits and 0 MB/day" });
    expect(OwnerConformanceCodexTransport.requests.some(request => ["thread/start", "turn/start", "thread/read", "thread/resume"].includes(request.method))).toBe(false);
    expect(f.jobs.get("accepted")).toMatchObject({ fingerprint: "immutable-input", threadId: "accepted-owner", turnId: "confirmed-turn", status: "completed" });
  } finally { await registry.close(); await client.close(); config.dispose(); f.close(); vi.unstubAllEnvs(); }
});
