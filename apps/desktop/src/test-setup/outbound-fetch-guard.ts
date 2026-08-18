// Fails any test that makes a real outbound HTTP request.
//
// The suites reach several live network paths with no test-mode gate of their
// own: `ensureManagedGrokRuntime` asks the GitHub releases API what to install
// and then downloads a ~353 MB Grok runtime, `acp-registry-service` and
// `pwrsnap-connection-service` call their own endpoints, and `auto-updater`
// polls GitHub for releases. Only `managedGrok.enabled` gates the first, and
// two live callers pass it: `resolveManagedGrokCommand` in ACP discovery and
// the `refreshLocal` branch of the settings IPC.
//
// The spawn guard already catches the *probe* that follows an install, so the
// end state before this guard was a full download into the developer's home
// directory and then a spawn-guard failure. Failing at the request keeps the
// bytes off the disk in the first place, and keeps a run reproducible on a
// machine with no network at all.
//
// The hook is `globalThis.fetch` rather than an injected `fetch` option on each
// caller, for the same reason the spawn guard hooks a prototype: it is the one
// chokepoint every request funnels through, so it covers modules that were
// never given a seam and any network path added later. Injection is how you
// *fix* a failure here — `fetchLatestCompatibleRelease` already honors
// `options.fetch`, and `grok-managed-runtime.test.ts` passes one — but it
// cannot be what enforces the rule, because a module with no seam is exactly
// the case that needs catching.
//
// It records **and** throws. The throw alone is not enough: every one of these
// callers runs inside a `try`/`catch` that degrades to a cached value or a
// logged warning, so a bare throw would be swallowed and the test would pass
// green having attempted the request anyway. The recorded attempt is what fails
// the test below.
//
// Loopback is allowed through, because it is not egress: a request to
// `localhost` / `127.0.0.0/8` / `::1` reaches a server the test itself started.
// So is a scheme that never opens a socket at all (`data:`, `blob:`, `file:`).
// See `staysOnThisMachine` below.
//
// Not covered: `http.request` / `https.request` / `net.connect` and Electron's
// `net` module. Node's `fetch` is undici and does not route through them, and
// nothing in these suites uses them directly, so the narrower hook is the one
// that earns its keep.
//
// Fix a failure by keeping the request out of the test, never by calling
// through to the real `fetch`:
//   - Managed Grok runtime: pass `options.fetch`, as
//     `grok-managed-runtime.test.ts` does — or, for a test that only wants
//     discovery, leave `managedGrok.enabled` off or inject
//     `resolveManagedGrokCommand`.
//   - Anything else: inject the module's own fetch seam, or `vi.mock` it.
// A test that legitimately drives a fake HTTP layer replaces `globalThis.fetch`
// for its own duration, as `auto-updater.test.ts` does; this file reinstalls
// the guard for the next test file either way.
import { afterAll, afterEach } from "vitest";

type Attempt = { method: string; url: string };

const INSTALLED = Symbol.for("pwragent.outboundFetchGuard.installed");
const ATTEMPTS = Symbol.for("pwragent.outboundFetchGuard.attempts");
const NATIVE = Symbol.for("pwragent.outboundFetchGuard.native");

type GuardGlobal = typeof globalThis & {
  [INSTALLED]?: typeof globalThis.fetch;
  [ATTEMPTS]?: Attempt[];
  [NATIVE]?: typeof globalThis.fetch;
};

const guardGlobal = globalThis as GuardGlobal;
const attempts: Attempt[] = (guardGlobal[ATTEMPTS] ??= []);
// Captured on the first install only. A reinstall sees whatever the previous
// test file left behind, which may be that file's mock — passing loopback
// traffic to a stale mock would be worse than blocking it.
const nativeFetch: typeof globalThis.fetch = (guardGlobal[NATIVE] ??=
  guardGlobal.fetch);

