import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { MobileDeviceStore } from "../mobile/device-store";
import { startMobileGateway } from "../mobile/server";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
it("pairs over verified TLS, authenticates websocket requests and denies revoked devices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mobile-tls-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  // Public, repository-owned test key. No platform OpenSSL dependency at runtime.
  const cert = await readFile(new URL("./fixtures/mobile-tls/cert.pem", import.meta.url));
  const key = await readFile(new URL("./fixtures/mobile-tls/key.pem", import.meta.url));
  const devices = new MobileDeviceStore(path.join(root, "devices.json"));
  const code = await devices.invite(["read"], "all");
  let calls = 0; let disconnects = 0;
  const gateway = await startMobileGateway({ host: "127.0.0.1", port: 0, tls: { cert, key }, devices,
    adapter: { gatewayId: "fixture-gateway", request: async (device, _connection, method) => { calls++; return { method, deviceId: device.id, scopes: device.scopes }; }, disconnected: async () => { disconnects++; }, subscribe: () => () => {} } });
  cleanups.push(() => gateway.close());
  const paired = await new Promise<{ token: string; deviceId: string }>((resolve, reject) => {
    const req = request({ hostname: "localhost", port: gateway.port, path: "/mobile/v1/pair", method: "POST", ca: cert }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject); req.end(JSON.stringify({ code, name: "Fixture phone" }));
  });
  expect(paired.token).toBeTruthy();
  const socket = new WebSocket(`wss://localhost:${gateway.port}/mobile/v1/socket`, { ca: cert, headers: { Authorization: `Bearer ${paired.token}` } });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const result = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())));
  socket.send(JSON.stringify({ id: "1", method: "hello", params: {} }));
  expect(JSON.parse(await result).result.deviceId).toBe(paired.deviceId); expect(calls).toBe(1);
  await devices.revoke(paired.deviceId);
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  socket.send(JSON.stringify({ id: "2", method: "thread", params: {} }));
  expect(await closed).toBe(4003); expect(calls).toBe(1); expect(disconnects).toBe(1);
});
