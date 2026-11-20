import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import type { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";
import { sandboxerStub } from "./helpers/sandboxer-stub";

/**
 * Boat end to end through the gateway: a pasted key is checked and vaulted,
 * a thread's tool call reaches Boat with that key attached by main, and
 * nothing the thread or a window gets back contains it.
 */

const KEY = "boat_live_0123456789abcdefSECRET";
const BOAT = "builtin:boat";

const services: McpConnectionGatewayService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Sent = { method: string; url: string; authorization: string | null; body?: Record<string, unknown> };

function fakeBoat(acceptedKey = KEY) {
  const sent: Sent[] = [];
  let next = 0;
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    sent.push({
      method: init?.method ?? "GET",
      url: url.href,
      authorization: headers.get("authorization"),
      ...(body ? { body } : {}),
    });
    const answer = (status: number, value: Record<string, unknown>) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (headers.get("authorization") !== `Bearer ${acceptedKey}`) {
      return answer(401, { ok: false, code: "unauthorized", error: "bad key" });
    }
    const segments = url.pathname.replace("/api/v1/", "").split("/");
    if (segments[0] === "limits") {
      return answer(200, { ok: true, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 5 });
    }
    if (segments[0] === "sandboxes" && segments.length === 1 && init?.method === "POST") {
      const id = `bx_${next++}`;
      return answer(200, {
        ok: true,
        // A careless server echoing the caller's key must not reach the agent.
        sandbox: { id, name: `box-${id}`, state: "ready", type: "small", sshEndpoint: `ssh://${KEY}@host` },
      });
    }
    if (segments[2] === "files") {
      return answer(200, {
        ok: true, path: "/app/theme.css", encoding: "utf8", size: 64,
        content: `box_shadow_blur_radius: 4px; /* ${KEY} */`,
      });
    }
    if (segments[2] === "host") {
      return answer(200, {
        ok: true, port: 3000, access: "private", isProtected: true,
        url: `https://${segments[1]}-3000.on.boat.dev/?_token=t`,
      });
    }
    return answer(200, { ok: true, sandbox: { id: segments[1], state: "ready", type: "small" } });
  };
  return { fetchFn, sent };
}

function harness(boat = fakeBoat()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-boat-gateway-"));
  directories.push(directory);
  const registry = new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") });
  registry.setSandboxerTransport("local_cli");
  const stored = new Map<string, Record<string, string>>();
  const stdioSecrets = {
    read: async (connectionId: string) => stored.get(connectionId) ?? {},
    write: async (connectionId: string, values: Record<string, string>) => {
      stored.set(connectionId, values);
    },
  } as unknown as McpStdioSecretVault;
  type Row = { connectionId: string; sandboxId: string; threadId: string; backend?: string; status?: string };
  const rows: Row[] = [];
  const threadSandboxes = {
    recordCreated: (row: Row) => {
      rows.push({ ...row });
    },
    pendingForThread: (scope: { backend: string; threadId: string }) =>
      rows.filter((row) => row.threadId === scope.threadId && row.status === undefined),
    markOutcome: (outcome: { connectionId: string; sandboxId: string; status: string }) => {
      for (const row of rows) {
        if (row.connectionId === outcome.connectionId && row.sandboxId === outcome.sandboxId) {
          row.status = outcome.status;
        }
      }
    },
  };
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    registry,
    settings: {
      clearMcpConnectionCredentials: vi.fn(async () => undefined),
      clearPwrSnapMcpCredential: vi.fn(async () => undefined),
      resolveMcpConnectionCredentials: vi.fn(async () => undefined),
      resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
      resolvePwrGitMcpCredential: vi.fn(async () => undefined),
      clearPwrGitMcpCredential: vi.fn(async () => undefined),
      saveMcpConnectionCredentials: vi.fn(async () => undefined),
      savePwrSnapMcpCredential: vi.fn(async () => undefined),
    },
    leaseManager: null,
    fetchFn: boat.fetchFn,
    stdioSecrets,
    threadSandboxes: threadSandboxes as never,
  });
  services.push(service);
  const internals = service as unknown as {
    grants: Map<string, { connectionId: string; threadId?: string }>;
    dispatchBridgeOperation: (
      token: string,
      grant: { connectionId: string; threadId?: string },
      operation: unknown,
      params: unknown,
    ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
  };
  const call = async (threadId: string | undefined, name: string, args: Record<string, unknown> = {}) => {
    const token = `token-${threadId ?? "settings"}`;
    const grant = { connectionId: BOAT, ...(threadId === undefined ? {} : { threadId }) };
    internals.grants.set(token, grant);
    return await internals.dispatchBridgeOperation(token, grant, "tools/call", { name, arguments: args });
  };
  return { boat, call, registry, rows, service, stored };
}

