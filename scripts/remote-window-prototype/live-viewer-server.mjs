import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { METHODS } from "./live-session.mjs";

export async function startViewer({ out, request, reconnect }) {
  await mkdir(out, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const html = await readFile(new URL("./live-viewer.html", import.meta.url));
  let metrics, active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (active >= 8) { res.writeHead(503).end(); return; }
    active++;
    try {
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'");
        res.end(html); return;
      }
      if (req.method !== "POST" || req.headers["x-pwrwin-token"] !== token
        || req.headers.origin !== `http://127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > (req.url === "/metrics" ? 4 * 1024 * 1024 : 8192)) { res.writeHead(413).end(); return; }
      }
      const params = JSON.parse(body);
      let result;
      if (req.url === "/metrics") { metrics = params; result = {}; }
      else if (req.url === "/reconnect" && reconnect) { await reconnect(); result = {}; }
      else {
        const method = req.url?.slice(1);
        if (!METHODS.includes(method)) { res.writeHead(404).end(); return; }
        result = await request(method, params);
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(error) })); }
    finally { active--; }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  const readyFile = `${out}/ready.json`;
  await writeFile(readyFile, JSON.stringify({ url, output: out, pid: process.pid }), { mode: 0o600 });
  return { get metrics() { return metrics; }, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  } };
}
