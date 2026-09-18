import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PWRSNAP_SESSION_REVOKED_DETAIL } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpConnectionGatewayService,
  PWRSNAP_SESSION_REVOKED_ERROR,
} from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import * as appState from "../state/app-state";
import { McpConnectionBrokerDiscovery } from "../mcp-connections/mcp-connection-broker-discovery";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";

function createSettings(initial?: string) {
  let credential = initial;
  let connectionCredentials: string | undefined;
  return {
    clearMcpConnectionCredentials: vi.fn(async () => {
      connectionCredentials = undefined;
    }),
    clearPwrSnapMcpCredential: vi.fn(async () => {
      credential = undefined;
    }),
    resolveMcpConnectionCredentials: vi.fn(async () => connectionCredentials),
    resolvePwrSnapMcpCredential: vi.fn(async () => credential),
    resolvePwrGitMcpCredential: vi.fn(async () => undefined),
    clearPwrGitMcpCredential: vi.fn(async () => undefined),
    saveMcpConnectionCredentials: vi.fn(async (value: string) => {
      connectionCredentials = value;
    }),
    savePwrSnapMcpCredential: vi.fn(async (value: string) => {
      credential = value;
    }),
  };
}

function createAuthorizedCredential(accessToken = "revoked-by-pwrsnap"): string {
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
    tokens: { access_token: accessToken, token_type: "bearer" },
  });
}

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];

