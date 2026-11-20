import { createServer, connect, type Socket } from "node:net";
import { Transform, type TransformCallback } from "node:stream";

// Owned loopback TCP proxy for measuring the actual encrypted stream under a
// byte-rate limit. No packet loss/RTT emulation, OS rules, or external listener.
export async function rateProxy(target: string, bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 10000) throw new Error("invalid_proxy_rate");
  const endpoint = new URL(target), sockets = new Set<Socket>();
  const stats = { bytes: 0, chunks: 0, peakChunk: 0 };
  class Limit extends Transform {
    timer?: ReturnType<typeof setTimeout>;
    _transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      stats.bytes += chunk.length; stats.chunks++; stats.peakChunk = Math.max(stats.peakChunk, chunk.length);
      this.timer = setTimeout(() => callback(null, chunk), chunk.length * 1000 / bytesPerSecond);
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void) { clearTimeout(this.timer); callback(error); }
  }
  const server = createServer(client => {
    const upstream = connect(Number(endpoint.port), "127.0.0.1"), a = new Limit(), b = new Limit();
    sockets.add(client); sockets.add(upstream);
    const close = () => { a.destroy(); b.destroy(); client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", close); upstream.on("error", close); a.on("error", close); b.on("error", close);
    client.on("close", close); upstream.on("close", close);
    client.pipe(a).pipe(upstream); upstream.pipe(b).pipe(client);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, stats,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
