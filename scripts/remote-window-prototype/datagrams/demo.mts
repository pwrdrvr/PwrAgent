import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createFabric } from "./fabric.mts";
import type { WebSocket, RawData } from "../../../apps/desktop/node_modules/@types/ws/index.d.ts";
const require = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.env.PWRWIN_OUTPUT ?? `${root}/.local/remote-window/datagrams/run`);
await mkdir(out, { recursive: true });
const tokens = { source: randomBytes(32).toString("hex"), viewer: randomBytes(32).toString("hex") };
const sockets = new Map();
const signals = new Map();
const sourceQueue = new Map();
const nativeMetrics = { manifests: 0, previews: 0, tiles: 0, previewEncodeMs: [] as number[], tileEncodeMs: [] as number[],
  resources: undefined as unknown, errors: [] as string[], stderr: [] as string[] };
const began = performance.now(), cpu = process.cpuUsage();
let native: ReturnType<typeof spawn> | undefined, nativeReady = false, stopped = false, savedMetrics: unknown;
let lastFixtureCommand = 0;
const fabric = await createFabric(params => new Promise((resolve, reject) => {
  const source = sockets.get("source");
  if (!source || !nativeReady || signals.size >= 1 || !params || typeof params !== "object"
    || (params as { type?: string }).type !== "offer" || typeof (params as { sdp?: string }).sdp !== "string"
    || JSON.stringify(params).length > 24000) { reject(new Error("fixture_not_ready_or_invalid_offer")); return; }
  const id = randomUUID(), timer = setTimeout(() => { signals.delete(id); reject(new Error("signal_timeout")); }, 4500);
  signals.set(id, { resolve, reject, timer }); source.send(JSON.stringify({ kind: "offer", id, params }));
}));
const assets = new Map([['/', 'viewer.html'], ['/source', 'source.html'], ['/protocol.mjs', 'protocol.mjs'], ['/browser.mjs', 'browser.mjs']]);
const server = createServer(async (req, res) => {
  const file = assets.get(req.url ?? "");
  if (req.method !== "GET" || !file) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", file.endsWith(".mjs") ? "text/javascript" : "text/html");
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'");
  try { res.end(await readFile(new URL(file, import.meta.url))); } catch { res.writeHead(500).end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const role = req.url === "/socket/source" ? "source" : req.url === "/socket/viewer" ? "viewer" : undefined;
  if (!role || req.headers.origin !== origin) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => ws.close(), 2000);
    ws.on("message", async (raw: RawData) => {
      try {
        const value = JSON.parse(String(raw));
        if (!authenticated) {
          if (value.token !== tokens[role] || sockets.has(role)) { ws.close(); return; }
          authenticated = true; clearTimeout(authTimer); sockets.set(role, ws);
          ws.send(JSON.stringify({ kind: "authenticated", role }));
          if (role === "source") startNative();
          return;
        }
        if (role === "source" && value.kind === "answer") {
          const entry = signals.get(value.id);
          if (!entry || JSON.stringify(value.result).length > 24000) throw new Error("invalid_answer");
          signals.delete(value.id); clearTimeout(entry.timer); entry.resolve(value.result);
        } else if (role === "viewer" && value.kind === "offer") {
          const result = await fabric.signal(value.params); ws.send(JSON.stringify({ kind: "answer", id: value.id, result }));
        } else if (role === "viewer" && value.kind === "fixture") {
          // Explicit local synthetic-fixture test controls; no OS-wide input.
          if (Date.now() - lastFixtureCommand < 20 || !nativeReady) throw new Error("fixture_rate_or_readiness");
          const c = value.command;
          const valid = c && (c.action === "motion" && typeof c.enabled === "boolean"
            || c.action === "text" && typeof c.text === "string" && c.text.length > 0 && c.text.length <= 64
              && Buffer.byteLength(c.text, "utf8") <= 128 && !/[\x00-\x1f\x7f]/.test(c.text)
            || c.action === "scroll" && Number.isSafeInteger(c.lines) && Math.abs(c.lines) <= 20);
          if (!valid) throw new Error("fixture_command_denied");
          lastFixtureCommand = Date.now();
          const command = c.action === "text" ? { action: "text", text: c.text } : c.action === "scroll" ? { action: "scroll", lines: c.lines } : { action: "motion", enabled: c.enabled };
          native?.stdin?.write(JSON.stringify({ ...command, kind: "input" }) + "\n");
        } else if (value.kind === "metrics") {
          if (role === "viewer") savedMetrics = value.metrics;
          await writeFile(`${out}/${role}-metrics.json`, JSON.stringify(value.metrics));
        } else throw new Error("method_denied");
      } catch (error) { if (ws.readyState === 1) ws.send(JSON.stringify({ kind: "error", message: String(error).slice(0, 180) })); }
    });
    ws.on("close", () => {
      clearTimeout(authTimer); if (sockets.get(role) === ws) sockets.delete(role);
      if (role === "source") { sourceQueue.clear(); void stop(); }
    });
    ws.on("error", () => ws.close());
  });
});
function startNative() {
  if (native) return;
  native = spawn(resolve(root, ".local/remote-window/datagrams/tile-fixture"), [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: native.stdout! });
  lines.on("line", line => {
    try {
      if (line.length > 200000) throw new Error("native_message_limit");
      const value = JSON.parse(line);
      if (value.kind === "manifest") {
        nativeMetrics.manifests++;
        sourceQueue.set("manifest", value);
        for (const [id, item] of sourceQueue) if (typeof id === "number" && (id === 65535 || item.version < value.versions[id])) sourceQueue.delete(id);
      } else if (value.kind === "image") {
        if (value.imageKind === 1) nativeMetrics.previews++; else nativeMetrics.tiles++;
        const timings = value.imageKind === 1 ? nativeMetrics.previewEncodeMs : nativeMetrics.tileEncodeMs;
        if (timings.length < 10000) timings.push(value.encodeMs);
        sourceQueue.set(value.id, value);
      } else if (value.kind === "ready") { nativeReady = true; sockets.get("source")?.send(JSON.stringify(value)); }
      else if (value.kind === "error") { nativeMetrics.errors.push(value.message); sockets.get("source")?.send(JSON.stringify(value)); void stop(); }
      else if (value.kind === "input") sockets.get("viewer")?.send(JSON.stringify(value));
      else if (value.kind === "resources") nativeMetrics.resources = value;
    } catch (error) { nativeMetrics.errors.push(String(error)); void stop(); }
  });
  native.stderr!.on("data", data => { if (nativeMetrics.stderr.length < 10) nativeMetrics.stderr.push(String(data).slice(0, 300)); });
  native.once("error", error => { nativeMetrics.errors.push(String(error)); void stop(); });
  native.once("exit", () => { void stop(); });
}
const drain = setInterval(() => {
  const ws = sockets.get("source"); if (!ws || ws.readyState !== 1) return;
  for (let n = 0; n < 8 && ws.bufferedAmount < 65536 && sourceQueue.size; n++) {
    const key = sourceQueue.has("manifest") ? "manifest" : sourceQueue.has(65535) ? 65535 : sourceQueue.keys().next().value;
    const value = sourceQueue.get(key); sourceQueue.delete(key); ws.send(JSON.stringify(value));
  }
}, 4);
// A failed automation client must not leave even this synthetic capture running indefinitely.
const lifetime = setTimeout(() => { void stop(); }, 10 * 60 * 1000);
async function stop() {
  if (stopped) return; stopped = true; clearInterval(drain); clearTimeout(lifetime);
  for (const s of signals.values()) { clearTimeout(s.timer); s.reject(new Error("closed")); } signals.clear();
  if (native?.pid && native.exitCode === null && native.signalCode === null) {
    native.stdin?.end('{"kind":"stop"}\n');
    await new Promise<void>(resolve => { const timer = setTimeout(() => native?.kill("SIGTERM"), 2000); native!.once("exit", () => { clearTimeout(timer); resolve(); }); });
  }
  await writeFile(`${out}/result.json`, JSON.stringify({ measuredAt: new Date().toISOString(), crossMachine: false,
    native: nativeMetrics, signalingWire: fabric.wire, browser: savedMetrics,
    helper: { wallMs: performance.now() - began, cpuMicroseconds: process.cpuUsage(cpu), maxRssKiB: process.resourceUsage().maxRSS } }));
  for (const ws of sockets.values()) ws.close(); wss.close(); server.closeAllConnections(); server.close(); await fabric.close();
}
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
await writeFile(`${out}/ready.json`, JSON.stringify({ source: `${origin}/source#${tokens.source}`, viewer: `${origin}/#${tokens.viewer}`, pid: process.pid }), { mode: 0o600 });
console.log(`Datagram fixture URLs are in ${out}/ready.json. Capture starts only when the local source page authenticates.`);