function temporaryRegistry(): McpConnectionRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-gateway-"));
  temporaryDirectories.push(directory);
  return new McpConnectionRegistry({
    configPath: path.join(directory, "config.toml"),
  });
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("McpConnectionGatewayService", () => {
  it("does not claim or publish a profile broker during bootstrap, including PwrGit status reads", async () => {
    const mode = vi.spyOn(appState, "getAppStateMode").mockReturnValue("bootstrap");
    const acquire = vi.fn();
    const publish = vi.spyOn(McpConnectionBrokerDiscovery.prototype, "publish");
    const service = new McpConnectionGatewayService({
      settings: createSettings(),
      leaseManager: { id: "bootstrap-test", acquire, release: vi.fn(), snapshot: vi.fn() },
    });
    services.push(service);
    const git = new PwrGitConnectionService({
      gateway: service,
      fetchFn: async () => new Response(null, { status: 404 }),
      resolveInstallPaths: () => [],
    });
    try {
      await expect(service.start()).rejects.toThrow("Complete profile setup");
      await expect(service.listConnections()).rejects.toThrow("Complete profile setup");
      await expect(service.readStatus()).rejects.toThrow("Complete profile setup");
      await expect(git.readStatus()).rejects.toThrow("Complete profile setup");
      await expect(service.registerBridge("pwrgit")).rejects.toThrow("Complete profile setup");
      expect(acquire).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      mode.mockRestore();
      publish.mockRestore();
    }
  });

  it("distinguishes an absent install from a running MCP endpoint", async () => {
    const absent = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      resolveInstallPaths: () => [],
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(absent);

    await expect(absent.readStatus()).resolves.toMatchObject({
      availability: "not_installed",
      configured: false,
    });

    const running = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      resolveInstallPaths: () => [],
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
    });
    services.push(running);

    await expect(running.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });

  it("opens an installed PwrSnap and explains when Local Agent Access is off", async () => {
    const openPath = vi.fn(async () => "");
    const service = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      openPath,
      launchPollAttempts: 0,
      resolveInstallPaths: () => [fileURLToPath(import.meta.url)],
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    await expect(service.connect()).resolves.toMatchObject({
      outcome: "needs_local_agent_access",
      status: { availability: "installed", configured: false },
    });
    expect(openPath).toHaveBeenCalledOnce();
  });

  it("reuses one revocable stdio bridge grant for a configured thread", async () => {
    const service = new McpConnectionGatewayService({
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
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
        PWRAGENT_MCP_CONNECTION_NAME: "pwrsnap",
      },
    });
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).toBeTruthy();
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_SOCKET).toBeTruthy();
  });

  it("names the switch that is withholding a connection", async () => {
    const registry = temporaryRegistry();
    const connection = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    let gatewayEnabled = true;
    const service = new McpConnectionGatewayService({
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      gatewayEnabled: () => gatewayEnabled,
      registry,
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    gatewayEnabled = false;
    await expect(service.registerBridge(connection.id, "thread-1"))
      .rejects.toThrow("MCP gateway is turned off");

    gatewayEnabled = true;
    registry.setEnabled(connection.id, false);
    // A parked connection and a gateway that is off are different problems
    // with different fixes, so they cannot share one message.
    await expect(service.registerBridge(connection.id, "thread-1"))
      .rejects.toThrow("Datadog is not available to threads");

    // Existence is still answerable while a connection is withheld;
    // otherwise the operator could never turn it back on.
    await expect(service.setConnectionEnabled(connection.id, true))
      .resolves.toMatchObject({ id: connection.id, enabled: true });
  });

  it("keeps blocking upstream tool calls alive beyond the SDK default", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const service = new McpConnectionGatewayService({
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
    });
    services.push(service);
    const token = "test-token";
    Object.assign(service, {
      upstreamSessions: new Map([[token, {
        client: { callTool, close: vi.fn(async () => undefined) },
        transport: { close: vi.fn(async () => undefined) },
      }]]),
    });

    const bridge = service as unknown as {
      dispatchBridgeOperation: (
        token: string,
        grant: { connectionId: string; threadId?: string },
        operation: unknown,
        params: unknown,
        signal?: AbortSignal,
      ) => Promise<unknown>;
    };
    await bridge.dispatchBridgeOperation(
      token,
      { connectionId: "pwrsnap", threadId: "thread-1" },
      "tools/call",
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-1", instruction: "Add an arrow" },
      },
    );

    expect(callTool).toHaveBeenCalledWith(
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-1", instruction: "Add an arrow" },
      },
      undefined,
      { timeout: 720_000 },
    );

    const abortController = new AbortController();
    await bridge.dispatchBridgeOperation(
      token,
      { connectionId: "pwrsnap", threadId: "thread-1" },
      "tools/call",
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-2", instruction: "Add a label" },
      },
      abortController.signal,
    );
    expect(callTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "pwrsnap_image_edit_send" }),
      undefined,
      { signal: abortController.signal, timeout: 720_000 },
    );
  });

  it("clears a PwrSnap credential rejected by the MCP endpoint", async () => {
    const settings = createSettings(createAuthorizedCredential());
    const service = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      resolveInstallPaths: () => [],
      settings,
      leaseManager: null,
    });
    services.push(service);

    await expect(service.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });

    const bridge = service as unknown as {
      dispatchBridgeOperation: (
        token: string,
        grant: { connectionId: string; threadId?: string },
        operation: unknown,
        params: unknown,
      ) => Promise<unknown>;
    };
    await expect(bridge.dispatchBridgeOperation(
      "test-token",
      { connectionId: "pwrsnap", threadId: "thread-1" },
      "tools/list",
      {},
    )).rejects.toThrow(PWRSNAP_SESSION_REVOKED_ERROR);

    expect(settings.clearMcpConnectionCredentials).toHaveBeenCalledOnce();
    expect(settings.clearPwrSnapMcpCredential).toHaveBeenCalledOnce();
    await expect(service.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: false,
      detail: PWRSNAP_SESSION_REVOKED_DETAIL,
    });

    // Existing threads keep starting; only PwrSnap calls report the revoke.
    await expect(service.registerBridge("pwrsnap", "thread-1"))
      .resolves.toBeTruthy();
  });
  /**
   * The OAuth round trip belongs to the browser, so "cancel" can only mean
   * releasing PwrAgent's half of it. Before this the only exit from an
   * abandoned attempt was the five-minute callback timeout, during which the
   * Settings card stayed disabled -- including the Reauthorize that would have
   * issued a fresh URL.
   */
  it("releases an authorization the operator walked away from", async () => {
    const registry = temporaryRegistry();
    const connection = registry.create({
      displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v2/mcp",
    });
    const service = new McpConnectionGatewayService({
      registry,
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    // The real callback listener and the real pending-authorization bookkeeping;
    // only the coordinator's own OAuth traffic is stood in for. It parks on
    // `waitForCode`, which is where a browser round trip actually waits.
    const redirects: URL[] = [];
    // Stands in for the coordinator's OAuth traffic only. What a cancel does
    // to the connection's *state* is the real coordinator's business and is
    // covered in `mcp-oauth-session-coordinator.test.ts`; these two tests are
    // about the listener and its port.
    const abandonAuthorization = vi.fn();
    const stubCoordinator = {
      abandonAuthorization,
      configured: async () => false,
      authorize: async (params: {
        redirectUrl: URL;
        onRedirect: (url: URL) => Promise<void>;
        waitForCode: () => Promise<string>;
      }) => {
        redirects.push(params.redirectUrl);
        await params.waitForCode();
      },
    };
    Object.assign(service, { coordinatorFor: () => stubCoordinator });

    const abandoned = service.authorizeConnection(connection.id);
    const failure = abandoned.catch((error: unknown) => error);
    await vi.waitFor(() => expect(redirects).toHaveLength(1));

    // The cancel resolves on the connection's unchanged state -- giving up on
    // an attempt is not disconnecting, so nothing stored is discarded.
    await expect(service.cancelAuthorization(connection.id)).resolves.toMatchObject({
      id: connection.id,
      configured: false,
    });
    // Retiring the attempt is what keeps a called-off authorization from
    // reporting itself as `reauthorization_required`, and it has to happen
    // before the wait is rejected or the coordinator's catch wins the race.
    expect(abandonAuthorization).toHaveBeenCalled();
    await expect(failure).resolves.toBeInstanceOf(Error);
    expect(String(await failure)).toContain("cancelled");

    // And the abandoned listener is gone rather than parked on its port, so a
    // retry gets its own callback instead of racing the first one.
    const port = redirects[0]!.port;
    await expect(
      fetch(`http://127.0.0.1:${port}/oauth/callback?code=late`),
    ).rejects.toThrow();

    const retry = service.authorizeConnection(connection.id);
    const retryFailure = retry.catch((error: unknown) => error);
    await vi.waitFor(() => expect(redirects).toHaveLength(2));
    expect(redirects[1]!.port).not.toBe(port);
    await service.cancelAuthorization(connection.id);
    await retryFailure;
  });

  /**
   * The coordinator's own attempt counter stops a superseded flow from
   * committing tokens. It does not close that flow's listener, so without this
   * a retry ran a second one beside the first and both sat on their ports
   * until the five-minute timeout.
   */
  it("abandons an in-flight authorization when a newer one starts", async () => {
    const registry = temporaryRegistry();
    const connection = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    const service = new McpConnectionGatewayService({
      registry,
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    const redirects: URL[] = [];
    Object.assign(service, {
      coordinatorFor: () => ({
        abandonAuthorization: () => {},
        configured: async () => false,
        authorize: async (params: {
          redirectUrl: URL;
          waitForCode: () => Promise<string>;
        }) => {
          redirects.push(params.redirectUrl);
          await params.waitForCode();
        },
      }),
    });

    const first = service.authorizeConnection(connection.id);
    const firstFailure = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(redirects).toHaveLength(1));

    const second = service.authorizeConnection(connection.id);
    const secondFailure = second.catch((error: unknown) => error);
    await vi.waitFor(() => expect(redirects).toHaveLength(2));

    expect(String(await firstFailure)).toContain("newer");
    await expect(
      fetch(`http://127.0.0.1:${redirects[0]!.port}/oauth/callback?code=late`),
    ).rejects.toThrow();

    // The replacement is untouched by its predecessor's teardown.
    await service.cancelAuthorization(connection.id);
    expect(String(await secondFailure)).toContain("cancelled");
  });

  /**
   * A managed connection is only ever opened on a thread's behalf, so
   * Settings could name one but never say what it offered -- while the Codex
   * list beneath it showed every tool of every server.
   */
  describe("listConnectionTools", () => {
    type ListTools = (
      params?: { cursor?: string },
    ) => Promise<{ tools: { name: string }[]; nextCursor?: string }>;

    function fakeUpstream(listTools: ListTools) {
      const close = vi.fn(async () => undefined);
      const connect = vi.fn(async () => ({
        client: { listTools: vi.fn(listTools), close },
        transport: { close: vi.fn(async () => undefined) },
      }));
      return { close, connect };
    }

    function serviceWith(params: {
      gatewayEnabled?: () => boolean;
      upstream: ReturnType<typeof fakeUpstream>;
    }) {
      const registry = temporaryRegistry();
      const connection = registry.create({
        displayName: "Datadog",
        serverUrl: "https://mcp.datadoghq.com/mcp",
      });
      const service = new McpConnectionGatewayService({
        gatewayEnabled: params.gatewayEnabled ?? (() => true),
        registry,
        settings: createSettings(),
        leaseManager: null,
      });
      services.push(service);
      // The session opener is the one seam with a network behind it; the
      // PwrSnap case below drives the real one.
      Object.assign(service, { connectUpstreamClient: params.upstream.connect });
      return { connection, registry, service };
    }

    it("pages through the server's list, closes its session, and keeps the answer", async () => {
      const upstream = fakeUpstream(async (params) =>
        params?.cursor === "page-2"
          ? { tools: [{ name: "search_logs" }] }
          : {
              tools: [{ name: "aggregate_spans" }, { name: "get_trace" }],
              nextCursor: "page-2",
            });
      const { connection, service } = serviceWith({ upstream });

      await expect(
        service.listConnectionTools({ connectionId: connection.id }),
      ).resolves.toMatchObject({
        connectionId: connection.id,
        tools: ["aggregate_spans", "get_trace", "search_logs"],
      });
      // Its own short-lived session: nothing is left open for a thread to
      // inherit or for the server to hold.
      expect(upstream.close).toHaveBeenCalledOnce();

      // A Settings visit should not cost a round trip per row per render.
      await service.listConnectionTools({ connectionId: connection.id });
      expect(upstream.connect).toHaveBeenCalledOnce();

      // Until the operator asks again.
      await service.listConnectionTools({
        connectionId: connection.id,
        refresh: true,
      });
      expect(upstream.connect).toHaveBeenCalledTimes(2);
    });

    it("lists a parked connection, but not while the gateway is off", async () => {
      let gatewayEnabled = true;
      const upstream = fakeUpstream(async () => ({ tools: [{ name: "a" }] }));
      const { connection, registry, service } = serviceWith({
        gatewayEnabled: () => gatewayEnabled,
        upstream,
      });

      // Parking withholds a connection from threads. Asking what it would
      // offer before offering it again is the operator's question, not a
      // thread's.
      registry.setEnabled(connection.id, false);
      await expect(
        service.listConnectionTools({ connectionId: connection.id }),
      ).resolves.toMatchObject({ tools: ["a"] });

      // Off means PwrAgent does not talk to these servers at all.
      gatewayEnabled = false;
      await expect(
        service.listConnectionTools({
          connectionId: connection.id,
          refresh: true,
        }),
      ).rejects.toThrow("MCP gateway is turned off");
    });

    it("does not cache a list that was in flight when the credentials went away", async () => {
      const answers: Array<(value: { tools: { name: string }[] }) => void> = [];
      const upstream = fakeUpstream(
        async () =>
          await new Promise((resolve) => {
            answers.push(resolve);
          }),
      );
      const { connection, service } = serviceWith({ upstream });

      const first = service.listConnectionTools({ connectionId: connection.id });
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      await service.disconnectConnection(connection.id);
      answers[0]({ tools: [{ name: "from_the_old_account" }] });
      await first;

      // The list above belongs to credentials that no longer exist. Serving
      // it from cache would describe a server this row cannot reach.
      const second = service.listConnectionTools({ connectionId: connection.id });
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]({ tools: [{ name: "fresh" }] });
      await expect(second).resolves.toMatchObject({ tools: ["fresh"] });
      expect(upstream.connect).toHaveBeenCalledTimes(2);
    });

    it("reports PwrSnap's revocation through the same session opener threads use", async () => {
      const settings = createSettings(createAuthorizedCredential());
      const service = new McpConnectionGatewayService({
        fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
        resolveInstallPaths: () => [],
        settings,
        leaseManager: null,
      });
      services.push(service);

      await expect(
        service.listConnectionTools({ connectionId: "pwrsnap" }),
      ).rejects.toThrow(PWRSNAP_SESSION_REVOKED_ERROR);
      expect(settings.clearPwrSnapMcpCredential).toHaveBeenCalled();
    });

    it("answers for the profile's owner broker", async () => {
      const upstream = fakeUpstream(async () => ({ tools: [{ name: "a" }] }));
      const { connection, service } = serviceWith({ upstream });
      const broker = service as unknown as {
        dispatchBrokerOperation: (op: unknown, params: unknown) => Promise<unknown>;
      };

      await broker.dispatchBrokerOperation("broker/list-tools", {
        connectionId: connection.id,
      });
      await broker.dispatchBrokerOperation("broker/list-tools", {
        connectionId: connection.id,
        refresh: true,
      });
      expect(upstream.connect).toHaveBeenCalledTimes(2);
      await expect(
        broker.dispatchBrokerOperation("broker/list-tools", {}),
      ).rejects.toThrow("Invalid MCP connection tool list request.");
    });
  });

  it("marks a connection for new threads without touching live sessions", async () => {
    const registry = temporaryRegistry();
    const connection = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    const service = new McpConnectionGatewayService({
      registry,
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);
    const closeConnectionSessions = vi.fn(async () => undefined);
    Object.assign(service, { closeConnectionSessions });
    const broker = service as unknown as {
      dispatchBrokerOperation: (op: unknown, params: unknown) => Promise<unknown>;
    };

    await expect(
      service.setConnectionSelectForNewThreads(connection.id, true),
    ).resolves.toMatchObject({ id: connection.id, selectForNewThreads: true });
    await expect(
      broker.dispatchBrokerOperation("broker/set-select-for-new-threads", {
        connectionId: connection.id,
        selectForNewThreads: false,
      }),
    ).resolves.toMatchObject({ selectForNewThreads: false });
    // It changes what a thread that does not exist yet starts with. Nothing
    // running is affected, so nothing running is closed.
    expect(closeConnectionSessions).not.toHaveBeenCalled();
    await expect(
      service.setConnectionSelectForNewThreads("ghost", true),
    ).rejects.toThrow("Unknown MCP connection");
  });
});
