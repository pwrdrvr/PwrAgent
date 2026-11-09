import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const budgetFile = "outpost-provider-read-write-budgets.json";

it("budgets Claude inventory publication, legacy scrubbing and passive multi-provider reads separately", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-provider-writes-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  let profile: ReturnType<typeof openOutpostProfileRuntime> | undefined;
  try {
    const inventory = new ProviderThreadSnapshotStore(db);
    const thread = { source: "claude" as const, id: "00000000-0000-4000-8000-000000000001", title: "Claude native", titleSource: "explicit" as const, linkedDirectories: [] };
    const publication = await measureSqliteWrites(() => inventory.replace({ backend: "claude", observedAt: 1, threads: [thread] }));
    expectSqliteWriteBudget({ budgetFile, scenario: "claude-inventory-publication", note: "One complete Claude provider list replaces one scrubbed inventory row", writes: publication.writes });
    db.raw.prepare("UPDATE provider_thread_snapshots SET payload = ? WHERE backend = ?")
      .run(JSON.stringify([{ ...thread, summary: "private legacy preview" }]), "claude");
    const scrub = await measureSqliteWrites(() => inventory.list());
    expectSqliteWriteBudget({ budgetFile, scenario: "claude-legacy-inventory-scrub", note: "First read of one older Claude inventory removes transient text in one commit", writes: scrub.writes });
    expect(scrub.result[0]?.threads[0]).not.toHaveProperty("summary");
    new AcpSessionStore(db).upsertSession({ backendId: "acp:removed", sessionId: "native-acp", title: "Actual ACP metadata",
      cwd: root, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" });
    await new ClaudeSessionStore(path.join(root, "claude")).save({ cwd: root, thread });
    profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const owner = new HeadlessBackend({ workspace: root, store, onFailure(error: unknown) { throw error; },
      projects: { list: () => [] }, codex: { listModels: async () => [] } }, () => {});
    const ref = { backend: "claude", threadId: "00000000-0000-4000-8000-000000000001" };
    const passive = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) {
        expect((await owner.handle("resolveThread", ref)).thread.source).toBe("claude");
        expect((await owner.handle("resolveThread", { backend: "acp:removed", threadId: "native-acp" })).thread.title).toBe("Actual ACP metadata");
        await owner.handle("listThreads", { backend: "all" });
        await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref });
        await owner.handle("lookupArchivedThreads", { backend: "claude", threadIds: [ref.threadId] });
        await owner.handle("getNavigationQueryPage", { protocol: 2, backend: "claude", consumer: "remote-window", query: { kind: "lens", lens: "inbox" } });
      }
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "retained-provider-passive-reads", note: "1000 rounds of retained profile inventory, resolve, detail, archive and navigation reads", writes: passive.writes });
  } finally { profile?.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it("budgets changed non-Codex native name events and makes no repeated or undiscovered-provider writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-provider-events-")));
  const db = StateDb.open(path.join(root, "state.db"));
  const inventory = new ProviderThreadSnapshotStore(db);
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const configPath = path.join(root, "config.toml");
  writeFileSync(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  const owner = new DesktopBackendRegistry({ codexClient: client, configStore, overlayStore: new SqliteOverlayStore(db),
    providerThreadSnapshotStore: inventory, messagingStore: null, threadTitleGenerationService: null,
    pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  try {
    for (const backend of ["claude", "acp:fixture"] as const) {
      inventory.replace({ backend, observedAt: 1, threads: [{ id: "00000000-0000-4000-8000-000000000001", source: backend, title: "Before", titleSource: "explicit", linkedDirectories: [] }] });
      const event = { backend, notification: { method: "thread/name/updated" as const, params: { threadId: "00000000-0000-4000-8000-000000000001", threadName: "After", titleSource: "derived" as const } } };
      const changed = await measureSqliteWrites(() => owner.publishLocalEvent(event));
      expectSqliteWriteBudget({ budgetFile, scenario: `${backend}-native-name-event`, note: "One acknowledged native title updates one retained provider row without changing inventory membership freshness", writes: changed.writes });
      expect(inventory.list().find(snapshot => snapshot.backend === backend)).toMatchObject({ observedAt: 1, threads: [{ title: "After", titleSource: "derived" }] });
      const repeat = await measureSqliteWrites(async () => {
        for (let i = 0; i < 1000; i++) await owner.publishLocalEvent(event);
        await owner.publishLocalEvent({ ...event, notification: { ...event.notification, params: { ...event.notification.params, threadId: "undiscovered" } } });
      });
      expectSqliteWriteBudget({ budgetFile, scenario: `${backend}-unchanged-native-name-events`, note: "1000 identical native title events and one undiscovered identity do not write or manufacture inventory", writes: repeat.writes });
    }
  } finally { await owner.close(); await client.close(); configStore.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