describe("Boat through the MCP gateway", () => {
  it("stores a key only after Boat accepts it, and never hands it back", async () => {
    const { boat, service, stored } = harness();

    await expect(service.connectBoat("boat_wrong_0123456789abcdef")).rejects.toThrow("Boat rejected that API key");
    expect(stored.get(BOAT)).toBeUndefined();
    await expect(service.connectBoat("not a key")).rejects.toThrow("does not look like a Boat API key");
    // A string that is not shaped like a key is never sent anywhere.
    expect(boat.sent).toHaveLength(1);

    const status = await service.connectBoat(`  ${KEY}\n`);
    expect(stored.get(BOAT)).toEqual({ BOAT_API_KEY: KEY });
    expect(status).toMatchObject({ id: BOAT, configured: true, state: "ready" });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(await service.listConnections())).not.toContain(KEY);

    await service.disconnectConnection(BOAT);
    expect(stored.get(BOAT)).toEqual({});
    expect((await service.listConnections()).find((entry) => entry.id === BOAT))
      .toMatchObject({ configured: false });
  });

  it("makes a thread's request itself, with the key, the policy, and no key in the answer", async () => {
    const { boat, call, registry, rows, service } = harness();
    registry.setEnabled(BOAT, true);
    await service.connectBoat(KEY);
    boat.sent.length = 0;

    const created = await call("thread-a", "create_sandbox", { name: "build", public: true, noEnv: false });
    expect(created.isError).not.toBe(true);
    expect(boat.sent).toHaveLength(1);
    expect(boat.sent[0]).toMatchObject({
      method: "POST",
      url: "https://boat.dev/api/v1/sandboxes",
      authorization: `Bearer ${KEY}`,
      body: { noEnv: true, type: "small" },
    });
    expect(boat.sent[0]?.body).not.toHaveProperty("public");
    expect(JSON.stringify(created)).not.toContain(KEY);
    expect(rows).toMatchObject([{ connectionId: BOAT, sandboxId: "bx_0", threadId: "thread-a" }]);

    // A hosted port is never public, whatever the agent asks for.
    const hosted = await call("thread-a", "host_port", { sandboxId: "bx_0", port: 3000, public: true });
    expect(hosted.isError).not.toBe(true);
    expect(boat.sent.at(-1)?.body).toMatchObject({ public: false });

    // A file comes back as written, less the key PwrAgent itself sent.
    const file = await call("thread-a", "read_file", { sandboxId: "bx_0", path: "/app/theme.css" });
    expect(JSON.stringify(file)).toContain("box_shadow_blur_radius: 4px;");
    expect(JSON.stringify(file)).toContain("[Boat key removed]");
    expect(JSON.stringify(file)).not.toContain(KEY);

    // Another thread cannot reach it, and Boat is never asked.
    const before = boat.sent.length;
    await expect(call("thread-b", "get_sandbox", { sandboxId: "bx_0" })).resolves.toMatchObject({ isError: true });
    await expect(call("thread-b", "delete_sandbox", { sandboxId: "bx_0" })).resolves.toMatchObject({ isError: true });
    // A session with no thread, such as a Settings tool listing, creates nothing.
    await expect(call(undefined, "create_sandbox", {})).resolves.toMatchObject({ isError: true });
    expect(boat.sent).toHaveLength(before);

    // The profile's cap is read on each call.
    registry.setBoatSandboxPolicy({ maxType: "small" });
    await expect(call("thread-a", "create_sandbox", { type: "large" })).resolves.toMatchObject({ isError: true });
    expect(boat.sent).toHaveLength(before);
  });
});
