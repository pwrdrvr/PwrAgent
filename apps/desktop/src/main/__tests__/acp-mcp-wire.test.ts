import schema from "@agentclientprotocol/sdk/schema/schema.json";
import Ajv2020 from "ajv/dist/2020.js";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AcpAgentClient, type AcpJsonRpcTransport } from "../acp/acp-client";
import { AcpSessionStore } from "../acp/acp-session-store";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import type { McpCredentialVault } from "../mcp-connections/mcp-credential-vault";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Validate the exact outgoing params against the published ACP JSON schema.
// The SDK runtime's tolerant parser can discard malformed MCP entries; using
// the strict schema here reproduces Kimi's rejection instead of hiding it.
const validator = new Ajv2020({ strict: false, validateFormats: false });
validator.addSchema(schema, "acp");
const validateNew = validator.compile({ $ref: "acp#/$defs/NewSessionRequest" });
const validateLoad = validator.compile({ $ref: "acp#/$defs/LoadSessionRequest" });
function validatingTransport() {
  const fake = new FakeAcpAgentTransport({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  });
  const transport: AcpJsonRpcTransport = {
    request: async (method, params, timeout) => {
      const validate = method === "session/new" ? validateNew : method === "session/load" ? validateLoad : undefined;
      if (validate && !validate(params)) {
        throw new Error(`JSON-RPC -32602 Invalid params: ${JSON.stringify(validate.errors)}`);
      }
      return await fake.request(method, params, timeout);
    },
    onNotification: (listener) => fake.onNotification(listener),
    close: () => fake.close(),
  };
  return { transport, requests: fake.requests };
}

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("ACP MCP request serialization", () => {
  it("rejects the previously emitted record environment against the published wire schema", async () => {
    const { transport } = validatingTransport();
    cleanup.push(() => transport.close?.());
    await expect(transport.request("session/new", {
      cwd: "/repo", mcpServers: [{ name: "pwrgit", command: "node", args: [], env: { TOKEN: "test" } }],
    })).rejects.toThrow(/env/u);
  });

  it.each(["session/new", "session/load"])("serializes both local app bridges for %s", async (method) => {
    const db = openInMemoryStateDb();
    cleanup.push(() => db.close());
    const store = new AcpSessionStore(db);
    const git = new PwrGitConnectionService();
    const snap = new McpConnectionGatewayService({
      leaseManager: null,
      gatewayEnabled: () => true,
      settings: {} as never,
      credentialVault: {
        read: async () => ({
          resourceUrl: "http://127.0.0.1:51729/mcp",
          tokens: { access_token: "wire-test-token", token_type: "bearer" },
        }),
      } as unknown as McpCredentialVault,
    });
    cleanup.push(() => git.close(), () => snap.close());
    // Exercise the real local and managed registrations with fixture credentials.
    const gitBridge = await git.registerBridge("pwrgit", "local-session");
    const snapBridge = await snap.registerBridge("pwrsnap", "local-session");
    const originals = JSON.stringify([gitBridge.server, snapBridge.server]);
    const { transport, requests } = validatingTransport();
    cleanup.push(() => transport.close?.());
    const defaults = [
      gitBridge.server,
      { name: "no-env", command: "node" },
      { name: "remote", type: "http" as const, url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "test" }] },
      ...(method === "session/load" ? [snapBridge.server] : []),
    ];
    const client = new AcpAgentClient({
      backendId: "acp:kimi", store, transport,
      mcpServers: () => ({ servers: defaults }),
    });
    await client.initialize();
    if (method === "session/new") {
      await client.startSession({
        sessionId: "local-session", cwd: "/repo", executionMode: "default",
        additionalMcpRegistration: { servers: [snapBridge.server] },
      });
    } else {
      store.upsertSession({
        backendId: "acp:kimi", sessionId: "local-session", cwd: "/repo", title: "Wire test",
        createdAt: 1, updatedAt: 1, executionMode: "default", status: "idle",
      });
      await client.refreshSession(store.getSession("acp:kimi", "local-session")!);
    }
    const request = requests.find((request) => request.method === method)!;
    const servers = request.params?.mcpServers as Array<Record<string, unknown>>;
    for (const bridge of [gitBridge, snapBridge]) {
      expect(servers.find((server) => server.name === bridge.server.name)).toMatchObject({
        args: bridge.server.args,
        env: Object.entries(bridge.server.env).map(([name, value]) => ({ name, value })),
      });
    }
    expect(servers.find((server) => server.name === "no-env")).toEqual({ name: "no-env", command: "node", args: [], env: [] });
    expect(servers.find((server) => server.name === "remote")).toEqual(defaults[2]);
    // Host records remain usable by Codex configuration and process spawning.
    expect(JSON.stringify([gitBridge.server, snapBridge.server])).toBe(originals);
  });
});
