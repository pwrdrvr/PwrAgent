import { ThreadTitleGenerationService } from "@pwragent/owner-core/thread-title-generation-service";
import { mkdirSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopBackendRegistry } from "../../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../../app-server/backend-registry";
import { CodexAppServerClient } from "../../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../../settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../../state/overlay-store-sqlite";
import { StateDb } from "../../state/state-db";
import { AcpAgentStore } from "../../storage/acp-agent-store";
import { AcpSessionStore } from "../../storage/acp-session-store";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../../storage/desktop-overlay-store";
import { ProviderThreadSnapshotStore } from "../../storage/provider-thread-snapshot-store";
import { RetainedOwnerThreadStore } from "../../storage/retained-owner-thread-store";
import { OwnerConformanceCodexTransport } from "../fixtures/owner-conformance-codex-transport";
import { createTempStateDb } from "../sqlite-test-utils";

type RegistryOptions = NonNullable<Parameters<typeof createDesktopBackendRegistry>[0]>;

export type DesktopOwnerFixtureOptions = {
  /** Names the temp workspace and state directories. */
  tempPrefix: string;
  runtimeInstanceId: string;
  /**
   * A persistent profile root: the workspace, state database and the Codex
   * fixture's thread records live under it and survive close, so a second
   * owner can start on the same profile.
   */
  profileRoot?: string;
  /** Seeds ACP state before the registry starts; also wires the ACP stores. */
  prepareAcp?: (db: StateDb, workspace: string) => Promise<void>;
  claudeOptions?: (workspace: string) => RegistryOptions["claudeBackendOptions"];
  /** Titles generated through the Codex fixture's helper threads. */
  protocolHelperTitle?: string;
  /** Ignored when `protocolHelperTitle` is set. */
  threadTitleGenerationService?: RegistryOptions["threadTitleGenerationService"];
  /** Defaults to whether `profileRoot` is set. */
  providerThreadSnapshots?: boolean;
  /** Defaults to whether `profileRoot` is set. */
  retainedOwnerThreads?: boolean;
};

export type DesktopOwnerFixture = {
  registry: DesktopBackendRegistry;
  codexClient: CodexAppServerClient;
  overlayStore: SqliteOverlayStore;
  db: StateDb;
  workspace: string;
  /** Holds the state database and config.toml. */
  tempDir: string;
  /** Closes the registry, its client and stores, then removes temp directories. */
  close(): Promise<void>;
};

/**
 * Desktop's real owner as the main-process suites build it: BackendRegistry
 * from the production wiring, the real Codex client on the owner conformance
 * Codex fixture, and a real state database and overlay store. The calling
 * suite must `vi.mock("../codex-app-server/stdio-transport")` with its Codex
 * fixture, since Vitest hoists mocks per file.
 */
export async function startDesktopOwnerFixture(options: DesktopOwnerFixtureOptions): Promise<DesktopOwnerFixture> {
  const { profileRoot, prepareAcp, claudeOptions, protocolHelperTitle } = options;
  OwnerConformanceCodexTransport.reset();
  OwnerConformanceCodexTransport.helperTitle = protocolHelperTitle;
  const workspace = profileRoot ? path.join(profileRoot, "w") : await realpath(await mkdtemp(path.join(os.tmpdir(), `${options.tempPrefix}-`)));
  const { dbPath, tempDir } = profileRoot
    ? { dbPath: path.join(profileRoot, "profiles/t/state/state.db"), tempDir: path.join(profileRoot, "desktop") }
    : createTempStateDb(`${options.tempPrefix}-db-`);
  if (profileRoot) {
    for (const dir of [workspace, tempDir, path.join(profileRoot, "f")]) mkdirSync(dir, { recursive: true });
    OwnerConformanceCodexTransport.recordsFile = path.join(profileRoot, "f/fixture-threads.json");
  }
  const db = StateDb.open(dbPath, profileRoot ? { profileName: "t" } : undefined);
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const overlayStore = new SqliteOverlayStore(db);
  await prepareAcp?.(db, workspace);
  setDesktopOverlayStoreForTests(overlayStore);
  // Desktop lists Codex once discovery has selected an executable. The
  // transport fixture stands in for that executable.
  const configPath = path.join(tempDir, "config.toml");
  await writeFile(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const providerThreadSnapshots = options.providerThreadSnapshots ?? Boolean(profileRoot);
  const retainedOwnerThreads = options.retainedOwnerThreads ?? Boolean(profileRoot);
  const retainedRoot = profileRoot ? path.join(profileRoot, "profiles/t/state/headless") : path.join(tempDir, "headless");
  const registry = createDesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
    ...(providerThreadSnapshots ? { providerThreadSnapshotStore: new ProviderThreadSnapshotStore(db) } : {}),
    ...(retainedOwnerThreads ? { retainedOwnerThreadStorage: new RetainedOwnerThreadStore(db, retainedRoot) } : {}),
    ...(prepareAcp ? { acpAgentStore: new AcpAgentStore(db), acpSessionStore: new AcpSessionStore(db) } : {}),
    ...(claudeOptions ? { claudeBackendOptions: claudeOptions(workspace) } : {}),
    threadTitleGenerationService: protocolHelperTitle
      ? new ThreadTitleGenerationService({ generators: { codex: codexClient } })
      : options.threadTitleGenerationService ?? null,
    pdfToolMcpServer: null, runtimeInstanceId: options.runtimeInstanceId,
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  return {
    registry, codexClient, overlayStore, db, workspace, tempDir,
    close: async () => {
      await registry.close();
      await codexClient.close();
      resetDesktopOverlayStoreForTests();
      configStore.dispose();
      db.close();
      if (!profileRoot) {
        await rm(workspace, { recursive: true, force: true });
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}
