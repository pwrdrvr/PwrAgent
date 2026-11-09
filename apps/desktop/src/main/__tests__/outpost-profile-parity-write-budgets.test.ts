import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { measureSqliteWrites } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const budgetFile = "outpost-profile-parity-write-budgets.json";

it("budgets actual discovery and native-title boundaries without writes on unchanged navigation", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-parity-writes-")));
  const previous = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const overlay = new SqliteOverlayStore(db);
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const configPath = path.join(root, "config.toml");
  writeFileSync(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  const desktop = new DesktopBackendRegistry({ codexClient, overlayStore: overlay, configStore, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  try {
    let nativeName = "Native";
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = { workspace: root, store, onFailure(error: unknown) { throw error; },
      projects: { list: () => [{ path: root, label: "fixture" }] },
      codex: { listThreads: async ({ archived }: { archived: boolean }) => archived ? [] : [{ id: "thread", source: "codex", title: nativeName,
        titleSource: "explicit", projectKey: root, createdAt: 1, updatedAt: 2, linkedDirectories: [], summary: "Transient provider text" }],
      renameThread: async ({ name }: { name: string }) => { nativeName = name; return { threadId: "thread" }; } } };
    const backend = new HeadlessBackend(runtime, () => {});
    const discovery = await measureSqliteWrites(() => backend.initialize());
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-fresh-discovery", note: "One complete provider inventory boundary; setup, leases and adoption excluded", writes: discovery.writes });
    const rename = await measureSqliteWrites(() => backend.handle("renameThread", { threadId: "thread", name: "Outpost title" }));
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-native-rename", note: "Acknowledged native rename and title provenance in one canonical metadata commit", writes: rename.writes });
    // First changed inventory boundary is separate from passive reads.
    await backend.refreshThreads();
    await overlay.updateThreadMetadata({ backend: "codex", threadId: "thread" }, { title: { text: "Imported title", source: "derived" } });
    const imported = await measureSqliteWrites(() => backend.refreshThreads());
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-pending-title-discovery", note: "One imported owner title reaches the native provider, then one metadata acknowledgement and one complete inventory commit", writes: imported.writes });
    const unchanged = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) await backend.handle("listThreads");
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-unchanged-discovery", note: "1000 fresh provider listings and owner reads; transient provider fields are excluded before equality", writes: unchanged.writes });
    const event = { backend: "codex" as const, notification: { method: "thread/name/updated" as const,
      params: { threadId: "thread", threadName: "Desktop title", titleSource: "explicit" as const } } };
    const desktopTitle = await measureSqliteWrites(() => desktop.publishLocalEvent(event));
    expectSqliteWriteBudget({ budgetFile, scenario: "desktop-native-title", note: "Actual desktop name-event pipeline retains confirmed native title and provenance in one metadata commit", writes: desktopTitle.writes });
    const repeated = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) await desktop.publishLocalEvent(event);
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "desktop-repeated-native-title", note: "1000 identical title notifications reassert metadata without SQLite commits", writes: repeated.writes });
    expect((await overlay.getThreadMetadata({ backend: "codex", threadId: "thread" }))?.title)
      .toEqual({ text: "Desktop title", source: "explicit", nativeName: "Desktop title" });
  } finally {
    await desktop.close(); await codexClient.close(); configStore.dispose(); profile.close(); db.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
    else process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = previous;
  }
});
