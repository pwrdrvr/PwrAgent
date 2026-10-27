import { beforeEach, describe, expect, it, vi } from "vitest";
import { disposeMcpConnectionIpcHandlers, registerMcpConnectionIpcHandlers } from "../ipc/mcp-connections";
import type {
  PwrGitConnectionStatus,
  McpConnectionStatus,
  PwrSnapConnectionStatus,
  ReadPwrSnapConnectionStatusRequest,
} from "@pwragent/shared";

const federationTarget = {
  scope: "remote" as const,
  instanceId: "remote-owner",
};
const remoteSender = { id: 17 };

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (...args: unknown[]) => Promise<unknown>
  >();
  const remoteStatus: PwrSnapConnectionStatus = {
    connectionId: "pwrsnap",
    displayName: "PwrSnap",
    availability: "running",
    configured: true,
  };
  return {
    handlers,
    subscribers: [] as Array<{ isDestroyed: () => boolean; send: (...args: unknown[]) => void }>,
    listMcpConnections: vi.fn(async () => ({ connections: [{ id: "rovo" }] })),
    readThreadMcpConnections: vi.fn(async () => ({ connectionIds: ["rovo"], providerServersEnabled: true })),
    setThreadMcpConnections: vi.fn(async () => ({ connectionIds: ["rovo"], providerServersEnabled: false })),
    describeThreadMcpConnections: vi.fn(async () => ({ connections: [{ connectionId: "rovo" }] })),
    readRemoteStatus: vi.fn(async () => remoteStatus),
    remoteBackend: vi.fn(() => ({
      readPwrSnapConnectionStatus: mocks.readRemoteStatus,
      listMcpConnections: mocks.listMcpConnections,
      readThreadMcpConnections: mocks.readThreadMcpConnections,
      setThreadMcpConnections: mocks.setThreadMcpConnections,
      describeThreadMcpConnections: mocks.describeThreadMcpConnections,
    })),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        mocks.handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      mocks.handlers.delete(channel);
    }),
  },
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => ({ remoteBackend: mocks.remoteBackend }),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: () => mocks.subscribers,
}));

vi.mock("../window", () => ({
  federationWindowTargetForWebContents: (sender: unknown) =>
    sender === remoteSender ? federationTarget : undefined,
}));

