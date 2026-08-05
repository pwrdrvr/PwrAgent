import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
});
