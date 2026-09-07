import { fileURLToPath } from "node:url";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRSNAP_SESSION_REVOKED_DETAIL,
  PwrSnapConnectionService,
} from "../mcp-connections/pwrsnap-connection-service";

function createSettings(initial?: string) {
  let credential = initial;
  return {
    clearPwrSnapMcpCredential: vi.fn(async () => {
      credential = undefined;
    }),
    resolvePwrSnapMcpCredential: vi.fn(async () => credential),
    savePwrSnapMcpCredential: vi.fn(async (value: string) => {
      credential = value;
    }),
  };
}

// A credential as PwrAgent stores it after a completed OAuth approval. The
// cached discovery state lets the SDK skip metadata fetches, so a 401 on the
// MCP endpoint goes straight to the token check and then to a new
// authorization, exactly as it does against a real PwrSnap.
function createAuthorizedCredential(): string {
  return JSON.stringify({
    clientInformation: { client_id: "pwragent-client" },
    discoveryState: {
      authorizationServerUrl: "http://127.0.0.1:51729",
      resourceMetadata: {
        resource: "http://127.0.0.1:51729/mcp",
        authorization_servers: ["http://127.0.0.1:51729"],
      },
      authorizationServerMetadata: {
        issuer: "http://127.0.0.1:51729",
        authorization_endpoint: "http://127.0.0.1:51729/oauth/authorize",
        token_endpoint: "http://127.0.0.1:51729/oauth/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    },
    tokens: { access_token: "revoked-by-pwrsnap", token_type: "bearer" },
  });
}

type BridgeInternals = {
  dispatchBridgeOperation: (
    operation: unknown,
    params: unknown,
  ) => Promise<unknown>;
  grants: Map<string, { connectionId: "pwrsnap" }>;
  handleBridgeLine: (socket: unknown, line: string) => Promise<void>;
};

const services: PwrSnapConnectionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
});

describe("PwrSnapConnectionService", () => {
  it("distinguishes an absent install from a running MCP endpoint", async () => {
    const absent = new PwrSnapConnectionService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      resolveInstallPaths: () => [],
      settings: createSettings(),
    });
    services.push(absent);

    await expect(absent.readStatus()).resolves.toMatchObject({
      availability: "not_installed",
      configured: false,
    });

    const running = new PwrSnapConnectionService({
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      resolveInstallPaths: () => [],
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
    });
    services.push(running);

    await expect(running.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });

  it("opens an installed PwrSnap and explains when Local Agent Access is off", async () => {
    const openPath = vi.fn(async () => "");
    const service = new PwrSnapConnectionService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      openPath,
      launchPollAttempts: 0,
      resolveInstallPaths: () => [fileURLToPath(import.meta.url)],
      settings: createSettings(),
    });
    services.push(service);

    await expect(service.connect()).resolves.toMatchObject({
      outcome: "needs_local_agent_access",
      status: { availability: "installed", configured: false },
    });
    expect(openPath).toHaveBeenCalledOnce();
  });

  it("reuses one revocable stdio bridge grant for a configured thread", async () => {
    const service = new PwrSnapConnectionService({
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
    });
    services.push(service);

    const first = await service.registerBridge("pwrsnap", "thread-1");
    const second = await service.registerBridge("pwrsnap", "thread-1");

    expect(second.server).toEqual(first.server);
    expect(first.server).toMatchObject({
      name: "pwrsnap",
      command: process.execPath,
      args: ["/test/mcp-connection-bridge.js"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).toBeTruthy();
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_SOCKET).toBeTruthy();
  });

  it("keeps blocking upstream tool calls alive beyond the SDK default", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const service = new PwrSnapConnectionService({
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
    });
    services.push(service);
    Object.assign(service, {
      upstreamClient: { callTool, close: vi.fn(async () => undefined) },
    });

    const bridge = service as unknown as {
      dispatchBridgeOperation: (
        operation: unknown,
        params: unknown,
      ) => Promise<unknown>;
    };
    await bridge.dispatchBridgeOperation("tools/call", {
      name: "pwrsnap_image_edit_send",
      arguments: { captureId: "cap-1", instruction: "Add an arrow" },
    });

    expect(callTool).toHaveBeenCalledWith(
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-1", instruction: "Add an arrow" },
      },
      undefined,
      { timeout: 720_000 },
    );
  });

  it("clears the stored credential when PwrSnap rejects the session token", async () => {
    const settings = createSettings(createAuthorizedCredential());
    const openExternal = vi.fn(async () => undefined);
    const service = new PwrSnapConnectionService({
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      openExternal,
      resolveInstallPaths: () => [],
      settings,
    });
    services.push(service);

    await expect(service.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });

    const bridge = service as unknown as BridgeInternals;
    await expect(bridge.dispatchBridgeOperation("tools/list", {}))
      .rejects.toThrow(PWRSNAP_SESSION_REVOKED_DETAIL);

    // The proxy must never try to open a consent window of its own.
    expect(openExternal).not.toHaveBeenCalled();
    expect(settings.clearPwrSnapMcpCredential).toHaveBeenCalledOnce();
    await expect(service.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: false,
      detail: PWRSNAP_SESSION_REVOKED_DETAIL,
    });
    await expect(service.registerBridge("pwrsnap", "thread-1"))
      .rejects.toThrow(PWRSNAP_SESSION_REVOKED_DETAIL);

    // A fresh approval stored by the connect flow hides the revoke notice.
    await settings.savePwrSnapMcpCredential(createAuthorizedCredential());
    await expect(service.readStatus()).resolves.toMatchObject({
      configured: true,
    });
    await expect(service.readStatus()).resolves.not.toHaveProperty("detail");
  });

  it("clears the stored credential when a proxied call gets 401 after connecting", async () => {
    const settings = createSettings(createAuthorizedCredential());
    const service = new PwrSnapConnectionService({
      fetchFn: vi.fn(async () => new Response("ok", { status: 200 })),
      resolveInstallPaths: () => [],
      settings,
    });
    services.push(service);
    Object.assign(service, {
      upstreamClient: {
        listTools: vi.fn(async () => {
          throw new StreamableHTTPError(
            401,
            "Server returned 401 after successful authentication",
          );
        }),
        close: vi.fn(async () => undefined),
      },
    });
    const bridge = service as unknown as BridgeInternals;
    bridge.grants.set("grant-token", { connectionId: "pwrsnap" });
    const socket = { destroyed: false, end: vi.fn() };

    await bridge.handleBridgeLine(
      socket,
      JSON.stringify({ token: "grant-token", op: "tools/list" }),
    );

    expect(socket.end).toHaveBeenCalledWith(
      expect.stringContaining("Server returned 401 after successful authentication"),
    );
    expect(settings.clearPwrSnapMcpCredential).toHaveBeenCalledOnce();
    await expect(service.readStatus()).resolves.toMatchObject({
      configured: false,
      detail: PWRSNAP_SESSION_REVOKED_DETAIL,
    });
  });
});
