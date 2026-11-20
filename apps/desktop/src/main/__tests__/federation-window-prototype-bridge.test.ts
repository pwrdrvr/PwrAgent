import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FederationRouter } from "../federation/federation-router";
import { startWindowPrototypeBridge } from "../federation/federation-window-prototype-bridge";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(role: "source" | "viewer") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrwin-bridge-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ peerId: "pwr_fixture_peer", role }));
  const router = new FederationRouter({ localInstanceId: "pwr_fixture_local" });
  router.registerConnection({ peerId: "pwr_fixture_peer", capabilities: [], sendEnvelope: () => {} });
  let readyFile = "", connected = true;
  const requestPeer = vi.fn(async () => ({ value: "fixture-only" }));
  const bridge = await startWindowPrototypeBridge({ packaged: false, configPath, router,
    localInstanceId: "pwr_fixture_local", peerConnected: () => connected, requestPeer,
    log: { info: message => { readyFile = message.slice(message.indexOf("adapter ready: ") + 15); }, error: vi.fn() } });
  cleanups.push(() => bridge!.dispose());
  const ready = JSON.parse(await readFile(readyFile, "utf8")) as { url: string; token: string };
  const post = (method: string, value: unknown, headers = {}) => fetch(`${ready.url}/${method}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Pwrwin-Runtime-Token": ready.token, ...headers,
  }, body: JSON.stringify(value) });
  const route = (params: unknown = {}, sourceInstanceId = "pwr_fixture_peer") => router.routeEnvelope({ sourcePeerId: "pwr_fixture_peer", envelope: {
    kind: "request", id: "fixture-request", protocolVersion: 1, createdAt: Date.now(),
    sourceInstanceId, targetInstanceId: "pwr_fixture_local", method: "window.prototype.v1.open", params,
  } });
  return { bridge: bridge!, readyFile, url: ready.url, post, route, requestPeer, disconnect: () => { connected = false; } };
}

test("packaged app ignores the opt-in without reading its path", async () => {
  const error = vi.fn();
  const result = await startWindowPrototypeBridge({ packaged: true, configPath: "/nonexistent/private-config",
    router: new FederationRouter({ localInstanceId: "pwr_fixture_local" }), localInstanceId: "pwr_fixture_local",
    peerConnected: () => true, requestPeer: vi.fn(), log: { info: vi.fn(), error } });
  expect(result).toBeUndefined(); expect(error).toHaveBeenCalledOnce();
});
test("viewer adapter pins peer and methods, rejects browser origins and disconnected peers", async () => {
  const f = await fixture("viewer");
  expect((await f.post("rpc", { method: "open", params: {} }, { Origin: "http://evil.example" })).status).toBe(403);
  expect((await f.post("rpc", { method: "backend.readThread", params: {} })).status).toBe(400);
  expect((await f.post("rpc", { method: "open", params: {} }, { "X-Pwrwin-Runtime-Token": "bad" })).status).toBe(403);
  const ok = await f.post("rpc", { method: "open", params: { peerId: "ignored" } });
  expect(await ok.json()).toEqual({ value: "fixture-only" });
  expect(f.requestPeer).toHaveBeenCalledWith("pwr_fixture_peer", "window.prototype.v1.open", { peerId: "ignored" });
  f.disconnect(); expect((await f.post("rpc", { method: "open" })).status).toBe(400);
});
test("source requires a live helper and authenticated configured origin; shutdown rejects pending work", async () => {
  const f = await fixture("source");
  expect((await f.route()).status).toBe("rejected");
  await f.post("receive", {}); // Real helper readiness, rather than sleeping for a guessed delay.
  expect((await f.route({}, "pwr_spoofed_peer")).status).toBe("rejected");
  const routed = f.route({ fixture: true });
  const delivery = await (await f.post("receive", {})).json() as { requests: { id: string; peer: string; params: unknown }[] };
  expect(delivery.requests).toHaveLength(1);
  const request = delivery.requests[0]!;
  expect(request.peer).toBe("pwr_fixture_peer");
  expect((await f.post("reply", { id: request.id, result: { fixture: "live" } })).status).toBe(200);
  expect(await routed).toMatchObject({ status: "handled", response: { result: { fixture: "live" } } });
  const pending = f.route();
  await f.bridge.dispose();
  expect((await pending).status).toBe("rejected");
  await expect(readFile(f.readyFile)).rejects.toThrow();
});
test("non-ASCII token headers cannot throw through the HTTP authentication guard", async () => {
  const f = await fixture("viewer");
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${f.url}/rpc`, { method: "POST", headers: {
      "X-Pwrwin-Runtime-Token": "\u00e9".repeat(64),
    } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.once("error", reject);
    req.end("{}");
  });
  expect(status).toBe(403);
  expect(f.requestPeer).not.toHaveBeenCalled();
  expect((await f.post("rpc", { method: "open", params: {} })).status).toBe(200);
});
test("source does not turn the loopback bridge into a general outbound RPC proxy", async () => {
  const f = await fixture("source");
  expect((await f.post("rpc", { method: "open", params: {} })).status).toBe(404);
  expect((await f.post("reply", { id: "unknown", result: "a".repeat(65536) })).status).toBe(400);
  expect(f.requestPeer).not.toHaveBeenCalled();
});
