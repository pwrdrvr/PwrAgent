import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpIpcHttp, MCP_IPC_NO_RECONNECT, validateMcpIpcPlatform } from "../mcp-connections/mcp-ipc-http";
import { parseMcpIpcUrl } from "@pwragent/shared";

const desktop = resolve("apps/desktop");
const executable = join(desktop, "build/mcp-ipc-relay", `${process.platform}-${process.arch}`, `mcp-ipc-relay${process.platform === "win32" ? ".exe" : ""}`);
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  execFileSync(process.execPath, [join(desktop, "scripts/build-mcp-ipc-relay.mjs")], { stdio: "pipe" });
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
  const server = createServer(async (req, res) => {
    if (handler) { handler(res); return; }
    if (req.method === "GET") {
      notice = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ready\n\n");
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ method: req.method!, target: req.url!, authorization: req.headers.authorization, body });
    if (body.id === undefined) { res.writeHead(202).end(); return; }
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
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    for (let i = 0; i < payload.length; i += 7) res.write(payload.slice(i, i + 7));
    res.end();
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, done); });
  if (process.platform !== "win32") await chmod(path, 0o600);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  });
  const ipc = createMcpIpcHttp(url, { executable });
  cleanups.push(ipc.close);
  return { ipc, path, directory, url, requests, server, setHandler: (next: typeof handler) => { handler = next; }, notice: () => notice };
}

describe("verified HTTP MCP over local IPC", () => {
  it("initializes, discovers, calls, reads and gets prompts without losing metadata", async () => {
    const f = await fixture();
    const transport = new StreamableHTTPClientTransport(f.ipc.url, { fetch: f.ipc.fetch, reconnectionOptions: MCP_IPC_NO_RECONNECT });
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    cleanups.push(async () => { f.ipc.close(); await client.close(); });
    await client.connect(transport);
    expect(client.getInstructions()).toBe("Fixture server instructions");
    expect((await client.listTools()).tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { fixture: "tool" } });
    expect(await client.callTool({ name: "echo", arguments: { text: "hello ☃" } })).toMatchObject({ _meta: { fixture: "call" }, content: [{ annotations: { audience: ["user"] } }] });
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

  it("cancels an HTTP request and closes the connected relay", async () => {
    const f = await fixture();
    let closed = false;
    f.setHandler((res) => { res.on("close", () => { closed = true; }); });
    const controller = new AbortController();
    const response = f.ipc.fetch(f.ipc.url, { signal: controller.signal });
    await new Promise((done) => setTimeout(done, 50));
    controller.abort();
    await expect(response).rejects.toThrow();
    await expect.poll(() => closed).toBe(true);
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
    const squatter = join(f.directory, "squatter.sock");
    await writeFile(squatter, "not a socket", { mode: 0o600 });
    await attempts(squatter);
    expect(f.requests).toHaveLength(0);
  });

  it("rejects unsupported platforms on the executing instance", () => {
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("pipe:///pipe/name"), "linux")).toThrow("require Windows");
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("unix:///tmp/name"), "win32")).toThrow("require macOS or Linux");
    expect(() => validateMcpIpcPlatform(parseMcpIpcUrl("unix:///tmp/name"), "freebsd")).toThrow();
  });
});
