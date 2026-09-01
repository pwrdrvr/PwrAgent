import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { StateDb } from "../state/state-db";
import {
  measureSqliteWrites,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("DesktopConfigStore", () => {
  it("serves immutable domain reads without filesystem or sqlite work", () => {
    const fixture = createFixture(`
[general.appearance]
theme = "dark"
density = "compact"
`);
    const store = fixture.createStore();
    const prepare = vi.spyOn(fixture.db.raw, "prepare");
    const readFile = vi.spyOn(fs, "readFileSync");
    const diagnostics = store.readDiagnostics();

    const general = store.read("general");
    const onboarding = store.read("onboarding");
    const providers = store.read("providers");

    expect(general.appearance).toMatchObject({
      theme: "dark",
      density: "compact",
    });
    expect(onboarding).toEqual({
      completed: true,
      completedSource: "migrated",
    });
    expect(providers.codex.validation.state).toBe("unknown");
    expect(Object.isFrozen(general)).toBe(true);
    expect(Object.isFrozen(general.appearance)).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(store.readDiagnostics()).toEqual(diagnostics);
  });

  it("retains the durable last-known-good snapshot after a malformed edit", () => {
    const fixture = createFixture(`
[general.appearance]
theme = "dark"
`);
    const store = fixture.createStore();
    fs.writeFileSync(fixture.configPath, "[general\nappearance = true\n", "utf8");

    store.reloadFromDisk("watch");

    expect(store.read("general").appearance.theme).toBe("dark");
    expect(store.fileStatus()).toMatchObject({
      kind: "invalid",
      serving: "last-known-good",
    });
    store.dispose();

    const restarted = fixture.createStore();
    expect(restarted.read("general").appearance.theme).toBe("dark");
    expect(restarted.fileStatus()).toMatchObject({
      kind: "invalid",
      serving: "last-known-good",
    });
  });

  it("notifies only subscribers whose domain changed", () => {
    const fixture = createFixture("[messaging]\nenabled = false\n");
    const store = fixture.createStore();
    const generalListener = vi.fn();
    const messagingListener = vi.fn();
    store.subscribe(["general"], generalListener);
    store.subscribe(["messaging"], messagingListener);
    fs.writeFileSync(fixture.configPath, "[messaging]\nenabled = true\n", "utf8");

    store.reloadFromDisk("watch");

    expect(generalListener).not.toHaveBeenCalled();
    expect(messagingListener).toHaveBeenCalledOnce();
    expect(messagingListener.mock.calls[0]?.[0]).toMatchObject({
      changedDomains: ["messaging"],
      values: { messaging: { enabled: true } },
    });
  });

  it("dedupes provider refreshes by provider fingerprint", async () => {
    const fixture = createFixture("");
    let resolveDiscovery: ((value: {
      candidates: readonly [];
      selectedCommand: string;
      selectedVersion: string;
    }) => void) | undefined;
    const discoverProvider = vi.fn(async () =>
      await new Promise<{
        candidates: readonly [];
        selectedCommand: string;
        selectedVersion: string;
      }>((resolve) => {
        resolveDiscovery = resolve;
      }),
    );
    const store = fixture.createStore({ discoverProvider });

    const first = store.refreshProvider("codex", "startup");
    const second = store.refreshProvider("codex", "explicit");
    expect(discoverProvider).toHaveBeenCalledOnce();
    resolveDiscovery?.({
      candidates: [],
      selectedCommand: "/opt/pwragent/codex",
      selectedVersion: "1.2.3",
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.validation.state).toBe("valid");
    expect(firstResult.lastKnownGood?.selectedCommand).toBe(
      "/opt/pwragent/codex",
    );

    const persisted = fixture.db.raw
      .prepare("SELECT payload FROM provider_discovery_snapshots WHERE provider_id = ?")
      .get("codex") as { payload: string };
    expect(persisted.payload).not.toContain("secret-value");
  });

  it("invalidates and refreshes only the provider whose config changed", async () => {
    const fixture = createFixture(`
[acp_agents.qwen]
cli_path = "/opt/qwen-one"
`);
    const discoverProvider = vi.fn(async ({ projection }) => ({
      candidates: [],
      selectedCommand: projection.configured.commandOverride,
      selectedVersion: "1.0.0",
    }));
    const store = fixture.createStore({ discoverProvider });
    await store.refreshProvider("qwen", "explicit");
    const codexFingerprint = store.read("providers").codex.dependencyFingerprint;
    fs.writeFileSync(
      fixture.configPath,
      "[acp_agents.qwen]\ncli_path = \"/opt/qwen-two\"\n",
      "utf8",
    );

    store.reloadFromDisk("self-write");

    await vi.waitFor(() => {
      expect(discoverProvider).toHaveBeenCalledTimes(2);
    });
    expect(
      discoverProvider.mock.calls.map(([call]) => call.provider),
    ).toEqual(["qwen", "qwen"]);
    expect(store.read("providers").qwen.lastKnownGood?.selectedCommand).toBe(
      "/opt/qwen-two",
    );
    expect(store.read("providers").codex.dependencyFingerprint).toBe(
      codexFingerprint,
    );
  });

  it("does not let a stale provider completion overwrite a newer fingerprint", async () => {
    const fixture = createFixture(`
[acp_agents.qwen]
cli_path = "/opt/qwen-one"
`);
    const pending: Array<{
      command: string | undefined;
      resolve: (value: {
        candidates: readonly [];
        selectedCommand: string | undefined;
      }) => void;
    }> = [];
    const discoverProvider = vi.fn(async ({ projection }) =>
      await new Promise<{
        candidates: readonly [];
        selectedCommand: string | undefined;
      }>((resolve) => {
        pending.push({
          command: projection.configured.commandOverride,
          resolve,
        });
      }),
    );
    const store = fixture.createStore({ discoverProvider });

    const staleRefresh = store.refreshProvider("qwen", "explicit");
    fs.writeFileSync(
      fixture.configPath,
      "[acp_agents.qwen]\ncli_path = \"/opt/qwen-two\"\n",
      "utf8",
    );
    store.reloadFromDisk("self-write");
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });

    const currentDiscovery = pending[1];
    const staleDiscovery = pending[0];
    if (!currentDiscovery || !staleDiscovery) {
      throw new Error("expected both provider discoveries to be pending");
    }
    currentDiscovery.resolve({
      candidates: [],
      selectedCommand: currentDiscovery.command,
    });
    await vi.waitFor(() => {
      expect(store.read("providers").qwen.lastKnownGood?.selectedCommand).toBe(
        "/opt/qwen-two",
      );
    });
    staleDiscovery.resolve({
      candidates: [],
      selectedCommand: staleDiscovery.command,
    });
    await staleRefresh;

    expect(store.read("providers").qwen.lastKnownGood?.selectedCommand).toBe(
      "/opt/qwen-two",
    );
  });

  it("does not discover providers or reread secrets for an ordinary update", () => {
    const fixture = createFixture("[messaging]\nenabled = false\n");
    const discoverProvider = vi.fn(async () => ({ candidates: [] }));
    const readSecretPresence = vi.fn(() => ({
      discordBotToken: {
        configured: true,
        source: "keychain" as const,
        writable: true,
      },
    }));
    const store = fixture.createStore({
      discoverProvider,
      readSecretPresence,
    });
    readSecretPresence.mockClear();
    fs.writeFileSync(
      fixture.configPath,
      "[messaging]\nenabled = true\n",
      "utf8",
    );

    store.reloadFromDisk("self-write");

    expect(store.read("messaging").enabled).toBe(true);
    expect(discoverProvider).not.toHaveBeenCalled();
    expect(readSecretPresence).not.toHaveBeenCalled();
  });

  it("repairs an invalid external edit without discarding the last good state", () => {
    const fixture = createFixture("[general.appearance]\ntheme = \"dark\"\n");
    const store = fixture.createStore();
    fs.writeFileSync(fixture.configPath, "[general\n", "utf8");
    store.reloadFromDisk("watch");
    expect(store.fileStatus().kind).toBe("invalid");

    fs.writeFileSync(
      fixture.configPath,
      "[general.appearance]\ntheme = \"light\"\n",
      "utf8",
    );
    store.reloadFromDisk("watch");

    expect(store.fileStatus().kind).toBe("valid");
    expect(store.read("general").appearance.theme).toBe("light");
  });

  it("observes an atomic external config replacement", async () => {
    const fixture = createFixture("[messaging]\nenabled = false\n");
    const store = fixture.createStore();
    store.startWatching();
    const replacement = `${fixture.configPath}.next`;
    fs.writeFileSync(replacement, "[messaging]\nenabled = true\n", "utf8");
    fs.renameSync(replacement, fixture.configPath);

    await vi.waitFor(() => {
      expect(store.read("messaging").enabled).toBe(true);
    });
  });

  it("keeps two store instances coherent through the shared config file", async () => {
    const fixture = createFixture("[messaging]\nenabled = false\n");
    const watcherCallbacks = new Set<() => void>();
    const createFileWatcher = vi.fn(({ onChange }: { onChange: () => void }) => {
      watcherCallbacks.add(onChange);
      return {
        close: () => {
          watcherCallbacks.delete(onChange);
        },
      };
    });
    const first = fixture.createStore({ createFileWatcher });
    const second = fixture.createStore({ createFileWatcher });
    first.startWatching();
    second.startWatching();
    fs.writeFileSync(fixture.configPath, "[messaging]\nenabled = true\n", "utf8");
    for (const onChange of watcherCallbacks) {
      onChange();
    }

    expect(first.read("messaging").enabled).toBe(true);
    expect(second.read("messaging").enabled).toBe(true);
  });

  it("aborts in-flight provider refreshes when disposed", async () => {
    const fixture = createFixture("");
    let observedSignal: AbortSignal | undefined;
    const discoverProvider = vi.fn(async ({ signal }) => {
      observedSignal = signal;
      return await new Promise<{ candidates: readonly [] }>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const store = fixture.createStore({ discoverProvider });
    const refresh = store.refreshProvider("codex", "startup");

    store.dispose();
    await refresh;

    expect(observedSignal?.aborted).toBe(true);
  });

  it("never serializes secret-presence details into durable config state", () => {
    const fixture = createFixture("[messaging]\nenabled = true\n");
    fixture.createStore({
      readSecretPresence: () => ({
        discordBotToken: {
          configured: false,
          source: "unset",
          unavailableReason: "secret-value-must-not-persist",
          writable: false,
        },
      }),
    });

    const payload = fixture.db.raw
      .prepare("SELECT payload FROM desktop_config_snapshots WHERE snapshot_key = ?")
      .pluck()
      .get("latest") as string;
    expect(payload).not.toContain("secret-value-must-not-persist");
    expect(payload).not.toContain("discordBotToken");
  });
});

describe("DesktopConfigStore write cost", () => {
  it("writes one durable row for one changed config revision", async () => {
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-config-budget-"));
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, "[messaging]\nenabled = false\n", "utf8");
    const db = StateDb.open(path.join(root, "state.db"));
    const store = new DesktopConfigStore({ configPath, stateDb: db });
    try {
      fs.writeFileSync(configPath, "[messaging]\nenabled = true\n", "utf8");
      resetSqliteWriteMetrics();
      const { writes } = await measureSqliteWrites(async () => {
        store.reloadFromDisk("self-write");
      });
      expectSqliteWriteBudget({
        note:
          "one atomic durable config publication per changed config revision; "
          + "ordinary domain reads write nothing",
        scenario: "config-store-config-revision",
        writes,
      });
    } finally {
      store.dispose();
      db.close();
      delete process.env[SQLITE_WRITE_METRICS_ENV];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes one provider row at a successful discovery boundary", async () => {
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-provider-budget-"));
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, "", "utf8");
    const db = StateDb.open(path.join(root, "state.db"));
    const store = new DesktopConfigStore({
      configPath,
      stateDb: db,
      discoverProvider: async () => ({
        candidates: [],
        selectedCommand: "/opt/pwragent/codex",
      }),
    });
    try {
      resetSqliteWriteMetrics();
      const { writes } = await measureSqliteWrites(async () => {
        await store.refreshProvider("codex", "startup");
      });
      expectSqliteWriteBudget({
        note:
          "one provider-scoped last-known-good publication per successful "
          + "discovery; refresh metadata remains in memory",
        scenario: "config-store-provider-refresh",
        writes,
      });
      resetSqliteWriteMetrics();
      const repeated = await measureSqliteWrites(async () => {
        await store.refreshProvider("codex", "explicit");
      });
      expect(repeated.writes.commits).toBe(0);
      expect(repeated.writes.statements).toBe(0);
    } finally {
      store.dispose();
      db.close();
      delete process.env[SQLITE_WRITE_METRICS_ENV];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createFixture(initialConfig: string): {
  configPath: string;
  createStore: (
    options?: Pick<
      ConstructorParameters<typeof DesktopConfigStore>[0],
      "createFileWatcher" | "discoverProvider" | "readSecretPresence"
    >,
  ) => DesktopConfigStore;
  db: StateDb;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-config-store-"));
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, initialConfig, "utf8");
  const db = StateDb.open(path.join(root, "state.db"));
  const stores: DesktopConfigStore[] = [];
  cleanups.push(() => {
    for (const store of stores) {
      store.dispose();
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    configPath,
    db,
    createStore: (options) => {
      const store = new DesktopConfigStore({
        configPath,
        stateDb: db,
        ...options,
      });
      stores.push(store);
      return store;
    },
  };
}
