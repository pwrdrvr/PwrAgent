import {
  createOverlayStoreMock,
  MockBackendClient,
  createAcpAgentStoreMock,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ManagedCodexSelectionChange } from "../settings/desktop-settings-service";
import { DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS, type CodexAppServerRecycleSettings } from "../codex-app-server/app-server-recycle-policy";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

describe("DesktopBackendRegistry", () => {
  it("reconnects idle Codex when managed runtime selection changes", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const resetAppServerRestarts = vi.fn(() => {
      // The breaker clears only once the old binary's process is gone.
      expect(codexClient.closeCallCount).toBe(1);
    });
    Object.assign(codexClient, { resetAppServerRestarts });
    let selectionListener:
      | ((change: ManagedCodexSelectionChange) => void)
      | undefined;
    const stopWatching = vi.fn();
    const markSwitchComplete = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      markManagedCodexRuntimeSwitchComplete: markSwitchComplete,
      overlayStore: createOverlayStoreMock(),
      watchManagedCodexRuntime: (listener) => {
        selectionListener = listener;
        return stopWatching;
      },
    });

    selectionListener?.({ enabled: true, reason: "availability" });
    await vi.waitFor(() => expect(codexClient.closeCallCount).toBe(1));
    expect(markSwitchComplete).toHaveBeenCalledOnce();
    expect(resetAppServerRestarts).toHaveBeenCalledExactlyOnceWith("Codex runtime changed");

    await registry.close();
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it("disconnects idle Codex after its configured path changes", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const resetAppServerRestarts = vi.fn();
    Object.assign(codexClient, { resetAppServerRestarts });
    const markSwitchComplete = vi.fn();
    const registry = createDesktopBackendRegistry({
      codexClient,
      markManagedCodexRuntimeSwitchComplete: markSwitchComplete,
      overlayStore: createOverlayStoreMock(),
    });

    await registry.invalidateProviderRuntimeSelections({
      acp: false,
      codex: true,
    });

    expect(codexClient.closeCallCount).toBe(1);
    expect(resetAppServerRestarts).toHaveBeenCalledOnce();
    expect(markSwitchComplete).not.toHaveBeenCalled();
    await registry.close();
  });

  it("defers managed Codex reconnect until active turns are idle", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const markSwitchComplete = vi.fn();
    let selectionListener:
      | ((change: ManagedCodexSelectionChange) => void)
      | undefined;
    const registry = createDesktopBackendRegistry({
      codexClient,
      markManagedCodexRuntimeSwitchComplete: markSwitchComplete,
      overlayStore: createOverlayStoreMock(),
      watchManagedCodexRuntime: (listener) => {
        selectionListener = listener;
        return () => undefined;
      },
    });
    registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");

    selectionListener?.({ enabled: true, reason: "availability" });
    await Promise.resolve();
    expect(codexClient.closeCallCount).toBe(0);
    expect(markSwitchComplete).not.toHaveBeenCalled();

    registryModules(registry).turnState.unregisterTurn("codex:thread-1:turn-1");
    await expect(
      registryModules(registry).codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange(),
    ).resolves.toBe(true);
    expect(codexClient.closeCallCount).toBe(1);
    expect(markSwitchComplete).toHaveBeenCalledOnce();

    await registry.close();
  });

  it("recycles the idle Codex app server only while no Codex work is active", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const recycle = vi.fn(async (_params: {
      settings: CodexAppServerRecycleSettings;
      isQuiescent: () => boolean;
    }) => ({ kind: "not-running" as const }));
    Object.assign(codexClient, { maybeRecycleIdleAppServer: recycle });
    let settings: CodexAppServerRecycleSettings = {
      ...DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS,
      idleMs: 60_000,
    };
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      resolveCodexAppServerRecycleSettings: () => settings,
    });
    const runtime = registryModules(registry).codexRuntimeSupervisor as unknown as {
      codexBackgroundTerminals: Map<string, unknown[]>;
    };

    // A turn makes the owner's answer "not quiescent", so the client records
    // a busy check instead of recycling.
    registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");
    await registryModules(registry).codexRuntimeSupervisor.checkCodexAppServerRecycle();
    expect(recycle).toHaveBeenCalledOnce();
    const { settings: passed, isQuiescent } = recycle.mock.calls[0]![0];
    expect(passed).toEqual(settings);
    expect(isQuiescent()).toBe(false);

    registryModules(registry).turnState.unregisterTurn("codex:thread-1:turn-1");
    expect(isQuiescent()).toBe(true);
    // A command still running after its turn ended keeps the server.
    runtime.codexBackgroundTerminals.set("thread-1", [{ processId: "p-1" }]);
    expect(isQuiescent()).toBe(false);
    runtime.codexBackgroundTerminals.clear();

    settings = { ...settings, enabled: false };
    await registryModules(registry).codexRuntimeSupervisor.checkCodexAppServerRecycle();
    expect(recycle).toHaveBeenCalledOnce();

    settings = { ...settings, enabled: true };
    vi.useFakeTimers();
    try {
      registry.startCodexAppServerRecycler();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(recycle).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(recycle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    await registry.close();
    expect((registryModules(registry).codexRuntimeSupervisor as unknown as { codexAppServerRecycleTimer?: unknown })
      .codexAppServerRecycleTimer).toBeUndefined();
    await registryModules(registry).codexRuntimeSupervisor.checkCodexAppServerRecycle();
    expect(recycle).toHaveBeenCalledTimes(2);
  });

  it("releases idle Codex threads only when the registry tracks no work for them", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const unsubscribe = vi.fn(async (_params: {
      idleMs: number;
      isThreadBusy: (threadId: string) => boolean;
    }) => [] as string[]);
    Object.assign(codexClient, { unsubscribeIdleThreads: unsubscribe });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      codexThreadIdleUnsubscribeMs: 123_000,
    });
    const runtime = registryModules(registry).codexRuntimeSupervisor as unknown as {
      codexBackgroundTerminals: Map<string, unknown[]>;
      liveCodexToolItemsByThread: Map<string, Map<string, unknown>>;
    };
    const subAgents = registryModules(registry).subAgentMonitorService as unknown as {
      liveCodexNativeSubAgentUsage: Map<string, Map<string, unknown>>;
    };

    await registryModules(registry).codexRuntimeSupervisor.unsubscribeIdleCodexThreads();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const { idleMs, isThreadBusy } = unsubscribe.mock.calls[0]![0];
    expect(idleMs).toBe(123_000);
    expect(isThreadBusy("thread-1")).toBe(false);

    registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");
    expect(isThreadBusy("thread-1")).toBe(true);
    expect(isThreadBusy("thread-10")).toBe(false);
    registryModules(registry).turnState.unregisterTurn("codex:thread-1:turn-1");

    // A command still running after its turn ended dies with an unload.
    runtime.codexBackgroundTerminals.set("thread-1", [{ processId: "p-1" }]);
    expect(isThreadBusy("thread-1")).toBe(true);
    runtime.codexBackgroundTerminals.clear();
    runtime.liveCodexToolItemsByThread.set("thread-1", new Map());
    expect(isThreadBusy("thread-1")).toBe(true);
    runtime.liveCodexToolItemsByThread.clear();
    // A parent whose turn ended while its sub-agent workers still run.
    subAgents.liveCodexNativeSubAgentUsage.set("thread-1", new Map([["worker-1", {}]]));
    expect(isThreadBusy("thread-1")).toBe(true);
    subAgents.liveCodexNativeSubAgentUsage.clear();
    expect(isThreadBusy("thread-1")).toBe(false);

    await registry.close();
    expect(isThreadBusy("thread-1")).toBe(true);
    await registryModules(registry).codexRuntimeSupervisor.unsubscribeIdleCodexThreads();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("invalidates only the provider changed by an external config reload", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-backend-registry-"),
    );
    const configPath = path.join(tempRoot, "config.toml");
    await writeFile(
      configPath,
      "[acp_agents.gemini]\ncli_path = \"/path/gemini-one\"\n",
    );
    const configStore = new DesktopConfigStore({ configPath });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      configStore,
      discoverLocalAcpAgents: async () => [],
    });
    const invalidate = vi
      .spyOn(registry, "invalidateProviderRuntimeSelections")
      .mockResolvedValue();

    try {
      await writeFile(
        configPath,
        "[acp_agents.gemini]\ncli_path = \"/path/gemini-two\"\n",
      );
      configStore.reloadFromDisk("watch");

      await vi.waitFor(() => {
        expect(invalidate).toHaveBeenCalledExactlyOnceWith({
          acp: true,
          acpRegistryIds: ["gemini"],
          codex: false,
        });
      });
      await registry.synchronizeProviderRuntimeSelections();
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps Codex available while applying model provider changes at idle", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-import-"));
    const configPath = path.join(tempRoot, "config.toml");
    await writeFile(configPath, "");
    const configStore = new DesktopConfigStore({ configPath });
    configStore.recordProviderDiscovery("codex", {
      candidates: [],
      selectedCommand: "/opt/pwragent/codex",
      selectedVersion: "0.162.1",
    });
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({
      codexClient,
      configStore,
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      discoverLocalAcpAgents: async () => [],
    });
    const bonsai = {
      id: "bonsai",
      name: "Bonsai (local)",
      baseUrl: "http://127.0.0.1:18080/v1",
      local: true,
      models: ["fixture.gguf"],
    };
    try {
      for (const providers of [[bonsai], [{ ...bonsai, baseUrl: "http://127.0.0.1:18081/v1" }], []]) {
        const closesBefore = codexClient.closeCallCount;
        registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");
        await configStore.write({ models: { codex: { providers } } }, ["providers"]);
        await registry.synchronizeProviderRuntimeSelections();
        expect(codexClient.closeCallCount).toBe(closesBefore);
        expect((await registry.listBackends({ includeUnavailable: true })).backends
          .find((backend) => backend.kind === "codex")).toMatchObject({ available: true });
        registryModules(registry).turnState.registeredTurnKeys().forEach(key => registryModules(registry).turnState.unregisterTurn(key));
        await expect(registryModules(registry).codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange()).resolves.toBe(true);
        expect(codexClient.closeCallCount).toBe(closesBefore + 1);
        expect((await registry.listBackends({ includeUnavailable: true })).backends
          .find((backend) => backend.kind === "codex")).toMatchObject({ available: true });
      }
      await configStore.write({ models: { codex: { providers: [bonsai] } } }, ["providers"]);
      await registry.synchronizeProviderRuntimeSelections();
      const closesBefore = codexClient.closeCallCount;
      await configStore.write({ models: { codex: { providers: [{ ...bonsai, models: ["other.gguf"] }] } } }, ["providers"]);
      await registry.synchronizeProviderRuntimeSelections();
      expect(codexClient.closeCallCount).toBe(closesBefore);
    } finally {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates only Codex and waits for idle when a profile overlay changes", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-backend-registry-"),
    );
    const configPath = path.join(tempRoot, "config.toml");
    await writeFile(
      configPath,
      `[models.codex]\nconfig_overrides = ['model="fixture-one"']\n`,
    );
    const configStore = new DesktopConfigStore({ configPath });
    const codexClient = new MockBackendClient({});
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      acpAgentStore: createAcpAgentStoreMock([]),
      configStore,
      discoverLocalAcpAgents: async () => [],
    });
    const invalidate = vi.spyOn(registry, "invalidateProviderRuntimeSelections");
    registryModules(registry).turnState.registerTurn("codex:thread-1:turn-1");

    try {
      await writeFile(
        configPath,
        `[models.codex]\nconfig_overrides = ['model="fixture-two"']\n`,
      );
      configStore.reloadFromDisk("watch");

      await vi.waitFor(() => {
        expect(invalidate).toHaveBeenCalledExactlyOnceWith({
          acp: false,
          acpRegistryIds: [],
          codex: true,
        });
      });
      await registry.synchronizeProviderRuntimeSelections();
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(codexClient.closeCallCount).toBe(0);
      registryModules(registry).turnState.unregisterTurn("codex:thread-1:turn-1");
      await expect(registryModules(registry).codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange()).resolves.toBe(true);
      expect(codexClient.closeCallCount).toBe(1);
    } finally {
      await registry.close();
      configStore.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
