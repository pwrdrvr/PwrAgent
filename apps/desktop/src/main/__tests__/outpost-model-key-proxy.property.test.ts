import { createHash } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The proxy is a plain script an operator runs on the host. Load it by URL so
// the test exercises the shipped file, not a typed copy of it.
type ProxyModule = {
  createModelKeyProxy(options: {
    upstream: string;
    apiKey: string;
    placeholder: string;
    log?: (event: string, fields: Record<string, unknown>) => void;
  }): { server: http.Server };
};

const PROXY_SCRIPT = path.resolve(
  __dirname,
  "../agent-tools/skills/outpost-security-research/scripts/model-key-proxy.mjs",
);
const PLACEHOLDER = "ph_0123456789abcdef";
const API_KEY = "real-key-never-sent-by-the-client";
const UPSTREAM_BASE = "/provider/v1";

type Seen = { url: string; authorization?: string; apiKeyHeader?: string };

let upstream: http.Server;
let proxy: http.Server;
let proxyPort = 0;
const seen: Seen[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      authorization: req.headers.authorization,
      apiKeyHeader: req.headers["x-api-key"] as string | undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const scriptUrl = pathToFileURL(PROXY_SCRIPT).href;
  const module = (await import(scriptUrl)) as ProxyModule;
  ({ server: proxy } = module.createModelKeyProxy({
    upstream: `http://127.0.0.1:${upstreamPort}${UPSTREAM_BASE}`,
    apiKey: API_KEY,
    placeholder: PLACEHOLDER,
    log: () => {},
  }));
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  await close(proxy);
  await close(upstream);
});

// http.request sends the path as given, so dot segments and encoded
// separators reach the proxy the way a hostile client would send them.
function send(rawPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: rawPath, headers, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const SEGMENTS = [
  "responses", "models", "v1", "a", "", ".", "..", "%2e", "%2E%2e", ".%2e", "%2f", "%2F",
  "%5c", "%", "%zz", "x%2f..", PLACEHOLDER, encodeURIComponent(PLACEHOLDER),
];
const TOKENS = [
  PLACEHOLDER, encodeURIComponent(PLACEHOLDER), `${PLACEHOLDER}x`, PLACEHOLDER.slice(1), "wrong",
  "%70h_0123456789abcdef", "%", "..",
];

function decodesTo(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

describe("model key proxy", () => {
  it("forwards only the placeholder's requests, only under the upstream base, always with the real key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TOKENS),
        fc.boolean(),
        fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 4 }),
        fc.constantFrom("", "?stream=true", "?a=..%2f"),
        fc.constantFrom<Record<string, string>>(
          {},
          { authorization: "Bearer client-supplied" },
          { "x-api-key": "client-supplied" },
        ),
        async (token, withV1, segments, query, clientHeaders) => {
          const rest = segments.map((segment) => `/${segment}`).join("");
          const rawPath = `/${token}${withV1 ? "/v1" : ""}${rest}${query}`;
          const before = seen.length;
          const status = await send(rawPath, clientHeaders);
          const forwarded = seen.slice(before);

          const tokenMatches = decodesTo(token) === PLACEHOLDER;
          if (!tokenMatches) {
            expect(status).toBe(403);
            expect(forwarded).toEqual([]);
            return;
          }
          if (forwarded.length === 0) {
            expect(status).toBe(403);
            // The proxy may refuse only paths that could escape the base.
            const plain = segments.every((segment) => {
              const decoded = decodesTo(segment);
              return decoded !== undefined
                && decoded !== "." && decoded !== ".."
                && !decoded.includes("/") && !decoded.includes("\\");
            });
            expect(plain).toBe(false);
            return;
          }
          expect(status).toBe(200);
          expect(forwarded).toHaveLength(1);
          const [request] = forwarded;
          // Resolve the path the way an upstream server would.
          const resolved = new URL(request.url, "http://upstream.invalid").pathname;
          expect(resolved === UPSTREAM_BASE || resolved.startsWith(`${UPSTREAM_BASE}/`)).toBe(true);
          // The token and a leading /v1 (the base's own) are replaced by the
          // base; the rest is passed through byte for byte.
          const afterToken = `${withV1 ? "/v1" : ""}${rest}`;
          const leadingV1 = afterToken === "/v1" || afterToken.startsWith("/v1/");
          expect(request.url).toBe(`${UPSTREAM_BASE}${leadingV1 ? afterToken.slice(3) : afterToken}${query}`);
          expect(request.authorization).toBe(`Bearer ${API_KEY}`);
          expect(request.apiKeyHeader).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });
});

