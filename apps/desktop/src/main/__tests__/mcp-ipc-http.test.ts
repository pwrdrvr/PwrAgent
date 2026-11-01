import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpIpcHttp, MCP_IPC_NO_RECONNECT, validateMcpIpcPlatform } from "../mcp-connections/mcp-ipc-http";
import { parseMcpIpcUrl } from "@pwragent/shared";
import { probeMcpConnectionUrl } from "../mcp-connections/mcp-connection-probe";

const desktop = resolve("apps/desktop");
const executable = join(desktop, "build/mcp-ipc-relay", `${process.platform}-${process.arch}`, `mcp-ipc-relay${process.platform === "win32" ? ".exe" : ""}`);
const identityExecutable = join(executable, "..", process.platform === "win32" ? "mcp-ipc-identity-test.exe" : "mcp-ipc-identity-test");
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  execFileSync(process.execPath, [join(desktop, "scripts/build-mcp-ipc-relay.mjs")], { stdio: "pipe" });
  execFileSync(process.execPath, [join(desktop, "scripts/build-mcp-ipc-relay.mjs"), "--identity-test"], { stdio: "pipe" });
}, 60_000);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-ipc-")));
  await chmod(directory, 0o700);
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pwragent-test-${randomUUID()}` : join(directory, "server.sock");
  const url = process.platform === "win32" ? `pipe:///pipe/${path.slice(9)}#/mcp/a%2Fb?q=%23%26` : `unix://${path}#/mcp/a%2Fb?q=%23%26`;
  const requests: { method: string; target: string; authorization?: string; body: Record<string, any> }[] = [];
  let notice: ServerResponse | undefined;
  let handler: ((res: ServerResponse) => void) | undefined;
  let sse = false;
  let connections = 0;
  let holdCalls = false;
  const heldCalls = new Map<number, ServerResponse>();
  const server = createServer(async (req, res) => {
    if (handler) { handler(res); return; }
    if (req.method === "GET") {
      notice = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ready\n\n");
      return;
    }
    let text = "";
    req.setEncoding("utf8");
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ method: req.method!, target: req.url!, authorization: req.headers.authorization, body });
    if (body.method === "notifications/cancelled") {
      const held = heldCalls.get(body.params.requestId);
      if (held) {
        heldCalls.delete(body.params.requestId);
        held.writeHead(200, { "content-type": "application/json" });
        held.end(JSON.stringify({ jsonrpc: "2.0", id: body.params.requestId, error: { code: -32800, message: "Cancelled fixture call" } }));
      }
    }
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    if (holdCalls && body.method === "tools/call") { heldCalls.set(body.id, res); return; }
    let result: unknown;
    switch (body.method) {
      case "initialize": result = {
        protocolVersion: body.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: "Local fixture", version: "1" }, instructions: "Fixture server instructions",
      }; break;
      case "tools/list": result = { tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { fixture: "tool" } }] }; break;
      case "tools/call": result = { content: [{ type: "text", text: JSON.stringify(body.params.arguments), annotations: { audience: ["user"] } }], _meta: { fixture: "call" } }; break;
      case "resources/list": result = { resources: [{ uri: "fixture:///readme", name: "README", mimeType: "text/plain", _meta: { fixture: "resource" } }] }; break;
      case "resources/read": result = { contents: [{ uri: "fixture:///readme", text: "fixture", mimeType: "text/plain" }], _meta: { fixture: "read" } }; break;
      case "prompts/list": result = { prompts: [{ name: "greet", _meta: { fixture: "prompt" } }] }; break;
      case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: "hello" } }], _meta: { fixture: "get" } }; break;
      default: result = {};
    }
    // Every response is fragmented across writes, including JSON UTF-8.
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const response = sse ? `event: message\ndata: ${payload}\n\n` : payload;
    res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "fixture-session" });
    for (let i = 0; i < response.length; i += 7) res.write(response.slice(i, i + 7));
    res.end();
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  cleanups.push(async () => {
    const closed = new Promise<void>((done) => server.close(() => done()));
    // Include connections rejected by native verification before HTTP starts.
    for (const socket of sockets) socket.destroy();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  if (process.platform === "win32") {
    execFileSync(identityExecutable, ["secure-fixture", path, String(process.pid)], { stdio: "pipe" });
  } else {
    await chmod(path, 0o600);
  }
  const ipc = createMcpIpcHttp(url, { executable });
  cleanups.push(ipc.close);
  return { ipc, path, directory, url, requests, server, holdCalls: () => { holdCalls = true; }, setSse: () => { sse = true; }, connections: () => connections, setHandler: (next: typeof handler) => { handler = next; }, notice: () => notice };
}

describe("verified HTTP MCP over local IPC", () => {
  it("fails closed when native identity lookup is unreadable", () => {
    // Only replace the executable basename, not its containing directory.
    const result = spawnSync(join(executable, "..", process.platform === "win32" ? "mcp-ipc-identity-test.exe" : "mcp-ipc-identity-test"), ["unreadable"], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("MCP IPC:");
  });

  it.skipIf(process.platform === "win32" || process.geteuid?.() !== 0)("rejects an actual foreign Unix peer before sending any byte", () => {
    const result = spawnSync(join(executable, "..", "mcp-ipc-identity-test"), ["wrong-user"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("connected socket peer belongs to another user");
  });

  it.skipIf(process.platform !== "win32")("rejects foreign SIDs and remote pipe names in the native verifier", () => {
    const program = join(executable, "..", "mcp-ipc-identity-test.exe");
    for (const scenario of ["wrong-user", "remote"]) {
      const result = spawnSync(program, [scenario], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    }
  });

  it.skipIf(process.platform !== "win32")("rejects a real connected pipe squatter with a foreign owner SID", (context) => {
    const result = spawnSync(join(executable, "..", "mcp-ipc-identity-test.exe"), ["squatter"], { encoding: "utf8" });
    // CI's elevated runner can create this fixture. An ordinary local user
    // must not elevate itself or alter accounts to manufacture the fixture.
    if (result.status === 77 && !process.env.CI) context.skip();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pipe owner is another user");
  });
  it("initializes, discovers, calls, reads and gets prompts without losing metadata", async () => {
    const f = await fixture();
    const transport = new StreamableHTTPClientTransport(f.ipc.url, { fetch: f.ipc.fetch, reconnectionOptions: MCP_IPC_NO_RECONNECT });
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    cleanups.push(async () => { f.ipc.close(); await client.close(); });
    await client.connect(transport);
    expect(client.getInstructions()).toBe("Fixture server instructions");
    expect((await client.listTools()).tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { fixture: "tool" } });
    // Cross several native 16 KiB buffers in both directions, with UTF-8
    // and fragmented HTTP response writes, while the other pipe reader waits.
    const args = { text: "hello ☃".repeat(4096) };
    const call = await client.callTool({ name: "echo", arguments: args });
    expect(call).toMatchObject({
      _meta: { fixture: "call" }, content: [{ type: "text", annotations: { audience: ["user"] } }],
    });
    const echoed = (call.content as { text: string }[])[0]!.text;
    const expected = JSON.stringify(args);
    // Keep failure output bounded while checking every byte of the payload.
    expect({ length: echoed.length, digest: createHash("sha256").update(echoed).digest("hex") }).toEqual({
      length: expected.length, digest: createHash("sha256").update(expected).digest("hex"),
    });
    expect((await client.listResources()).resources[0]).toMatchObject({ _meta: { fixture: "resource" } });
    expect(await client.readResource({ uri: "fixture:///readme" })).toMatchObject({ _meta: { fixture: "read" } });
    expect((await client.listPrompts()).prompts[0]).toMatchObject({ _meta: { fixture: "prompt" } });
    expect(await client.getPrompt({ name: "greet" })).toMatchObject({ _meta: { fixture: "get" } });
    expect(f.requests.every((r) => r.target === "/mcp/a%2Fb?q=%23%26")).toBe(true);
    let changed = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed = true; });
    await expect.poll(() => !!f.notice()).toBe(true);
    f.notice()!.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await expect.poll(() => changed).toBe(true);
    f.ipc.close();
    await expect(f.ipc.fetch(f.ipc.url)).rejects.toThrow();
  });

  it("rejects redirects and arbitrary network/discovery targets without forwarding credentials", async () => {
    const f = await fixture();
    f.setHandler((res) => res.writeHead(307, { location: "https://attacker.invalid/token" }).end());
    await expect(f.ipc.fetch("https://attacker.invalid/token", { headers: { authorization: "Bearer fixture" } })).rejects.toThrow("cannot change endpoint");
    await expect(f.ipc.fetch(f.ipc.url, { method: "POST", headers: { authorization: "Bearer fixture" }, body: "{}" })).rejects.toThrow("redirects");
    await expect(f.ipc.fetch(f.ipc.url)).rejects.toThrow();
  });

  it("offers native bearer bootstrap without consuming a ticket or invoking OAuth discovery", async () => {
    const f = await fixture();
    f.setHandler((res) => res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://attacker.invalid/oauth"' }).end("native approval required"));
    const network = vi.fn(async () => new Response("unexpected network"));
    const probe = await probeMcpConnectionUrl(f.url, network, { ipcExecutable: executable });
    expect(probe, JSON.stringify(probe)).toMatchObject({ ok: true, needsIpcBearer: true, authMode: "none" });
    expect(network).not.toHaveBeenCalled();
  });

  it("sends a manually approved token only over verified IPC and redacts HTTP auth error bodies", async () => {
    const f = await fixture();
    const ipc = createMcpIpcHttp(f.url, { executable, bearerToken: "native-session-ticket" });
    cleanups.push(ipc.close);
    const response = await ipc.fetch(ipc.url, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    await response.json();
    expect(f.requests[0]?.authorization).toBe("Bearer native-session-ticket");
    await expect(ipc.fetch("https://attacker.invalid/")).rejects.toThrow("cannot change endpoint");
    f.setHandler((res) => res.writeHead(401).end("echoed private token: native-session-ticket"));
    const rejected = await ipc.fetch(ipc.url, { method: "POST", body: "{}" });
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain("native-session-ticket");
  });

  it("accepts fragmented SSE POST responses and stops when the notification stream ends", async () => {
    const f = await fixture();
    f.setSse();
    const transport = new StreamableHTTPClientTransport(f.ipc.url, { fetch: f.ipc.fetch, reconnectionOptions: MCP_IPC_NO_RECONNECT });
    const client = new Client({ name: "sse-test", version: "1" }, { capabilities: {} });
    cleanups.push(async () => { f.ipc.close(); await client.close(); });
    await client.connect(transport);
    expect((await client.listTools()).tools[0]?.name).toBe("echo");
    await expect.poll(() => !!f.notice()).toBe(true);
    const count = f.connections();
    const disconnected = new Promise<void>((done) => { client.onerror = () => done(); });
    f.notice()!.end();
    await disconnected;
    await expect(f.ipc.fetch(f.ipc.url)).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
    expect(f.connections()).toBe(count);
  });

  it("cancels an HTTP request and closes the connected relay", async () => {
    const f = await fixture();
    let closed = false;
    const received = new Promise<void>((done) => {
      f.setHandler((res) => { res.on("close", () => { closed = true; }); done(); });
    });
    const controller = new AbortController();
    const response = f.ipc.fetch(f.ipc.url, { signal: controller.signal });
    await received;
    controller.abort();
    await expect(response).rejects.toThrow();
    await expect.poll(() => closed).toBe(true);
  });

  it("forwards SDK tool cancellation once without replaying the call", async () => {
    const f = await fixture();
    f.holdCalls();
    const transport = new StreamableHTTPClientTransport(f.ipc.url, { fetch: f.ipc.fetch, reconnectionOptions: MCP_IPC_NO_RECONNECT });
    const client = new Client({ name: "cancel-test", version: "1" }, { capabilities: {} });
    cleanups.push(async () => { f.ipc.close(); await client.close(); });
    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool({ name: "echo" }, undefined, { signal: controller.signal });
    const rejected = expect(call).rejects.toThrow();
    await expect.poll(() => f.requests.some((r) => r.body.method === "tools/call")).toBe(true);
    controller.abort(new Error("operator cancelled"));
    await rejected;
    await expect.poll(() => f.requests.filter((r) => r.body.method === "notifications/cancelled").length).toBe(1);
    expect(f.requests.filter((r) => r.body.method === "tools/call")).toHaveLength(1);
    expect((await client.listTools()).tools[0]?.name).toBe("echo");
  });

  it("fails missing endpoints and never retries a failed request", async () => {
    const f = await fixture();
    f.setHandler((res) => res.destroy());
    await expect(f.ipc.fetch(f.ipc.url, { method: "POST", body: "{}" })).rejects.toThrow();
    await expect(f.ipc.fetch(f.ipc.url)).rejects.toThrow();
    const missing = createMcpIpcHttp(f.url.replace("server.sock", "missing.sock").replace("pwragent-test-", "missing-"), { executable });
    cleanups.push(missing.close);
    await expect(missing.fetch(missing.url)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects unsafe paths, symlinks, broad permissions and regular-file squatters before HTTP", async () => {
    const f = await fixture();
    const attempts = async (path: string) => {
      const ipc = createMcpIpcHttp(`unix://${path}#/mcp`, { executable });
      cleanups.push(ipc.close);
      await expect(ipc.fetch(ipc.url, { method: "POST", headers: { authorization: "Bearer must-not-leak" }, body: "{}" })).rejects.toThrow();
    };
    await chmod(f.path, 0o666);
    await attempts(f.path);
    await chmod(f.path, 0o600);
    await chmod(f.directory, 0o755);
    await attempts(f.path);
    await chmod(f.directory, 0o700);
    const link = join(f.directory, "link.sock");
    await symlink(f.path, link);
    await attempts(link);
    const parentLink = join(f.directory, "alias");
    await symlink(f.directory, parentLink);
    await attempts(join(parentLink, "server.sock"));
    const squatter = join(f.directory, "squatter.sock");
    await writeFile(squatter, "not a socket", { mode: 0o600 });
    await attempts(squatter);
    expect(f.requests).toHaveLength(0);
  });

  it.skipIf(process.platform !== "darwin")("rejects macOS extended allow ACLs even when mode bits are private", async () => {
    const f = await fixture();
    execFileSync("/bin/chmod", ["+a", "everyone allow list", f.directory]);
    await expect(f.ipc.fetch(f.ipc.url, { method: "POST", body: "{}" })).rejects.toThrow("extended allow ACL");
    expect(f.requests).toHaveLength(0);
  });

  it("rejects unsupported platforms on the executing instance", () => {
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("pipe:///pipe/name"), "linux")).toThrow("require Windows");
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("unix:///tmp/name"), "win32")).toThrow("require macOS or Linux");
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("unix:///tmp/name"), "freebsd")).toThrow();
  });
});
