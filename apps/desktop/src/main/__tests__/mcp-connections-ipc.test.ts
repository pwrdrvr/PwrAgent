import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
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
    readRemoteStatus: vi.fn(async () => remoteStatus),
    remoteBackend: vi.fn(() => ({
      readPwrSnapConnectionStatus: mocks.readRemoteStatus,
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
  const service = {
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
  };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.readRemoteStatus.mockClear();
    mocks.remoteBackend.mockClear();
    service.readStatus.mockClear();
    service.connect.mockClear();
    service.openApplication.mockClear();
    service.openDownload.mockClear();
    service.listConnections.mockClear();
    service.createConnection.mockClear();
    service.authorizeConnection.mockClear();
    service.disconnectConnection.mockClear();
    service.removeConnection.mockClear();
  });

  it("reads status from the remote owner without consulting local PwrSnap", async () => {
    const { registerMcpConnectionIpcHandlers } = await import(
      "../ipc/mcp-connections"
    );
    const { MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL } = await import(
      "../../shared/ipc"
    );
    registerMcpConnectionIpcHandlers(service as never);

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

  it("preserves local PwrSnap status and pairing behavior", async () => {
    const { registerMcpConnectionIpcHandlers } = await import(
      "../ipc/mcp-connections"
    );
    const {
      MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
      MCP_CONNECTION_PWRSNAP_STATUS_CHANNEL,
    } = await import("../../shared/ipc");
    service.connect.mockResolvedValue({
      outcome: "connected",
      status: { ...localStatus, availability: "running", configured: true },
    });
    registerMcpConnectionIpcHandlers(service as never);

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
    const { registerMcpConnectionIpcHandlers } = await import(
      "../ipc/mcp-connections"
    );
    const {
      MCP_CONNECTION_PWRSNAP_CONNECT_CHANNEL,
      MCP_CONNECTION_PWRSNAP_DOWNLOAD_CHANNEL,
      MCP_CONNECTION_PWRSNAP_OPEN_CHANNEL,
    } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(service as never);
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

  it("routes managed connection lifecycle actions only on the local owner", async () => {
    const { registerMcpConnectionIpcHandlers } = await import(
      "../ipc/mcp-connections"
    );
    const {
      MCP_CONNECTION_AUTHORIZE_CHANNEL,
      MCP_CONNECTION_CREATE_CHANNEL,
      MCP_CONNECTION_DISCONNECT_CHANNEL,
      MCP_CONNECTION_LIST_CHANNEL,
      MCP_CONNECTION_REMOVE_CHANNEL,
    } = await import("../../shared/ipc");
    registerMcpConnectionIpcHandlers(service as never);
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
      MCP_CONNECTION_LIST_CHANNEL,
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
});