// Setup files re-run for every test file in a worker. Unlike the spawn guard's
// prototype patch, `globalThis.fetch` is a plain writable property that tests
// routinely replace, so re-asserting the guard here is what makes it the
// baseline each file starts from rather than a one-shot install a single
// unrestored mock could retire for the rest of the worker. The identity check
// keeps a re-run from wrapping the guard in itself.
if (guardGlobal[INSTALLED] !== guardGlobal.fetch) {
  const guardedFetch = function guardedFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const attempt = describeRequest(input, init);
    if (staysOnThisMachine(attempt.url)) {
      return nativeFetch(input, init);
    }
    attempts.push(attempt);
    throw new Error(describeAttempt(attempt));
  } as typeof globalThis.fetch;
  Object.defineProperty(guardGlobal, "fetch", {
    configurable: true,
    value: guardedFetch,
    writable: true,
  });
  guardGlobal[INSTALLED] = guardedFetch;
}

afterEach(() => {
  reportRecordedAttempts("This test");
});

// `afterEach` cannot see a request issued from `afterAll`, nor one from an
// async path that settles after the final test — and a swallowed throw leaves
// nothing else to notice it.
afterAll(() => {
  reportRecordedAttempts("This test file, after its last test,");
});

function reportRecordedAttempts(subject: string): void {
  const observed = attempts.splice(0);
  if (observed.length > 0) {
    throw new Error(
      [
        `${subject} attempted ${observed.length} real outbound HTTP request(s):`,
        ...observed.map((attempt) => `  ${describeAttempt(attempt)}`),
        "Serve the request from the test instead — see the remedies in",
        "apps/desktop/src/test-setup/outbound-fetch-guard.ts.",
      ].join("\n"),
    );
  }
}

/**
 * `fetch` takes a string, a `URL`, or a `Request`, and a `Request` carries its
 * own method. Read both shapes so the failure names the URL that was actually
 * attempted rather than `[object Request]`.
 */
function describeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Attempt {
  if (typeof input === "object" && input !== null && "url" in input) {
    const request = input as Request;
    return { method: init?.method ?? request.method, url: request.url };
  }
  return { method: init?.method ?? "GET", url: String(input) };
}

function describeAttempt(attempt: Attempt): string {
  return `${attempt.method.toUpperCase()} ${attempt.url}`;
}

/**
 * A request that cannot leave the machine is not the thing this guard exists to
 * stop. Two shapes qualify:
 *
 *   - Loopback — a test talking to a server the test itself started, the same
 *     category as the spawn guard's `os.tmpdir()` allowance.
 *     `agent-tool-mcp-server.test.ts` drives its MCP server's real HTTP surface
 *     (auth, CORS, thread binding) this way, and there is no version of that
 *     test worth having that does not.
 *   - A scheme that opens no socket at all — `data:`, `blob:`, `file:`. Those
 *     have no host to classify, and reading an inline fixture is not egress.
 *
 * An unparseable URL is treated as escaping: nothing here can prove where it
 * would go.
 */
function staysOnThisMachine(url: string): boolean {
  const parsed = parseRequestUrl(url);
  if (parsed === null) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }
  return isLoopbackHost(parsed.hostname.toLowerCase());
}

/**
 * jsdom gives the renderer a document origin, so a relative URL there is a
 * same-origin request against `localhost` rather than an unparseable one — the
 * guard measures egress, not same-origin. Node has no `location`, and undici
 * rejects a relative URL outright, so the same input there stays in the
 * "cannot prove where it goes" case alongside a malformed URL.
 */
function parseRequestUrl(url: string): URL | null {
  try {
    return new URL(url, globalThis.location?.href);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  // Node reports IPv6 hosts in their bracketed form.
  const address = host.replace(/^\[|\]$/g, "");
  return (
    address === "localhost"
    || address.endsWith(".localhost")
    // The wildcard bind addresses: a client that connects to one reaches a
    // local listener, so a test addressing its own `0.0.0.0`/`::` server is
    // still talking to itself.
    || address === "0.0.0.0"
    || address === "::"
    || address === "::1"
    // A dual-stack socket reports IPv4 loopback as `::ffff:127.0.0.1`, which
    // the URL parser normalizes to its hex form — `::ffff:7f00:1` for
    // `127.0.0.1`. The first group is `7f` plus the second octet, so the whole
    // of `127.0.0.0/8` is `7f00`–`7fff`.
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(address)
    || /^127(\.\d{1,3}){3}$/.test(address)
  );
}
