import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createFabric } from "./fabric.mts";

// Transport-only measurement: opaque, fixed-size fixture payloads, no capture
// or browser decode. Actual Noise/WebSocket bytes pass through the TCP proxy.
const output = resolve(process.argv[2] ?? ".local/remote-window/datagrams/relay-transport.json");
const results = [];
for (const proxyBytesPerSecond of [undefined, 250000]) {
  let received = 0, sequence = 0, sentPayloadBytes = 0;
  let done = false, ping: Promise<void> | undefined, probeError: unknown;
  const pingMs: number[] = [], batchMs: number[] = [];
  const fabric = await createFabric(async p => p, async (_role, _batch) => { received++; }, { proxyBytesPerSecond });
  try {
    // Valid prototype fragment header and deterministic synthetic bytes. The
    // transport treats the body as opaque; this is not an image-decode benchmark.
    const data = Buffer.alloc(1028);
    data.writeUInt32BE(0x50574431, 0); data.writeUInt32BE(7, 4); data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 16); data.writeUInt16BE(2, 18); data.writeUInt32BE(1000, 20);
    for (let i = 28; i < data.length; i++) data[i] = (i * 53) & 255;
    const items = Array(8).fill(data.toString("base64"));
    const began = performance.now(), deadline = began + 5000;
    ping = (async () => {
      while (!done) {
        const start = performance.now(); await fabric.signal({ probe: true }); pingMs.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })().catch(error => { probeError = error; done = true; });
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (performance.now() < deadline) {
        const start = performance.now();
        await fabric.push("source", { epoch: 7, sequence: ++sequence, channel: "media", items });
        sentPayloadBytes += data.length * items.length; batchMs.push(performance.now() - start);
      }
    }));
    done = true; await ping;
    if (probeError) throw probeError;
    const wallMs = performance.now() - began;
    const distribution = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
    };
    results.push({ proxyBytesPerSecond: proxyBytesPerSecond ?? null, wallMs, received, sentPayloadBytes,
      fragmentBytesPerSecond: sentPayloadBytes * 1000 / wallMs, pingMs: distribution(pingMs), batchMs: distribution(batchMs), federationWire: { ...fabric.wire } });
  } finally { done = true; await fabric.close(); await ping; }
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), crossHost: false,
  notes: "Six pipelined 8-fragment pushes; 5s offered load. 2Mbps cap per direction per TCP connection. No injected RTT or packet loss. Media payload includes fragment headers, excludes base64/envelopes/Noise/WS/TCP. Ping is a competing Federation RPC. No WebRTC, capture, decode or photons.", results }));
console.log(JSON.stringify(results));
