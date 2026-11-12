import http from "node:http";
import type { AddressInfo } from "node:net";
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