// Codex streams Responses over SSE. A stream the upstream breaks must reach
// Codex as broken, so it retries; a hung or cleanly ended stream is a turn
// that never finishes or silently loses its tail.
describe("model key proxy streaming", () => {
  let streamUpstream: http.Server;
  let streamProxy: http.Server;
  let streamProxyPort = 0;

  beforeAll(async () => {
    streamUpstream = http.createServer((req, res) => {
      const params = new URL(req.url ?? "/", "http://upstream.invalid").searchParams;
      const chunks = Number(params.get("chunks"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      // The stream has started even before its first event. (A break before
      // the headers is a 502 from the proxy, a complete response.)
      res.flushHeaders();
      for (let index = 0; index < chunks; index += 1) res.write(`data: ${index}\n\n`);
      if (params.get("finish") === "1") res.end();
      else setTimeout(() => res.socket?.destroy(), 20);
    });
    const upstreamPort = await listen(streamUpstream);
    const module = (await import(pathToFileURL(PROXY_SCRIPT).href)) as ProxyModule;
    ({ server: streamProxy } = module.createModelKeyProxy({
      upstream: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: API_KEY,
      placeholder: PLACEHOLDER,
      log: () => {},
    }));
    streamProxyPort = await listen(streamProxy);
  });

  afterAll(async () => {
    streamProxy.closeAllConnections();
    await close(streamProxy);
    await close(streamUpstream);
  });

  function stream(chunks: number, finish: boolean): Promise<{ outcome: "end" | "broken" | "hung"; body: string }> {
    return new Promise((resolve) => {
      let body = "";
      let settled = false;
      const settle = (outcome: "end" | "broken" | "hung") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ outcome, body });
      };
      const timer = setTimeout(() => settle("hung"), 2_000);
      const req = http.get({
        host: "127.0.0.1",
        port: streamProxyPort,
        path: `/${PLACEHOLDER}/v1/responses?chunks=${chunks}&finish=${finish ? 1 : 0}`,
        agent: false,
      }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => settle(res.complete ? "end" : "broken"));
        res.on("aborted", () => settle("broken"));
        res.on("error", () => settle("broken"));
      });
      req.on("error", () => settle("broken"));
    });
  }

  it("ends a stream the upstream finished, and breaks one it broke", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 }), fc.boolean(), async (chunks, finish) => {
        const sent = Array.from({ length: chunks }, (_, index) => `data: ${index}\n\n`).join("");
        const { outcome, body } = await stream(chunks, finish);
        expect(outcome).toBe(finish ? "end" : "broken");
        // Nothing the upstream did not send is added to the stream.
        expect(sent.startsWith(body) || body === sent).toBe(true);
        if (finish) expect(body).toBe(sent);
      }),
      { numRuns: 16 },
    );
  });
});

