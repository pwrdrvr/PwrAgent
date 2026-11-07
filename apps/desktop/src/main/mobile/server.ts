import { createServer } from "node:https";
import type { ServerOptions } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import type { MobileEvent } from "../../../../../packages/shared/src/mobile-gateway";
import type { MobileDevice, MobileDeviceStore } from "./device-store";

export type MobileGatewayAdapter = {
  gatewayId: string;
  request(device: MobileDevice, connectionId: number, method: string, params: unknown, emit: (event: MobileEvent) => void): Promise<unknown>;
  disconnected(connectionId: number): Promise<void>;
  subscribe(device: MobileDevice, emit: (event: MobileEvent) => void): () => void;
};
/** TLS terminates here: no plaintext bearer fallback, origin cookies, or query tokens. */
export async function startMobileGateway(options: {
  host: string; port: number; tls: ServerOptions; devices: MobileDeviceStore; adapter: MobileGatewayAdapter;
}): Promise<{ port: number; close(): Promise<void> }> {
  const { devices, adapter } = options;
  const server = createServer(options.tls, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST" || request.url !== "/mobile/v1/pair" || request.headers.origin) { response.writeHead(404).end(); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) request.destroy(); else chunks.push(chunk); });
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { code?: unknown; name?: unknown };
          if (typeof body.code !== "string" || body.code.length > 256 || typeof body.name !== "string") throw new Error("Invalid pairing request");
          const { device, token } = await devices.pair(body.code, body.name);
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token, deviceId: device.id, gatewayId: adapter.gatewayId }));
        } catch { response.writeHead(403).end(JSON.stringify({ error: "Pairing code invalid or expired" })); }
      })();
    });
  });
  server.requestTimeout = 10_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  let connectionId = -1;
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
      const device = await devices.authenticate(token);
      if (!device || request.url !== "/mobile/v1/socket" || request.headers.origin) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        const owner = connectionId--;
        let closed = false; let inFlight = 0; let lastPing = Date.now();
        const send = (value: unknown) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(4000, "Client fell behind; reconnect"); return; }
          ws.send(JSON.stringify(value));
        };
        const emit = (event: MobileEvent) => send(event);
        ws.on("error", () => ws.close());
        const off = adapter.subscribe(device, emit);
        const watchdog = setInterval(() => {
          void devices.authenticate(token).then((current) => {
            if (!current) ws.close(4003, "Revoked");
            else if (Date.now() - lastPing > 45_000) ws.close(4000, "Heartbeat expired");
          }).catch(() => ws.close(4003, "Authentication unavailable"));
        }, 5000);
        ws.on("message", (data) => {
          void (async () => {
            let id = "";
            try {
              if (++inFlight > 8) throw new Error("Too many pending requests");
              const message = JSON.parse(data.toString()) as { id: unknown; method: unknown; params: unknown };
              if (typeof message.id !== "string" || message.id.length > 100 || typeof message.method !== "string") throw new Error("Invalid request");
              id = message.id;
              const current = await devices.authenticate(token);
              if (closed) return;
              if (!current) { ws.close(4003, "Revoked"); return; }
              lastPing = Date.now();
              const result = message.method === "ping" ? {} : await adapter.request(current, owner, message.method, message.params, emit);
              send({ id, result });
            } catch (error) {
              send({ id, error: { code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "request_failed", message: error instanceof Error ? error.message : "Request failed" } });
            } finally { --inFlight; }
          })();
        });
        ws.on("close", () => {
          closed = true; clearInterval(watchdog); off();
          void adapter.disconnected(owner).catch(() => undefined);
        });
      });
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, resolve); });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : options.port,
    close: async () => {
      for (const socket of sockets.clients) socket.close(1001, "Gateway stopping");
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}