describe("MCP connection IPC", () => {
  const localStatus: PwrSnapConnectionStatus = {
    connectionId: "pwrsnap",
    displayName: "PwrSnap",
    availability: "not_installed",
    configured: false,
  };
  const managedConnection: McpConnectionStatus = {
    id: "datadog",
    displayName: "Datadog",
    serverUrl: "https://mcp.datadoghq.com/mcp",
    authMode: "oauth",
    kind: "remote",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    configured: false,
    state: "disconnected",
  };
  let announce: ((event: { connectionIds: string[] }) => void) | undefined;
  const service = {
    onConnectionsChanged: vi.fn((listener: (event: { connectionIds: string[] }) => void) => {
      announce = listener;
      return () => {
        if (announce === listener) announce = undefined;
      };
    }),
    listConnections: vi.fn(async () => [managedConnection]),
    createConnection: vi.fn(async () => managedConnection),
    authorizeConnection: vi.fn(async () => ({
      ...managedConnection,
      configured: true,
      state: "ready" as const,
    })),
    disconnectConnection: vi.fn(async () => managedConnection),
    removeConnection: vi.fn(async () => true),
    readStatus: vi.fn(async () => localStatus),
    connect: vi.fn(),
    openApplication: vi.fn(),
    openDownload: vi.fn(),
    openSandboxerLink: vi.fn(async () => ({ opened: true })),
    setSandboxerTransport: vi.fn(async () => managedConnection),
    testStdioConnection: vi.fn(async () => ({
      ok: true as const,
      command: "/opt/fixture/bin/server",
      toolCount: 1,
      elapsedMs: 5,
    })),
  };
  const pwrGitLocalStatus: PwrGitConnectionStatus = {
    connectionId: "pwrgit",
    displayName: "PwrGit",
    availability: "running",
    configured: true,
  };
  // Always injected: the default parameter constructs the real service, whose
  // settings lookup needs initialized app state this suite does not have.
  const pwrGit = {
    readStatus: vi.fn(async () => pwrGitLocalStatus),
    connect: vi.fn(),
    openApplication: vi.fn(),
    openDownload: vi.fn(),
  };

  const installer = {
    subscribe: vi.fn(() => () => undefined),
    readState: vi.fn(async () => ({ app: "pwrgit", phase: "idle" })),
    start: vi.fn(async () => ({ app: "pwrgit", phase: "downloading" })),
    cancel: vi.fn(),
    openInstaller: vi.fn(),
    revealInstaller: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.readRemoteStatus.mockClear();
    mocks.remoteBackend.mockClear();
    for (const stub of [service, pwrGit]) {
      stub.readStatus.mockClear();
      stub.connect.mockClear();
      stub.openApplication.mockClear();
      stub.openDownload.mockClear();
    }
    service.listConnections.mockClear();
    service.createConnection.mockClear();
    service.authorizeConnection.mockClear();
    service.disconnectConnection.mockClear();
    service.removeConnection.mockClear();
  });

  it("reads status from the remote owner without consulting local PwrSnap", async () => {
    const { MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );

    const response = await mocks.handlers.get(
      MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
    )?.(
      { sender: remoteSender },
      {} satisfies ReadPwrSnapConnectionStatusRequest,
    );

    expect(mocks.remoteBackend).toHaveBeenCalledWith(federationTarget);
    expect(mocks.readRemoteStatus).toHaveBeenCalledOnce();
    expect(service.readStatus).not.toHaveBeenCalled();
    expect(response).toMatchObject({ configured: true, availability: "running" });
  });

  /**
   * Dispose used to be a hand-kept copy of the registration list, and three
   * channels (describe-thread, update, probe) never made it in: they stayed
   * bound to the disposed service. Derive the expectation from what register
   * installed, so the next channel cannot drift the same way.
   */
  it.each([
    ["MCP_CONNECTION_LIST_CHANNEL", "listMcpConnections", {}],
    ["MCP_CONNECTION_READ_THREAD_CHANNEL", "readThreadMcpConnections", { backend: "codex", threadId: "thread-1" }],
    ["MCP_CONNECTION_SET_THREAD_CHANNEL", "setThreadMcpConnections", { backend: "codex", threadId: "thread-1", connectionIds: ["rovo"], providerServersEnabled: false }],
    ["MCP_CONNECTION_DESCRIBE_THREAD_CHANNEL", "describeThreadMcpConnections", { backend: "codex", threadId: "thread-1" }],
  ] as const)("routes %s to the owner for mounted and remote windows", async (channel, method, request) => {
    const channels = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
    const handler = mocks.handlers.get(channels[channel])!;
    const operation = mocks[method];

    for (const [sender, target] of [
      [remoteSender, undefined],
      [{ id: 18 }, federationTarget],
      [remoteSender, { scope: "remote", instanceId: "wrong-owner" }],
    ] as const) {
      const response = await handler({ sender }, { ...request, ...(target ? { federationTarget: target } : {}) });
      expect(mocks.remoteBackend).toHaveBeenLastCalledWith(federationTarget);
      if (method === "listMcpConnections") {
        expect(operation).toHaveBeenLastCalledWith();
      } else {
        expect(operation).toHaveBeenLastCalledWith(request);
      }
      expect(response).toEqual(await operation.mock.results.at(-1)!.value);
    }
    expect(operation).toHaveBeenCalledTimes(3);
    expect(service.listConnections).not.toHaveBeenCalled();
  });

  it("sends this machine's connection changes to subscribed windows until disposed", async () => {
    const { MCP_CONNECTIONS_CHANGED_EVENT_CHANNEL } = await import("../../shared/ipc");
    const live = { isDestroyed: () => false, send: vi.fn() };
    const closed = { isDestroyed: () => true, send: vi.fn() };
    mocks.subscribers = [live, closed];
    try {
      registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
      // Registering again replaces the subscription rather than doubling it.
      registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
      announce?.({ connectionIds: ["builtin:sandboxer"] });
      expect(live.send).toHaveBeenCalledOnce();
      expect(live.send).toHaveBeenCalledWith(MCP_CONNECTIONS_CHANGED_EVENT_CHANNEL, {
        connectionIds: ["builtin:sandboxer"],
      });
      expect(closed.send).not.toHaveBeenCalled();

      disposeMcpConnectionIpcHandlers();
      expect(announce).toBeUndefined();
    } finally {
      mocks.subscribers = [];
    }
  });

  it("passes a local list's Sandboxer max age through, never fresher than a second", async () => {
    const { MCP_CONNECTION_LIST_CHANNEL } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
    const list = mocks.handlers.get(MCP_CONNECTION_LIST_CHANNEL)!;

    await list({ sender: { id: 18 } }, { sandboxerStatusMaxAgeMs: 2_000 });
    expect(service.listConnections).toHaveBeenLastCalledWith({ sandboxerStatusMaxAgeMs: 2_000 });
    await list({ sender: { id: 18 } }, { sandboxerStatusMaxAgeMs: 0 });
    expect(service.listConnections).toHaveBeenLastCalledWith({ sandboxerStatusMaxAgeMs: 1_000 });
    await list({ sender: { id: 18 } }, {});
    expect(service.listConnections).toHaveBeenLastCalledWith({});
  });

  it("surfaces an unavailable owner without falling back to local connections", async () => {
    const { MCP_CONNECTION_LIST_CHANNEL } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
    mocks.listMcpConnections.mockRejectedValueOnce(new Error("Owner disconnected"));

    await expect(mocks.handlers.get(MCP_CONNECTION_LIST_CHANNEL)?.(
      { sender: { id: 18 } }, { federationTarget },
    )).rejects.toThrow("Owner disconnected");
    expect(service.listConnections).not.toHaveBeenCalled();
  });

  it("removes every handler it registered", async () => {
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    expect(mocks.handlers.size).toBeGreaterThan(0);

    disposeMcpConnectionIpcHandlers();

    expect([...mocks.handlers.keys()]).toEqual([]);
  });

  it("preserves local PwrSnap status and pairing behavior", async () => {
    const {
      MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
      MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
    } = await import("../../shared/ipc");
    service.connect.mockResolvedValue({
      outcome: "connected",
      status: { ...localStatus, availability: "running", configured: true },
    });
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );

    await expect(mocks.handlers.get(MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL)?.(
      { sender: { id: 18 } },
      {},
    )).resolves.toEqual(localStatus);
    await mocks.handlers.get(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL)?.({
      sender: { id: 18 },
    });

    expect(service.readStatus).toHaveBeenCalledOnce();
    expect(service.connect).toHaveBeenCalledOnce();
    expect(mocks.remoteBackend).not.toHaveBeenCalled();
  });

  it("blocks every local PwrSnap pairing or launch action in a remote window", async () => {
    const {
      MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
      MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
      MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
    } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const event = { sender: remoteSender };

    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL)?.(event),
    ).rejects.toThrow(/only available on the machine that owns/i);
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL)?.(event),
    ).resolves.toMatchObject({ opened: false });
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL)?.(event),
    ).resolves.toMatchObject({ opened: false });

    expect(service.connect).not.toHaveBeenCalled();
    expect(service.openApplication).not.toHaveBeenCalled();
    expect(service.openDownload).not.toHaveBeenCalled();
  });

  it("serves local PwrGit status and blocks every PwrGit action in a remote window", async () => {
    const {
      MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL,
      MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL,
      MCP_CONNECTION_PWRGIT_OPEN_CHANNEL,
      MCP_CONNECTION_PWRGIT_STATUS_CHANNEL,
    } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const remote = { sender: remoteSender };

    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRGIT_STATUS_CHANNEL)?.({ sender: { id: 18 } }),
    ).resolves.toEqual(pwrGitLocalStatus);
    // PwrGit has no federation surface, so a remote window learns nothing
    // about the viewer's local install and cannot pair or launch it.
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRGIT_STATUS_CHANNEL)?.(remote),
    ).resolves.toMatchObject({ availability: "not_installed", configured: false });
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRGIT_CONNECT_CHANNEL)?.(remote),
    ).rejects.toThrow(/only available on the machine that owns/i);
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRGIT_OPEN_CHANNEL)?.(remote),
    ).resolves.toMatchObject({ opened: false });
    await expect(
      mocks.handlers.get(MCP_CONNECTION_PWRGIT_DOWNLOAD_CHANNEL)?.(remote),
    ).resolves.toMatchObject({ opened: false });

    expect(pwrGit.readStatus).toHaveBeenCalledOnce();
    expect(pwrGit.connect).not.toHaveBeenCalled();
    expect(pwrGit.openApplication).not.toHaveBeenCalled();
    expect(pwrGit.openDownload).not.toHaveBeenCalled();
    expect(service.readStatus).not.toHaveBeenCalled();
  });

  it("routes managed connection lifecycle actions only on the local owner", async () => {
    const {
      MCP_CONNECTION_AUTHORIZE_CHANNEL,
      MCP_CONNECTION_CREATE_CHANNEL,
      MCP_CONNECTION_DISCONNECT_CHANNEL,
      MCP_CONNECTION_LIST_CHANNEL,
      MCP_CONNECTION_REMOVE_CHANNEL,
    } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const localEvent = { sender: { id: 18 } };

    await expect(
      mocks.handlers.get(MCP_CONNECTION_LIST_CHANNEL)?.(localEvent),
    ).resolves.toEqual({ connections: [managedConnection] });
    await mocks.handlers.get(MCP_CONNECTION_CREATE_CHANNEL)?.(localEvent, {
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    await mocks.handlers.get(MCP_CONNECTION_AUTHORIZE_CHANNEL)?.(localEvent, {
      connectionId: "datadog",
    });
    await mocks.handlers.get(MCP_CONNECTION_DISCONNECT_CHANNEL)?.(localEvent, {
      connectionId: "datadog",
    });
    await mocks.handlers.get(MCP_CONNECTION_REMOVE_CHANNEL)?.(localEvent, {
      connectionId: "datadog",
    });

    expect(service.createConnection).toHaveBeenCalledOnce();
    expect(service.authorizeConnection).toHaveBeenCalledWith("datadog");
    expect(service.disconnectConnection).toHaveBeenCalledWith("datadog");
    expect(service.removeConnection).toHaveBeenCalledWith("datadog");

    for (const channel of [
      MCP_CONNECTION_CREATE_CHANNEL,
      MCP_CONNECTION_AUTHORIZE_CHANNEL,
      MCP_CONNECTION_DISCONNECT_CHANNEL,
      MCP_CONNECTION_REMOVE_CHANNEL,
    ]) {
      await expect(
        mocks.handlers.get(channel)?.(
          { sender: remoteSender },
          { connectionId: "datadog" },
        ),
      ).rejects.toThrow(/machine that owns this window/i);
    }
  });
  it("tests a local command only for a window on the machine that would run it", async () => {
    const { MCP_CONNECTION_TEST_STDIO_CHANNEL } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const request = { stdio: { command: "server", args: [], env: [] } };

    await expect(
      mocks.handlers.get(MCP_CONNECTION_TEST_STDIO_CHANNEL)?.({ sender: { id: 18 } }, request),
    ).resolves.toMatchObject({ ok: true, command: "/opt/fixture/bin/server" });
    expect(service.testStdioConnection).toHaveBeenCalledWith(request);

    service.testStdioConnection.mockClear();
    // A peer's window must not start a program on the owner's machine.
    await expect(
      mocks.handlers.get(MCP_CONNECTION_TEST_STDIO_CHANNEL)?.(
        { sender: remoteSender },
        { ...request, federationTarget },
      ),
    ).rejects.toThrow(/machine that owns this window/i);
    expect(service.testStdioConnection).not.toHaveBeenCalled();
  });

  it("validates Sandboxer transport and restricts changes to a local window", async () => {
    service.setSandboxerTransport.mockClear();
    registerMcpConnectionIpcHandlers(service as never, pwrGit as never, installer as never);
    const change = mocks.handlers.get("mcp-connection:set-sandboxer-transport")!;
    await expect(change({ sender: remoteSender }, { transport: "hosted" })).rejects.toThrow("machine that owns");
    await expect(change({ sender: { id: 18 } }, { transport: "arbitrary" })).rejects.toThrow("transport");
    expect(service.setSandboxerTransport).not.toHaveBeenCalled();
    await change({ sender: { id: 18 } }, { transport: "hosted" });
    expect(service.setSandboxerTransport).toHaveBeenCalledWith("hosted");
  });

  it("opens Sandboxer pages only from a local window, and only known ones", async () => {
    const { MCP_CONNECTION_SANDBOXER_OPEN_CHANNEL } = await import("../../shared/ipc");
    service.openSandboxerLink.mockClear();
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const open = mocks.handlers.get(MCP_CONNECTION_SANDBOXER_OPEN_CHANNEL)!;

    // The dashboard link signs in with this machine's CLI login.
    await expect(open({ sender: remoteSender }, { target: "dashboard" })).resolves.toMatchObject({
      opened: false,
    });
    await expect(open({ sender: { id: 18 } }, { target: "https://example.com" })).resolves.toMatchObject({
      opened: false,
      error: "Unknown Sandboxer page.",
    });
    await expect(open({ sender: { id: 18 } }, undefined)).resolves.toMatchObject({ opened: false });
    expect(service.openSandboxerLink).not.toHaveBeenCalled();
    await expect(open({ sender: { id: 18 } }, { target: "pricing" })).resolves.toEqual({ opened: true });
    expect(service.openSandboxerLink).toHaveBeenCalledWith("pricing");
  });

  it("refuses installer downloads from a remote window and unknown apps", async () => {
    const { PWRSUITE_INSTALLER_START_CHANNEL } = await import("../../shared/ipc");
    installer.start.mockClear();
    registerMcpConnectionIpcHandlers(
      service as never,
      pwrGit as never,
      installer as never,
    );
    const start = mocks.handlers.get(PWRSUITE_INSTALLER_START_CHANNEL)!;

    await expect(start({ sender: remoteSender }, "pwrgit")).rejects.toThrow(
      /machine that owns this thread/,
    );
    await expect(start({ sender: { id: 18 } }, "../../etc")).rejects.toThrow(
      /Unknown PwrSuite app/,
    );
    await expect(start({ sender: { id: 18 } }, "pwrgit")).resolves.toMatchObject({
      phase: "downloading",
    });
    expect(installer.start).toHaveBeenCalledOnce();
    expect(installer.start).toHaveBeenCalledWith("pwrgit");
  });
});
