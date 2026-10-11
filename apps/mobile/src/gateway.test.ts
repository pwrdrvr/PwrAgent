import { afterEach, expect, it, vi } from "vitest";
import { createNativeWebSocket, Gateway } from "./gateway";
class Socket {
  readyState = 1;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  sent: Array<{ id: string; method: string }> = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  reply(result: unknown) { this.onmessage?.({ data: JSON.stringify({ id: this.sent.at(-1)!.id, result }) }); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("reconnects with the same credential and rejects requests on connection loss", async () => {
  vi.useFakeTimers(); const sockets: Socket[] = []; const tokens: string[] = [];
  const client = new Gateway({ url: "https://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, (_url, token) => { tokens.push(token); const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  client.connect(); client.connect(); expect(sockets).toHaveLength(1);
  sockets[0]!.onopen?.(); sockets[0]!.reply({ protocol: 1, gatewayId: "gateway", deviceId: "phone", scopes: ["read"], machines: [], capabilities: [] });
  await Promise.resolve();
  const pending = client.rpc("thread", {}); const failed = expect(pending).rejects.toThrow("Connection lost");
  sockets[0]!.close(); await failed; await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2); expect(tokens).toEqual(["credential", "credential"]);
  client.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(sockets).toHaveLength(2);
});
it("fails closed on gateway identity mismatch and revocation", async () => {
  vi.useFakeTimers(); const socket = new Socket(); let count = 0;
  const client = new Gateway({ url: "https://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, () => { count++; return socket as unknown as WebSocket; });
  client.connect(); socket.onopen?.(); socket.reply({ protocol: 1, gatewayId: "other", deviceId: "phone" });
  await Promise.resolve(); await vi.advanceTimersByTimeAsync(60_000); expect(count).toBe(1); expect(client.hello).toBeUndefined();
});
it("refuses plaintext gateway URLs before creating a socket", () => {
  let calls = 0; const client = new Gateway({ url: "http://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, () => { calls++; throw new Error("must not dial"); });
  expect(() => client.connect()).toThrow("HTTPS"); expect(calls).toBe(0);
});
it("connects a native transport that adds Origin by default without relaxing the gateway's browser rejection", async () => {
  vi.useFakeTimers(); const sockets: Socket[] = [];
  class NativeSocket extends Socket {
    accepted: boolean;
    constructor(url: string, _protocols: string[], options: { headers: Record<string, string> }) {
      super();
      // SocketRocket and Android inject the endpoint Origin unless supplied.
      const originHeader = Object.keys(options.headers).find((key) => key.toLowerCase() === "origin");
      const origin = originHeader === undefined ? new URL(url).origin : options.headers[originHeader];
      this.accepted = !origin && options.headers.Authorization === "Bearer credential";
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", NativeSocket);
  const state = vi.fn();
  const client = new Gateway({ url: "https://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, createNativeWebSocket);
  client.onState = state; client.connect();
  expect((sockets[0] as NativeSocket).accepted).toBe(true);
  sockets[0]!.onopen?.(); sockets[0]!.reply({ protocol: 1, gatewayId: "gateway", deviceId: "phone" });
  await Promise.resolve(); expect(state).toHaveBeenLastCalledWith("Connected"); client.stop();
});
it("preserves the native failure and retry delay in visible diagnostics without exposing the credential", () => {
  vi.useFakeTimers(); const socket = new Socket();
  const client = new Gateway({ url: "https://gateway.example", token: "private-credential", deviceId: "phone", gatewayId: "gateway" }, () => socket as unknown as WebSocket);
  const issues = vi.fn(); client.onConnectionError = issues; client.connect();
  (socket.onerror as unknown as (event: { message: string }) => void)({ message: "Server returned HTTP 401 for private-credential" });
  expect(issues).toHaveBeenLastCalledWith(expect.stringMatching(/HTTP 401.*\[redacted\].*Retrying in \d+s/));
  expect(JSON.stringify(issues.mock.calls)).not.toContain("private-credential"); client.stop();
});
it("reports a failed hello separately from connecting and clears the issue after successful authentication", async () => {
  vi.useFakeTimers(); const sockets: Socket[] = [];
  const client = new Gateway({ url: "https://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const state = vi.fn(); const issues = vi.fn(); client.onState = state; client.onConnectionError = issues; client.connect();
  sockets[0]!.onopen?.(); expect(state).toHaveBeenLastCalledWith("Authenticating");
  sockets[0]!.onmessage?.({ data: JSON.stringify({ id: "1", error: { code: "unavailable", message: "Gateway is not ready" } }) });
  await vi.advanceTimersByTimeAsync(1000);
  expect(issues).toHaveBeenCalledWith(expect.stringContaining("Gateway authentication failed: Gateway is not ready"));
  sockets[1]!.onopen?.(); sockets[1]!.reply({ protocol: 1, gatewayId: "gateway", deviceId: "phone" });
  await Promise.resolve(); expect(state).toHaveBeenLastCalledWith("Connected"); expect(issues).toHaveBeenLastCalledWith(""); client.stop();
});
it("ignores a stale transport error after a newer connection opens", async () => {
  vi.useFakeTimers(); const sockets: Socket[] = [];
  const client = new Gateway({ url: "https://gateway.example", token: "credential", deviceId: "phone", gatewayId: "gateway" }, () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const issues = vi.fn(); client.onConnectionError = issues; client.connect(); sockets[0]!.close();
  await vi.advanceTimersByTimeAsync(1000); issues.mockClear();
  sockets[0]!.onerror?.(); expect(issues).not.toHaveBeenCalled(); expect(sockets[1]!.readyState).toBe(1); client.stop();
});
