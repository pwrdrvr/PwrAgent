import {
  createPdfMcpServerMock,
  createOverlayStoreMock,
  MockBackendClient,
  createKimiAcpRegistry,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION } from "@pwragent/shared/contracts/messaging-tools";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
} from "@pwragent/shared/contracts/mcp-connections";
import type { McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

describe("DesktopBackendRegistry", () => {
  it("does not create transport-less PwrSnap disable entries", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const readConfiguredMcpServerNames = vi.fn(async () => ["pwrsnap"]);
    Object.assign(codexClient, { readConfiguredMcpServerNames });
    const registerBridge = vi.fn(async () => ({
      server: {
        name: "pwrsnap",
        command: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
        args: ["/app/mcp-connection-bridge.js"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PWRAGENT_MCP_CONNECTION_SOCKET: "/tmp/pwragent.sock",
          PWRAGENT_MCP_CONNECTION_TOKEN: "local-grant",
        },
      },
      bindThread: vi.fn(),
      revoke: vi.fn(),
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: { registerBridge },
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.startThread({
      backend: "codex",
      mcpConnectionIds: [PWRSNAP_MCP_CONNECTION_ID],
    });

    expect(readConfiguredMcpServerNames).toHaveBeenCalledWith({
      cwd: "/tmp/pwragent-scratch",
    });
    const mcpServers = (
      codexClient.lastStartThreadParams!.config as {
        mcp_servers?: Record<string, unknown>;
      }
    )?.mcp_servers;
    expect(mcpServers?.pwrsnap).toEqual({ enabled: false });
    expect(mcpServers).not.toHaveProperty("pwragent_pwrsnap");

    await registry.close();
  });

  it("revokes a PwrSnap bridge when Codex thread creation fails", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    vi.spyOn(codexClient, "startThread").mockRejectedValueOnce(
      new Error("Codex thread creation failed"),
    );
    const revoke = vi.fn();
    const registerBridge = vi.fn(async () => ({
      server: {
        name: "pwrsnap",
        command: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
        args: ["/app/mcp-connection-bridge.js"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PWRAGENT_MCP_CONNECTION_SOCKET: "/tmp/pwragent.sock",
          PWRAGENT_MCP_CONNECTION_TOKEN: "local-grant",
        },
      },
      bindThread: vi.fn(),
      revoke,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: { registerBridge },
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await expect(
      registry.startThread({
        backend: "codex",
        mcpConnectionIds: [PWRSNAP_MCP_CONNECTION_ID],
      }),
    ).rejects.toThrow("Codex thread creation failed");

    expect(registerBridge).toHaveBeenCalledWith("pwrsnap", undefined, undefined, "codex");
    expect(revoke).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("explains Codex's rejected PwrSnap MCP transport without implying PwrSnap was down", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    vi.spyOn(codexClient, "startThread").mockRejectedValueOnce(
      new Error(
        "json-rpc error (-32600): failed to load configuration: invalid transport\nin `mcp_servers.pwragent_pwrsnap`",
      ),
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: {
        registerBridge: async () => ({
          server: {
            name: "pwrsnap",
            command: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
            args: ["/app/mcp-connection-bridge.js"],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              PWRAGENT_MCP_CONNECTION_SOCKET: "/tmp/pwragent.sock",
              PWRAGENT_MCP_CONNECTION_TOKEN: "local-grant",
            },
          },
          bindThread: vi.fn(),
          revoke: vi.fn(),
        }),
      },
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await expect(
      registry.startThread({
        backend: "codex",
        mcpConnectionIds: [PWRSNAP_MCP_CONNECTION_ID],
      }),
    ).rejects.toThrow(
      "PwrSnap was not contacted: Codex rejected PwrAgent's temporary MCP configuration. Update PwrAgent and retry the thread.",
    );

    await registry.close();
  });

  it("names PwrGit, not PwrSnap, when Codex rejects a PwrGit-only MCP transport", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    vi.spyOn(codexClient, "startThread").mockRejectedValueOnce(
      new Error(
        "json-rpc error (-32600): failed to load configuration: invalid transport\nin `mcp_servers.pwragent_pwrgit`",
      ),
    );
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: {
        registerBridge: async () => ({
          server: {
            name: "pwrgit",
            command: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
            args: ["/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp.mjs", "serve"],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              PWRGIT_MCP_SESSION_TOKEN: "pgmcp_token",
            },
          },
          bindThread: vi.fn(),
          revoke: vi.fn(),
        }),
      },
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await expect(
      registry.startThread({
        backend: "codex",
        mcpConnectionIds: [PWRGIT_MCP_CONNECTION_ID],
      }),
    ).rejects.toThrow(
      "PwrGit was not contacted: Codex rejected PwrAgent's temporary MCP configuration.",
    );

    await registry.close();
  });

  it("refuses to start a thread that enabled a connection this runtime cannot serve", async () => {
    // A known id with no service behind it must not be dropped as "unknown":
    // that starts the thread without the app the operator switched on.
    const codexClient = new MockBackendClient({ threads: [] });
    const startThread = vi.spyOn(codexClient, "startThread");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: null,
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await expect(
      registry.startThread({
        backend: "codex",
        mcpConnectionIds: [PWRGIT_MCP_CONNECTION_ID],
      }),
    ).rejects.toThrow("MCP connections are unavailable in this PwrAgent runtime.");

    expect(startThread).not.toHaveBeenCalled();
    await registry.close();
  });

  it("refuses the same way for a remote connection this runtime cannot serve", async () => {
    // The guard used to be `isMcpConnectionId`, which matches only the two
    // built-in ids -- so every remote connection took the "unknown id" branch
    // and was dropped with a warning, starting the turn without the server
    // the operator selected.
    const codexClient = new MockBackendClient({ threads: [] });
    const startThread = vi.spyOn(codexClient, "startThread");
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: null,
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await expect(
      registry.startThread({
        backend: "codex",
        mcpConnectionIds: ["datadog"],
      }),
    ).rejects.toThrow("MCP connections are unavailable in this PwrAgent runtime.");

    expect(startThread).not.toHaveBeenCalled();
    await registry.close();
  });

  it("routes selected PwrGit through the managed gateway", async () => {
    const codexClient = new MockBackendClient({ threads: [] });
    const registerBridge = vi.fn(async () => ({
      server: { name: "pwrgit", command: process.execPath, args: ["bridge.js"], env: {} },
      bindThread: vi.fn(), revoke: vi.fn(),
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      mcpConnectionService: { registerBridge },
      createScratchProjectDirectory: async () => "/tmp/pwragent-scratch",
    });

    await registry.startThread({
      backend: "codex",
      mcpConnectionIds: [PWRGIT_MCP_CONNECTION_ID],
    });

    expect(registerBridge).toHaveBeenCalledWith("pwrgit", undefined, undefined, "codex");
    const servers = (codexClient.lastStartThreadParams!.config as { mcp_servers: Record<string, unknown> }).mcp_servers;
    expect(Object.keys(servers)[0]).toMatch(/^pwragent_pwrgit_/u);
    expect(Object.values(servers)).toMatchObject([{ command: process.execPath }]);
    await registry.close();
  });

  describe("MCP connections selected for new threads", () => {
    function mcpConnection(
      overrides: Partial<McpConnectionStatus> & { id: string },
    ): McpConnectionStatus {
      return {
        displayName: overrides.id,
        serverUrl: `https://${overrides.id}.example/mcp`,
        authMode: "oauth",
        kind: "remote",
        enabled: true,
        selectForNewThreads: true,
        configured: true,
        state: "ready",
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
      };
    }

    function registryWith(connections: () => McpConnectionStatus[]) {
      const listConnections = vi.fn(async () => connections());
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({
          initializeResult: { methods: ["thread/start"] },
        }),
        overlayStore: createOverlayStoreMock(),
        mcpConnectionService: {
          registerBridge: vi.fn(),
          listConnections,
        },
      });
      const ensure = async (
        options?: Parameters<typeof registry.ensureDirectoryLaunchpad>[1],
      ) => (await registry.ensureDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        directoryKind: "directory",
        directoryLabel: "Repo A",
        directoryPath: "/repo-a",
      }, options)).launchpad;
      return { ensure, listConnections, registry };
    }

    function threadRegistry() {
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "thread/list", "turn/start"] },
        threads: [{
          id: "parent-thread",
          title: "Parent",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          updatedAt: 1,
        }],
      });
      const overlayStore = createOverlayStoreMock();
      const listConnections = vi.fn(async () => [
        mcpConnection({ id: "datadog" }),
        mcpConnection({ id: "rovo" }),
        mcpConnection({ id: "optional", selectForNewThreads: false }),
        mcpConnection({ id: "parked", enabled: false }),
        mcpConnection({ id: "unconfigured", configured: false }),
        mcpConnection({ id: "disconnected", state: "disconnected" }),
        mcpConnection({ id: "expired", state: "reauthorization_required" }),
      ]);
      const bindThread = vi.fn();
      const registerBridge = vi.fn(async (connectionId: string) => ({
        server: { name: connectionId, command: "/fixture/mcp-bridge", args: [], env: {} },
        bindThread,
        revoke: vi.fn(),
      }));
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore,
        mcpConnectionService: { registerBridge, listConnections },
        createScratchProjectDirectory: async () => "/tmp/pwragent-mcp-defaults",
        threadTitleGenerationService: null,
      });
      onTestFinished(() => registry.close());
      return { registry, codexClient, overlayStore, listConnections, registerBridge, bindThread };
    }

    it.each(["direct", "messaging", "handoff"] as const)(
      "selects and registers defaults before a %s thread starts",
      async (route) => {
        const { registry, codexClient, overlayStore, registerBridge, bindThread } = threadRegistry();
        if (route === "handoff") {
          await registry.publishLocalEvent({
            backend: "codex",
            notification: {
              method: "turn/started",
              params: { threadId: "parent-thread", turnId: "parent-turn", turn: { id: "parent-turn" } },
            },
          });
          const response = await codexClient.emitRequest({
            method: "item/tool/call",
            params: {
              threadId: "parent-thread", turnId: "parent-turn", callId: "handoff", requestId: "handoff",
              namespace: "pwragent", tool: "handoff_task",
              arguments: { task: "Check canary health", title: "Canary", workspaceMode: "none" },
            },
          } as AppServerPendingRequestNotification);
          expect(response).toMatchObject({ success: true });
        } else if (route === "messaging") {
          await new DesktopMessagingBackendBridge(registry).startThread({ backend: "codex" });
        } else {
          await registry.startThread({ backend: "codex" });
        }

        expect(registerBridge.mock.calls.slice(0, 2).map(([id]) => id)).toEqual(["datadog", "rovo"]);
        expect(registerBridge).toHaveBeenCalledTimes(route === "handoff" ? 4 : 2);
        expect(bindThread).toHaveBeenCalledWith("thread-1");
        const servers = Object.values(codexClient.lastStartThreadParams?.config?.mcp_servers ?? {});
        expect(servers).toEqual([
          expect.objectContaining({ command: "/fixture/mcp-bridge", enabled: true }),
          expect.objectContaining({ command: "/fixture/mcp-bridge", enabled: true }),
        ]);
        await expect(overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
          .resolves.toMatchObject({ mcpConnectionIds: ["datadog", "rovo"] });
      },
    );

    it.each([{ ids: [] }, { ids: ["optional"] }])("preserves an explicit selection $ids at thread creation", async ({ ids }) => {
      const { registry, overlayStore, listConnections, registerBridge } = threadRegistry();
      await registry.startThread({ backend: "codex", mcpConnectionIds: ids });

      expect(listConnections).not.toHaveBeenCalled();
      expect(registerBridge.mock.calls.map(([id]) => id)).toEqual(ids);
      const overlay = await overlayStore.getThreadOverlayState({ backend: "codex", threadId: "thread-1" });
      expect(overlay?.mcpConnectionIds ?? []).toEqual(ids);
    });

    it("passes the defaults to an ACP session before it starts", async () => {
      const { listConnections, registerBridge } = threadRegistry();
      const overlayStore = createOverlayStoreMock();
      const { registry, acpClient, acpBackendId } = createKimiAcpRegistry({
        overlayStore,
        mcpConnectionService: { listConnections, registerBridge },
      });
      onTestFinished(() => registry.close());

      const result = await registry.startThread({ backend: acpBackendId });

      expect(registerBridge.mock.calls.map(([id]) => id)).toEqual(["datadog", "rovo"]);
      expect(acpClient.startSession).toHaveBeenCalledWith(expect.objectContaining({
        additionalMcpRegistration: expect.objectContaining({
          servers: [
            expect.objectContaining({ name: "datadog" }),
            expect.objectContaining({ name: "rovo" }),
          ],
        }),
      }));
      await expect(overlayStore.getThreadOverlayState({ backend: acpBackendId, threadId: result.threadId }))
        .resolves.toMatchObject({ mcpConnectionIds: ["datadog", "rovo"] });
    });

    it.each(["error", "timeout"] as const)("starts without defaults when their read ends in %s", async (failure) => {
      vi.useFakeTimers();
      try {
        const { registry, listConnections, registerBridge } = threadRegistry();
        listConnections.mockImplementationOnce(() => failure === "error"
          ? Promise.reject(new Error("owner unavailable"))
          : new Promise<McpConnectionStatus[]>(() => undefined));
        const started = registry.startThread({ backend: "codex" });
        await vi.waitFor(() => expect(listConnections).toHaveBeenCalled());
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(2_000);

        await expect(started).resolves.toMatchObject({ threadId: "thread-1" });
        expect(registerBridge).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("persists the default selection once per new thread", async () => {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      const temp = createTempStateDb("pwragent-mcp-defaults-");
      const db = StateDb.open(temp.dbPath);
      const persisted = new SqliteOverlayStore(db);
      onTestFinished(() => {
        db.close();
        removeTempStateDbDir(temp.tempDir);
        vi.unstubAllEnvs();
      });
      const { registry, overlayStore } = threadRegistry();
      // Measure the added persistence through the real store; other creation
      // writes already exist and remain outside this selection's budget.
      vi.spyOn(overlayStore, "setThreadMcpConnectionIds")
        .mockImplementation((request) => persisted.setThreadMcpConnectionIds(request));

      const { writes } = await measureSqliteWrites(async () => {
        await registry.startThread({ backend: "codex" });
      });

      expectSqliteWriteBudget({
        scenario: "new-thread-mcp-default-selection",
        note: "Persist two default MCP ids together once at thread creation, with no writes per connection or streamed event. At 100 new threads/day this adds approximately 1.6 MB/day of WAL and no idle writes.",
        writes,
      });
      await expect(persisted.getThreadOverlayState({ backend: "codex", threadId: "thread-1" }))
        .resolves.toMatchObject({ mcpConnectionIds: ["datadog", "rovo"] });
    });

    it("seeds a new draft with the defaults a thread could actually use", async () => {
      const { ensure, registry } = registryWith(() => [
        mcpConnection({ id: "datadog" }),
        mcpConnection({ id: "linear", selectForNewThreads: false }),
        // Marked for new threads but withheld from every thread: `enabled`
        // is the outer gate and wins.
        mcpConnection({ id: "parked", enabled: false }),
        mcpConnection({ id: "expired", state: "reauthorization_required" }),
      ]);

      const launchpad = await ensure();

      expect(launchpad.mcpConnectionIds).toEqual(["datadog"]);
      expect(launchpad.mcpConnectionIdsFromDefaults).toBe(true);

      await registry.close();
    });

    it("follows the defaults until the operator edits the selection", async () => {
      let connections = [mcpConnection({ id: "datadog" })];
      const { ensure, registry } = registryWith(() => connections);

      expect((await ensure()).mcpConnectionIds).toEqual(["datadog"]);

      // A draft is kept per directory until it is sent. A default changed in
      // Settings in the meantime has to reach it -- including one the operator
      // has started typing into, since the prompt is not the selection.
      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: { prompt: "look at the failing spans" },
      });
      connections = [
        mcpConnection({ id: "datadog" }),
        mcpConnection({ id: "linear" }),
      ];
      expect((await ensure()).mcpConnectionIds).toEqual(["datadog", "linear"]);

      // Once the operator turns one off, the selection is theirs. Re-seeding
      // would put back a connection they just removed.
      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: { mcpConnectionIds: ["linear"] },
      });
      connections = [
        mcpConnection({ id: "datadog" }),
        mcpConnection({ id: "linear" }),
        mcpConnection({ id: "sentry" }),
      ];
      const edited = await ensure();
      expect(edited.mcpConnectionIds).toEqual(["linear"]);
      expect(edited.mcpConnectionIdsFromDefaults).toBeUndefined();

      await registry.close();
    });

    it("keeps an operator's empty selection empty", async () => {
      const { ensure, registry } = registryWith(() => [
        mcpConnection({ id: "datadog" }),
      ]);
      await ensure();
      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: { mcpConnectionIds: [] },
      });

      expect((await ensure()).mcpConnectionIds).toEqual([]);

      await registry.close();
    });

    it("withdraws a seed whose default was turned off", async () => {
      let connections = [mcpConnection({ id: "datadog" })];
      const { ensure, registry } = registryWith(() => connections);
      await ensure();

      connections = [mcpConnection({ id: "datadog", selectForNewThreads: false })];
      const launchpad = await ensure();

      expect(launchpad.mcpConnectionIds).toBeUndefined();
      expect(launchpad.mcpConnectionIdsFromDefaults).toBeUndefined();

      await registry.close();
    });

    it("gives a remote viewer's draft none of this machine's defaults", async () => {
      const { ensure, listConnections, registry } = registryWith(() => [
        mcpConnection({ id: "pwrsnap", kind: "pwrsnap" }),
      ]);

      const launchpad = await ensure({
        skipFilesystemInspection: true,
        skipMcpConnectionDefaults: true,
      });

      // PwrSnap has the same id on every machine, so a local default would
      // select the remote owner's PwrSnap on a thread nobody chose it for.
      expect(launchpad.mcpConnectionIds).toBeUndefined();
      expect(listConnections).not.toHaveBeenCalled();

      await registry.close();
    });

    it("opens the draft without defaults when the owner does not answer", async () => {
      vi.useFakeTimers();
      try {
        // A wedged owner broker answers nothing; its own timeout is sized for
        // a ten-minute tool call, far past what a New thread screen can wait.
        const listConnections = vi.fn(
          () => new Promise<McpConnectionStatus[]>(() => undefined),
        );
        const registry = createDesktopBackendRegistry({
          codexClient: new MockBackendClient({
            initializeResult: { methods: ["thread/start"] },
          }),
          overlayStore: createOverlayStoreMock(),
          mcpConnectionService: { registerBridge: vi.fn(), listConnections },
        });

        const ensured = registry.ensureDirectoryLaunchpad({
          directoryKey: "directory:/repo-a",
          directoryKind: "directory",
          directoryLabel: "Repo A",
          directoryPath: "/repo-a",
        });
        // The deadline starts only once the read does, after the ensure's
        // own earlier awaits.
        await vi.waitFor(() => expect(listConnections).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(2_000);
        const { launchpad } = await ensured;

        expect(launchpad.mcpConnectionIds).toBeUndefined();

        await registry.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps following the defaults when a patch only repeats the seeded ids", async () => {
      let connections = [mcpConnection({ id: "datadog" })];
      const { ensure, registry } = registryWith(() => connections);
      const seeded = await ensure();

      // The MCP access panel sends the ids with its agent-servers switch.
      // Turning that switch is not a choice about connections.
      await registry.updateDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        patch: {
          mcpConnectionIds: seeded.mcpConnectionIds,
          mcpProviderServersEnabled: false,
        },
      });
      connections = [
        mcpConnection({ id: "datadog" }),
        mcpConnection({ id: "linear" }),
      ];

      expect((await ensure()).mcpConnectionIds).toEqual(["datadog", "linear"]);

      await registry.close();
    });

    it("opens the draft anyway when the connections cannot be read", async () => {
      const listConnections = vi.fn(async (): Promise<McpConnectionStatus[]> => {
        throw new Error("owner broker went away");
      });
      const registry = createDesktopBackendRegistry({
        codexClient: new MockBackendClient({
          initializeResult: { methods: ["thread/start"] },
        }),
        overlayStore: createOverlayStoreMock(),
        mcpConnectionService: { registerBridge: vi.fn(), listConnections },
      });

      const { launchpad } = await registry.ensureDirectoryLaunchpad({
        directoryKey: "directory:/repo-a",
        directoryKind: "directory",
        directoryLabel: "Repo A",
        directoryPath: "/repo-a",
      });

      expect(listConnections).toHaveBeenCalled();
      expect(launchpad.directoryKey).toBe("directory:/repo-a");
      expect(launchpad.mcpConnectionIds).toBeUndefined();

      await registry.close();
    });
  });

  it("refreshes the PDF MCP registration when forking a PDF-enabled Codex thread", async () => {
    const overlayStore = createOverlayStoreMock({
      overlays: {
        "codex:thread-parent": {
          backend: "codex",
          threadId: "thread-parent",
          executionMode: "default",
          extraLinkedDirectories: [],
          messagingPdfToolCatalogVersion:
            PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION,
        },
      },
    });
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/fork"] },
    });
    const pdfMcp = createPdfMcpServerMock();
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore,
      pdfToolMcpServer: pdfMcp.server,
      resolvePdfAnalysisEnabled: () => true,
      gitDirectoryService: {
        prepareLaunchpadWorkspace: vi.fn(async () => ({
          cwd: "/repo/app",
          workMode: "local" as const,
        })),
        recordCodexWorktreeOwnerThread: vi.fn(async () => {}),
      } as never,
    });

    await registry.forkThread({
      backend: "codex",
      sourceThreadId: "thread-parent",
      executionMode: "default",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local",
    });

    expect(pdfMcp.registerClient).toHaveBeenCalledWith({ backend: "codex" });
    expect(pdfMcp.bindThread).toHaveBeenCalledWith("thread-fork");
    expect(codexClient.lastForkThreadParams?.config).toEqual({
      mcp_servers: {
        pwragent_pdf: {
          enabled: true,
          http_headers: {
            Authorization: "Bearer pwragent-pdf-test-token",
          },
          url: "http://127.0.0.1:42137/mcp",
        },
      },
    });
    await expect(
      overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: "thread-fork",
      }),
    ).resolves.toMatchObject({
      messagingPdfToolCatalogVersion:
        PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION,
    });

    await registry.close();
    expect(pdfMcp.close).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "stall", "late rejection", "inactive"])(
    "dispatches MCP connection inventory without retaining a pending request: %s",
    async (scenario) => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      let resolveInventory!: (value: McpConnectionStatus[]) => void;
      let rejectInventory!: (error: Error) => void;
      const listConnections = vi.fn(() => new Promise<McpConnectionStatus[]>((resolve, reject) => {
        resolveInventory = resolve;
        rejectInventory = reject;
      }));
      const codexClient = new MockBackendClient({
        initializeResult: { methods: ["thread/read"] },
      });
      const registry = createDesktopBackendRegistry({
        codexClient,
        overlayStore: createOverlayStoreMock(),
        mcpConnectionService: {
          registerBridge: vi.fn(),
          listConnections,
          createConnection: vi.fn(),
          probeConnection: vi.fn(),
        },
      });
      onTestFinished(async () => await registry.close());
      if (scenario !== "inactive") {
        await registry.publishLocalEvent({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: { threadId: "inventory-thread", turnId: "turn-1", turn: { id: "turn-1" } },
          },
        });
      }
      const settled = vi.fn();
      const response = codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: "inventory-thread", turnId: "turn-1",
          callId: "inventory-call", requestId: "inventory-call",
          namespace: "pwragent", tool: "manage_mcp_connections",
          arguments: { action: "list" },
        },
      } as AppServerPendingRequestNotification).then(settled);
      void response.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.getNavigationInputRequestThreadKeys().size).toBe(0);
      expect(listConnections).toHaveBeenCalledTimes(scenario === "inactive" ? 0 : 1);
      if (scenario === "success") resolveInventory([]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toMatchObject({ success: scenario === "success" });
      if (scenario === "stall" || scenario === "late rejection") {
        expect(JSON.stringify(settled.mock.calls[0])).toContain("timed out");
        if (scenario === "stall") resolveInventory([]);
        else rejectInventory(new Error("late inventory failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toHaveBeenCalledTimes(1);
      }
      await response;
      expect(registry.getNavigationInputRequestThreadKeys().size).toBe(0);
      await expect(registry.submitServerRequest({
        backend: "codex", threadId: "inventory-thread", turnId: "turn-1",
        requestId: "inventory-call", response: { decision: "accept" },
      })).rejects.toThrow("No pending server request");
    },
  );

  it("lists and reloads MCP config through the thread's Codex client", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: {
        methods: ["mcpServerStatus/list", "config/mcpServer/reload"],
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock({ executionMode: "default" }),
    });

    await expect(registry.listThreadMcpServers({
      backend: "codex",
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    })).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
      servers: [
        {
          name: "atlassian-rovo",
          authStatus: "oAuth",
          tools: ["fetch", "search"],
        },
      ],
    });
    expect(codexClient.lastListMcpServersParams).toEqual({
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    });

    await expect(registry.reloadCodexMcpConfig({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      queued: true,
    });
    expect(codexClient.reloadMcpConfigCallCount).toBe(1);

    await registry.close();
  });
});
