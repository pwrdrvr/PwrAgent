// Self-test for the suite-wide guard in `../../test-setup/outbound-fetch-guard.ts`.
//
// The guard is loaded as a setup file for both desktop projects, so it is
// already active here. These tests deliberately trip it and then drain its
// record before the guard's own `afterEach` reads it — otherwise the
// deliberate attempt would fail the test that made it on purpose.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const ATTEMPTS = Symbol.for("pwragent.outboundFetchGuard.attempts");

type Attempt = { method: string; url: string };

afterEach(() => {
  drainAttempts();
});

describe("outbound fetch guard", () => {
  it("blocks a string URL and names it", async () => {
    const error = await captureFetchError(() =>
      fetch("https://api.github.com/repos/pwrdrvr/grok-build/releases"),
    );

    expect(error.message).toContain(
      "GET https://api.github.com/repos/pwrdrvr/grok-build/releases",
    );
    expect(drainAttempts()).toEqual([
      {
        method: "GET",
        url: "https://api.github.com/repos/pwrdrvr/grok-build/releases",
      },
    ]);
  });

  it("names the URL and method behind a Request object", async () => {
    const error = await captureFetchError(() =>
      fetch(new Request("https://example.test/upload", { method: "POST" })),
    );

    expect(error.message).toContain("POST https://example.test/upload");
    expect(drainAttempts()).toEqual([
      { method: "POST", url: "https://example.test/upload" },
    ]);
  });

  // The recording, not the throw, is what fails a test: every caller this guard
  // protects wraps its request in a `try`/`catch` that degrades to a cached
  // value or a logged warning.
  it("records an attempt even when the caller swallows the throw", async () => {
    await swallow(() => fetch("https://example.test/swallowed"));

    expect(drainAttempts()).toEqual([
      { method: "GET", url: "https://example.test/swallowed" },
    ]);
  });

  // Loopback is not egress. `agent-tool-mcp-server.test.ts` depends on this to
  // drive its own MCP server's real HTTP surface, so the allowance is pinned
  // here rather than left to be rediscovered by a suite-wide failure.
  it("lets a request through to a server the test started on loopback", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("loopback");
    });
    const url = await listenOnLoopback(server);

    try {
      await expect((await fetch(url)).text()).resolves.toBe("loopback");
      expect(drainAttempts()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["http://127.0.0.1:9/x", "http://[::1]:9/x", "http://localhost:9/x"])(
    "treats %s as loopback rather than egress",
    async (url) => {
      // Nothing is listening on port 9, so the request fails at connect — the
      // point is that it reached the socket instead of the guard.
      await swallow(() => fetch(url));

      expect(drainAttempts()).toEqual([]);
    },
  );

  it("still blocks a remote host that merely mentions localhost", async () => {
    const error = await captureFetchError(() =>
      fetch("https://localhost.attacker.test/x"),
    );

    expect(error.message).toContain("https://localhost.attacker.test/x");
    expect(drainAttempts()).toHaveLength(1);
  });

  // The shape `auto-updater.test.ts` uses: a test that drives its own fake HTTP
  // layer replaces the global for its own duration and puts back what it found.
  it("lets a test install its own fetch and restore the guard afterwards", async () => {
    const guarded = globalThis.fetch;
    const stub = (async () => new Response("ok")) as typeof globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: stub,
      writable: true,
    });

    try {
      await expect((await fetch("https://example.test/stubbed")).text())
        .resolves.toBe("ok");
      expect(drainAttempts()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: guarded,
        writable: true,
      });
    }

    const error = await captureFetchError(() => fetch("https://example.test/after"));
    expect(error.message).toContain("https://example.test/after");
    expect(drainAttempts()).toHaveLength(1);
  });
});

/**
 * The guard throws from the call itself rather than returning a rejected
 * promise, so the throw arrives synchronously and `.rejects` would never see
 * it. Awaiting inside `try` catches both shapes.
 */
async function captureFetchError(request: () => Promise<unknown>): Promise<Error> {
  try {
    await request();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the guard to block this request");
}

async function swallow(request: () => Promise<unknown>): Promise<void> {
  try {
    await request();
  } catch {
    // Exactly what `ensureManagedGrokRuntime` does with a failed release check.
  }
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}/`;
}

/** Consumes the guard's record so its own `afterEach` sees a clean slate. */
function drainAttempts(): Attempt[] {
  const recorded = (globalThis as Record<symbol, unknown>)[ATTEMPTS] as
    | Attempt[]
    | undefined;
  return recorded?.splice(0) ?? [];
}
