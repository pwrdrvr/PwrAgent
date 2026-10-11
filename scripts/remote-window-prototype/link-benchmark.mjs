import net from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

// Real loopback TCP; application delays emulate bandwidth/latency/retransmit
// stalls. This is not kernel packet loss and does not benchmark WAN TCP/WebRTC.
const bytes = await readFile(process.argv[2]);
const output = process.argv[3];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] ?? 0;
const results = [];
for (const scenario of [
  { name: "loopback-unshaped", mbps: 1000, oneWayMs: 0, stallEvery: 0 },
  { name: "emulated-10Mbps-50msRTT", mbps: 10, oneWayMs: 25, stallEvery: 0 },
  { name: "emulated-2Mbps-100msRTT-3pct-stalls", mbps: 2, oneWayMs: 50, stallEvery: 33 },
]) {
  let pending = null, dropped = 0, produced = 0, done = false, payloadBytes = 0, wireBytes = 0;
  let control = null, buffer = Buffer.alloc(0), chunkIndex = 0;
  const frames = [], events = [], delays = [];
  const server = net.createServer(socket => socket.on("data", data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const size = buffer.readUInt32BE(0), packet = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      const kind = packet[0], created = packet.readDoubleBE(1), final = packet[9];
      delays.push(sleep(scenario.oneWayMs).then(() => {
        if (kind === 1 && final) frames.push(performance.now() - created);
        if (kind === 2) events.push(performance.now() - created);
      }));
    }
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = net.createConnection(server.address().port, "127.0.0.1"); await once(client, "connect");
  const start = performance.now();
  const producer = setInterval(() => {
    if (pending) dropped++;
    pending = { created: performance.now(), bytes }; produced++;
  }, 1000 / 30);
  const heartbeat = setInterval(() => { control ??= { created: performance.now(), bytes: Buffer.from("turn-event") }; }, 100);
  const stop = setTimeout(() => { done = true; clearInterval(producer); clearInterval(heartbeat); }, 3000);
  async function send(kind, created, chunk, final) {
    const header = Buffer.alloc(14);
    header.writeUInt32BE(chunk.length + 10); header[4] = kind; header.writeDoubleBE(created, 5); header[13] = final ? 1 : 0;
    const packet = Buffer.concat([header, chunk]);
    if (!client.write(packet)) await once(client, "drain");
    wireBytes += packet.length; payloadBytes += chunk.length;
    const stall = scenario.stallEvery && ++chunkIndex % scenario.stallEvery === 0 ? scenario.oneWayMs * 2 : 0;
    await sleep(packet.length * 8 / (scenario.mbps * 1000) + stall);
  }
  while (!done || pending) {
    if (!pending) { await sleep(1); continue; }
    const frame = pending; pending = null;
    for (let offset = 0; offset < frame.bytes.length; offset += 16384) {
      if (control) {
        const c = control; control = null;
        await send(2, c.created, c.bytes, true);
      }
      const chunk = frame.bytes.subarray(offset, offset + 16384);
      await send(1, frame.created, chunk, offset + chunk.length === frame.bytes.length);
    }
  }
  clearTimeout(stop); clearInterval(producer); clearInterval(heartbeat);
  client.end(); await once(client, "close");
  await Promise.all(delays); server.close(); await once(server, "close");
  results.push({ ...scenario, measuredDurationMs: performance.now() - start, produced, dropped, delivered: frames.length, payloadBytes, wireBytes,
    frameAgeP50Ms: quantile(frames, .5), frameAgeP95Ms: quantile(frames, .95), eventDelayP50Ms: quantile(events, .5), eventDelayP95Ms: quantile(events, .95),
    pendingFrameCap: 1, inflightFrameCap: 1, snapshotBytes: bytes.length });
}
await writeFile(output, JSON.stringify({ note: "Measured loopback with application-level bandwidth/delay/stall injection; fixed real fixture snapshot; no capture/decode/photons; no actual packet loss", results }, null, 2) + "\n");
console.log(JSON.stringify(results.map(({ name, delivered, dropped, frameAgeP95Ms, eventDelayP95Ms }) => ({ name, delivered, dropped, frameAgeP95Ms, eventDelayP95Ms }))));
