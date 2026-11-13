// Model key proxy for a contained Outpost.
//
// The Outpost's Codex provider base URL is http://<egress>:<port>/<placeholder>/v1.
// This proxy runs outside the container. It accepts only that placeholder,
// strips it, adds the real API key and forwards to the one configured upstream.
// HTTP bodies and WebSocket frames are piped as raw bytes, never re-encoded.
//
// Config comes from the environment. Keep the real key out of any repository:
//   MODEL_PROXY_UPSTREAM      e.g. https://api.example.com/v1   (required)
//   MODEL_PROXY_API_KEY_FILE  a file holding the real provider key, such as a
//                             Compose secret under /run/secrets
//   MODEL_PROXY_API_KEY       the key itself, when there is no file
//   MODEL_PROXY_PLACEHOLDER   the token the Outpost uses        (required)
//   MODEL_PROXY_LISTEN        host:port, default 127.0.0.1:8787
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const HOP_HEADERS = new Set([
  "host", "authorization", "x-api-key", "connection", "proxy-authorization",
  "proxy-connection", "keep-alive", "te", "trailer",
]);

/**
 * Map an incoming request path onto the upstream, or return undefined to reject it.
 * "/<placeholder>/v1/responses?x=1" becomes "<upstream base>/responses?x=1".
 */
export function mapUpstreamPath(rawUrl, placeholder, upstreamBase) {
  const match = /^\/([^/?#]+)(\/v1)?(\/[^?#]*)?(\?.*)?$/.exec(rawUrl || "");
  if (!match) return undefined;
  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(placeholder);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const rest = match[3] || "";
  const segments = rest.split("/");
  if (segments.some((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === ".." || decoded === "." || decoded.includes("/") || decoded.includes("\\");
  })) {
    return undefined;
  }
  return `${upstreamBase}${rest}${match[4] || ""}`;
}

export function createModelKeyProxy({ upstream, apiKey, placeholder, log = defaultLog }) {
  const target = new URL(upstream);
  const upstreamBase = target.pathname.replace(/\/+$/, "");
  const secure = target.protocol === "https:";
  const upstreamPort = Number(target.port || (secure ? 443 : 80));
  const redact = (url) => (url || "").replace(/^\/[^/?#]+/, "/<token>");

  function forwardHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_HEADERS.has(name.toLowerCase())) out[name] = value;
    }
    out.host = target.host;
    out.authorization = `Bearer ${apiKey}`;
    return out;
  }

  const server = http.createServer((req, res) => {
    const path = mapUpstreamPath(req.url, placeholder, upstreamBase);
    if (!path) {
      log("rejected", { reason: "bad_placeholder_or_path", method: req.method, path: redact(req.url), from: req.socket.remoteAddress });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rejected by the model key proxy." } }));
      return;
    }
    const started = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    const outgoing = (secure ? https : http).request({
      host: target.hostname, port: upstreamPort, method: req.method, path, headers: forwardHeaders(req.headers),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.on("data", (chunk) => { bytesOut += chunk.length; });
      // A stream the upstream broke must reach the client broken, so it
      // retries, never hung or ended as if complete.
      upstreamRes.on("close", () => {
        if (upstreamRes.complete) return;
        log("upstream_error", { path, error: "response incomplete" });
        res.destroy();
      });
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => log("request", { method: req.method, path, status: upstreamRes.statusCode, bytesIn, bytesOut, ms: Date.now() - started }));
    });
    outgoing.on("error", (error) => {
      log("upstream_error", { path, error: error.code || error.message });
      // After the headers, an error body would land inside the stream.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream unreachable." } }));
    });
    req.on("data", (chunk) => { bytesIn += chunk.length; });
    req.pipe(outgoing);
    res.on("close", () => outgoing.destroy());
  });

  // WebSocket: replay the upgrade request upstream with the key swapped, then pipe frames untouched.
  server.on("upgrade", (req, socket, head) => {
    const path = mapUpstreamPath(req.url, placeholder, upstreamBase);
    if (!path) {
      log("rejected", { reason: "bad_placeholder_or_path", method: "UPGRADE", path: redact(req.url), from: req.socket.remoteAddress });
      // Drop what the client sent after the request, so its FIN arrives and
      // the socket closes. Unread, a rejected socket is held for good.
      socket.on("error", () => socket.destroy());
      socket.setTimeout(10_000, () => socket.destroy());
      socket.resume();
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const headers = forwardHeaders(req.headers);
    headers.connection = "Upgrade";
    const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries(headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`)), "", ""];
    const conn = secure
      ? tls.connect({ host: target.hostname, port: upstreamPort, servername: target.hostname })
      : net.connect({ host: target.hostname, port: upstreamPort });
    conn.once(secure ? "secureConnect" : "connect", () => {
      conn.write(lines.join("\r\n"));
      if (head?.length) conn.write(head);
      conn.pipe(socket);
      socket.pipe(conn);
      log("websocket_open", { path });
    });
    const close = () => { conn.destroy(); socket.destroy(); };
    conn.on("error", (error) => { log("upstream_error", { path, error: error.code || error.message }); close(); });
    socket.on("error", close);
    conn.on("close", close);
    socket.on("close", close);
  });

  return { server, upstreamBase, origin: target.origin };
}

function defaultLog(event, fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

function fail(message) {
  console.error(`model-key-proxy: ${message}`);
  process.exit(2);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

// The key is read once, at start. Its value never reaches a log line.
function apiKey() {
  const file = process.env.MODEL_PROXY_API_KEY_FILE?.trim();
  if (!file) return required("MODEL_PROXY_API_KEY");
  if (process.env.MODEL_PROXY_API_KEY?.trim()) fail("set MODEL_PROXY_API_KEY_FILE or MODEL_PROXY_API_KEY, not both");
  let key;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch (error) {
    fail(`cannot read MODEL_PROXY_API_KEY_FILE (${error.code || error.message})`);
  }
  if (!key) fail("MODEL_PROXY_API_KEY_FILE is empty");
  return key;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [listenHost, listenPort] = (process.env.MODEL_PROXY_LISTEN || "127.0.0.1:8787").split(":");
  const { server, upstreamBase, origin } = createModelKeyProxy({
    upstream: required("MODEL_PROXY_UPSTREAM"),
    apiKey: apiKey(),
    placeholder: required("MODEL_PROXY_PLACEHOLDER"),
  });
  server.listen(Number(listenPort), listenHost, () => {
    defaultLog("listening", { listen: `${listenHost}:${listenPort}`, upstream: `${origin}${upstreamBase}` });
  });
}
