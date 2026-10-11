import { afterEach, expect, it, vi } from "vitest";
import { Gateway } from "./gateway";
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
afterEach(() => vi.useRealTimers());
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