// Codex can also reach Responses over a WebSocket. The upgrade must pass the
// same gate as a plain request, and the frames after it are the model's
// traffic: the proxy may not drop, add or rewrite a byte in either direction.
describe("model key proxy WebSocket upgrades", () => {
  type Upgrade = {
    url: string;
    authorization?: string;
    apiKeyHeader?: string;
    upgrade?: string;
    key?: string;
    host?: string;
  };
  const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
  let wsUpstream: http.Server;
  let wsProxy: http.Server;
  let wsProxyPort = 0;
  let wsUpstreamHost = "";
  let connections = 0;
  const upgrades: Upgrade[] = [];
  // What the upstream sends after its 101, and what reached it after the handshake.
  let serverBytes = Buffer.alloc(0);
  let upstreamReceived = Buffer.alloc(0);
  let upstreamWaiter: (() => void) | undefined;
  let upstreamClosed: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    wsUpstream = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    wsUpstream.on("connection", () => { connections += 1; });
    wsUpstream.on("upgrade", (req, socket, head: Buffer) => {
      upgrades.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        apiKeyHeader: req.headers["x-api-key"] as string | undefined,
        upgrade: req.headers.upgrade,
        key: req.headers["sec-websocket-key"] as string | undefined,
        host: req.headers.host,
      });
      upstreamReceived = Buffer.from(head);
      upstreamClosed = new Promise((resolve) => socket.on("close", () => resolve()));
      socket.on("error", () => {});
      // An http.Server socket is half-open; close when the proxy does, as a
      // WebSocket server would.
      socket.on("end", () => socket.end());
      socket.on("data", (chunk: Buffer) => {
        upstreamReceived = Buffer.concat([upstreamReceived, chunk]);
        upstreamWaiter?.();
      });
      const accept = createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n"
        + `sec-websocket-accept: ${accept}\r\n\r\n`,
      );
      socket.write(serverBytes);
    });
    const upstreamPort = await listen(wsUpstream);
    wsUpstreamHost = `127.0.0.1:${upstreamPort}`;
    const module = (await import(pathToFileURL(PROXY_SCRIPT).href)) as ProxyModule;
    ({ server: wsProxy } = module.createModelKeyProxy({
      upstream: `http://${wsUpstreamHost}${UPSTREAM_BASE}`,
      apiKey: API_KEY,
      placeholder: PLACEHOLDER,
      log: () => {},
    }));
    wsProxyPort = await listen(wsProxy);
  });

  afterAll(async () => {
    wsProxy.closeAllConnections();
    wsUpstream.closeAllConnections();
    await close(wsProxy);
    await close(wsUpstream);
  });

  function proxyConnections(): Promise<number> {
    return new Promise((resolve, reject) => {
      wsProxy.getConnections((error, count) => (error ? reject(error) : resolve(count)));
    });
  }

  // A socket the proxy leaves open after the client is gone is a descriptor
  // held for good: rejected upgrades from the container would exhaust them.
  // Measured against the run's own start, so one leak fails only its own run.
  async function untilProxyBackTo(baseline: number): Promise<void> {
    const deadline = Date.now() + 500;
    for (;;) {
      const open = await proxyConnections();
      if (open <= baseline) return;
      if (Date.now() > deadline) throw new Error(`the proxy still holds ${open - baseline} connection(s) from this run`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function untilUpstreamHas(length: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        upstreamWaiter = undefined;
        reject(new Error(`upstream received ${upstreamReceived.length} of ${length} bytes`));
      }, 3_000);
      const check = () => {
        if (upstreamReceived.length < length) return;
        clearTimeout(timer);
        upstreamWaiter = undefined;
        resolve();
      };
      upstreamWaiter = check;
      check();
    });
  }

  type Handshake = { status: number; body: () => Buffer; socket: net.Socket };

  // A raw socket, so the request target reaches the proxy byte for byte and
  // client frames can ride in the same packet as the handshake (the proxy's
  // `head`).
  function upgradeThroughProxy(
    rawPath: string,
    headers: Record<string, string>,
    clientBytes: Buffer,
    withHandshake: boolean,
    serverLength: number,
  ): Promise<Handshake> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(wsProxyPort, "127.0.0.1");
      let buffered = Buffer.alloc(0);
      let body: Buffer | undefined;
      let status = 0;
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        if (!settled) reject(new Error(`no outcome for ${rawPath}; status ${status}`));
      }, 3_000);
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, body: () => body ?? Buffer.alloc(0), socket });
      };
      socket.on("connect", () => {
        const head = [
          `GET ${rawPath} HTTP/1.1`, "host: proxy.invalid", "upgrade: websocket", "connection: Upgrade",
          `sec-websocket-key: ${WS_KEY}`, "sec-websocket-version: 13",
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", "",
        ].join("\r\n");
        socket.write(withHandshake ? Buffer.concat([Buffer.from(head, "latin1"), clientBytes]) : head);
      });
      socket.on("data", (chunk: Buffer) => {
        if (body) {
          body = Buffer.concat([body, chunk]);
        } else {
          buffered = Buffer.concat([buffered, chunk]);
          const end = buffered.indexOf("\r\n\r\n");
          if (end < 0) return;
          status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(buffered.toString("latin1"))?.[1] ?? 0);
          body = buffered.subarray(end + 4);
          if (status === 101 && !withHandshake) socket.write(clientBytes);
        }
        if (status === 101 && body.length >= serverLength) settle();
      });
      socket.on("close", settle);
      socket.on("error", settle);
    });
  }

  function wsFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array) {
    const maskBit = mask ? 0x80 : 0;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, maskBit | payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.from([0x80 | opcode, maskBit | 126, payload.length >> 8, payload.length & 0xff]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = maskBit | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    if (!mask) return Buffer.concat([header, payload]);
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return Buffer.concat([header, mask, masked]);
  }

  // Clients mask their frames; servers do not.
  const frames = (masked: boolean) => fc.array(
    fc.record({
      opcode: fc.constantFrom(0x1, 0x2, 0x9, 0xa),
      payload: fc.oneof(
        { arbitrary: fc.uint8Array({ maxLength: 300 }), weight: 9 },
        { arbitrary: fc.constant(new Uint8Array(70_000).fill(0x5a)), weight: 1 },
      ),
      mask: fc.uint8Array({ minLength: 4, maxLength: 4 }),
    }),
    { maxLength: 4 },
  ).map((list) => Buffer.concat(list.map((frame) => wsFrame(frame.opcode, frame.payload, masked ? frame.mask : undefined))));

  function plainSegment(segment: string): boolean {
    const decoded = decodesTo(segment);
    return decoded !== undefined
      && decoded !== "." && decoded !== ".."
      && !decoded.includes("/") && !decoded.includes("\\");
  }

  it("upgrades only the placeholder's paths under the upstream base, with the real key, and passes frames unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TOKENS),
        fc.boolean(),
        fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 3 }),
        fc.constantFrom("", "?model=x"),
        fc.constantFrom<Record<string, string>>(
          {},
          { authorization: "Bearer client-supplied" },
          { "x-api-key": "client-supplied" },
        ),
        frames(true),
        frames(false),
        fc.boolean(),
        async (token, withV1, segments, query, clientHeaders, clientBytes, toClient, withHandshake) => {
          const rest = segments.map((segment) => `/${segment}`).join("");
          const rawPath = `/${token}${withV1 ? "/v1" : ""}${rest}${query}`;
          const accepted = decodesTo(token) === PLACEHOLDER && segments.every(plainSegment);
          serverBytes = toClient;
          const connectionsBefore = connections;
          const upgradesBefore = upgrades.length;
          const openBefore = await proxyConnections();

          const handshake = await upgradeThroughProxy(
            rawPath, clientHeaders, clientBytes, withHandshake, accepted ? toClient.length : 0,
          );
          try {
            if (!accepted) {
              expect(handshake.status).toBe(403);
              expect(connections).toBe(connectionsBefore);
              expect(upgrades).toHaveLength(upgradesBefore);
              await untilProxyBackTo(openBefore);
              return;
            }
            expect(handshake.status).toBe(101);
            await untilUpstreamHas(clientBytes.length);
            expect(upstreamReceived.equals(clientBytes)).toBe(true);
            expect(handshake.body().equals(toClient)).toBe(true);
            expect(upgrades).toHaveLength(upgradesBefore + 1);
            const seenUpgrade = upgrades[upgrades.length - 1];
            const afterToken = `${withV1 ? "/v1" : ""}${rest}`;
            const leadingV1 = afterToken === "/v1" || afterToken.startsWith("/v1/");
            expect(seenUpgrade.url).toBe(`${UPSTREAM_BASE}${leadingV1 ? afterToken.slice(3) : afterToken}${query}`);
            expect(seenUpgrade.authorization).toBe(`Bearer ${API_KEY}`);
            expect(seenUpgrade.apiKeyHeader).toBeUndefined();
            expect(seenUpgrade.upgrade).toBe("websocket");
            expect(seenUpgrade.key).toBe(WS_KEY);
            expect(seenUpgrade.host).toBe(wsUpstreamHost);
            handshake.socket.destroy();
            await upstreamClosed;
            await untilProxyBackTo(openBefore);
          } finally {
            // A failed run must not leave sockets that fail the next one.
            handshake.socket.destroy();
            if (upgrades.length > upgradesBefore) await upstreamClosed;
          }
        },
      ),
      {
        numRuns: 200,
        examples: [
          [PLACEHOLDER, true, ["responses"], "", {}, wsFrame(1, Buffer.from("hi"), Buffer.from([1, 2, 3, 4])), wsFrame(1, Buffer.from("ok")), false],
          ["wrong", true, ["responses"], "", {}, Buffer.alloc(0), Buffer.alloc(0), false],
          [PLACEHOLDER, true, ["..", "..", "admin"], "", {}, Buffer.alloc(0), Buffer.alloc(0), true],
          [PLACEHOLDER, true, ["%2e%2e"], "", {}, Buffer.alloc(0), Buffer.alloc(0), false],
        ],
      },
    );
  }, 60_000);
});
