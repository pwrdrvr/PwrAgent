import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isFederationInstanceId } from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";

const PREFIX = "window.prototype.v1.";
const METHODS = new Set(["open", "pull", "ack", "input", "close", "ping"]);
const MAX_BODY = 64 * 1024;
const MAX_PENDING = 8;

type Request = { id: string; method: string; params: unknown; peer: string };
type Pending = { request: Request; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Config = { peerId: string; role: "source" | "viewer" };

/**
 * Explicit, development-only seam for the owned-window experiment. No capture,
 * OS input, enrollment, production key access, arbitrary RPC, or service tunnel.
 * A locally launched helper supplies the fixture and its separate control grant.
 * The running Federation runtime retains responsibility for peer authentication.
 */
export async function startWindowPrototypeBridge(options: {
  packaged: boolean;
  configPath?: string;
  router: FederationRouter;
  localInstanceId: string;
  peerConnected: (peerId: string) => boolean;
  requestPeer: (peerId: string, method: string, params: unknown) => Promise<unknown>;
  log: { info: (message: string) => void; error: (message: string) => void };
}): Promise<{ dispose: () => Promise<void> } | undefined> {
  if (!options.configPath) return;
  if (options.packaged) {
    options.log.error("Ignoring development-only PWRAGENT_DEV_WINDOW_PROTOTYPE in packaged app.");
    return;
  }
  if (!path.isAbsolute(options.configPath)) throw new Error("Window prototype config must be an absolute path.");
  const configBytes = await readFile(options.configPath);
  if (configBytes.length > 4096) throw new Error("Window prototype config exceeds limit.");
  const config = JSON.parse(configBytes.toString()) as Config;
  if (!isFederationInstanceId(config.peerId) || config.peerId === options.localInstanceId
    || !["source", "viewer"].includes(config.role)) throw new Error("Invalid window prototype peer or role.");
  const token = randomBytes(32).toString("hex");
  const pending = new Map<string, Pending>();
  let queue: Request[] = [];
  let poll: (() => void) | undefined;
  let lastPoll = -Infinity;
  let disposed = false;
  let activeRequests = 0;
  const server = createServer(async (req, res) => {
    if (disposed || activeRequests >= MAX_PENDING) { res.writeHead(503).end(); return; }
    const supplied = req.headers["x-pwrwin-runtime-token"];
    if (req.method !== "POST" || req.headers.origin !== undefined
      || typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { res.writeHead(403).end(); return; }
    activeRequests++;
    try {
      const body = await readBody(req);
      let result: unknown;
      if (req.url === "/receive" && config.role === "source") {
        if (poll) throw new Error("Only one fixture helper may poll.");
        lastPoll = performance.now();
        if (!queue.length) await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); poll = undefined; resolve(); };
          const timer = setTimeout(finish, 500); poll = finish;
        });
        result = { requests: queue, connected: options.peerConnected(config.peerId), localInstanceId: options.localInstanceId, peerId: config.peerId };
        queue = [];
      } else if (req.url === "/reply" && config.role === "source") {
        if (typeof body.id !== "string") throw new Error("Invalid reply.");
        const entry = pending.get(body.id);
        if (!entry) throw new Error("Expired reply.");
        pending.delete(body.id); clearTimeout(entry.timer);
        if (typeof body.error === "string") entry.reject(new Error(body.error.slice(0, 200)));
        else entry.resolve(body.result);
        result = { accepted: true };
      } else if (req.url === "/rpc" && config.role === "viewer") {
        if (typeof body.method !== "string" || !METHODS.has(body.method)) throw new Error("Method denied.");
        if (!options.peerConnected(config.peerId)) throw new Error("Peer disconnected.");
        result = await options.requestPeer(config.peerId, PREFIX + body.method, body.params);
      } else { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Prototype request failed" }));
    } finally { activeRequests--; }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Prototype listener unavailable.");
  const readyFile = path.join(path.dirname(options.configPath), `pwrwin-runtime-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  try {
    await writeFile(readyFile, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token,
      role: config.role, localInstanceId: options.localInstanceId, peerId: config.peerId }), { mode: 0o600, flag: "wx" });
  } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  if (config.role === "source") for (const method of METHODS) {
    options.router.registerHandler(PREFIX + method, (envelope, transportPeer) => {
      // Router verified direct/trusted-relay origin before invoking this handler.
      if (disposed || !transportPeer || envelope.sourceInstanceId !== config.peerId
        || !options.peerConnected(config.peerId) || performance.now() - lastPoll > 1500) throw new Error("Fixture sharing is unavailable.");
      if (pending.size >= MAX_PENDING) throw new Error("Prototype request budget exceeded.");
      if (JSON.stringify(envelope.params).length > MAX_BODY) throw new Error("Prototype request too large.");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const request = { id, method, params: envelope.params, peer: envelope.sourceInstanceId };
        const timer = setTimeout(() => {
          pending.delete(id); queue = queue.filter(item => item.id !== id);
          reject(new Error("Fixture helper timed out."));
        }, 2000);
        pending.set(id, { request, resolve, reject, timer }); queue.push(request); poll?.();
      });
    });
  }
  options.log.info(`Window fixture ${config.role} adapter ready: ${readyFile}`);
  return { async dispose() {
    if (disposed) return;
    disposed = true; queue = []; poll?.();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Prototype stopped.")); }
    pending.clear();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(readyFile).catch(() => undefined);
  } };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error("Prototype body exceeds limit.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required.");
  return value as Record<string, unknown>;
}
