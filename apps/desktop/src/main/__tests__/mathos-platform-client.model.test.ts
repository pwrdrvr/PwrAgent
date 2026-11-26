import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  MATHOS_RUNTIME_SUBPROTOCOL,
  connectMathosRuntime,
  listMathosSwarms,
  listMathosTeams,
  openMathosPlatformConnection,
  type MathosPlatformDeps,
  type MathosSocket,
} from "../research/mathos-platform-connection";

const ORIGIN = "https://os.model.test";
const TEAM = "o-12345678-1234-4123-8123-123456789abc";
const ENV = "avm-87654321-4321-4321-8321-cba987654321";
const KEY = "nuc_ak_modelsecretkey000000000000000000000000000";

type SocketFault =
  | "none"
  | "immediate_close_after_open"
  | "send_throws_on_auth"
  | "wrong_protocol"
  | "text_frame"
  | "oversized_line"
  | "invalid_utf8_then_valid"
  | "close_on_first_op"
  | "coalesce_two_replies";

class ModelSocket implements MathosSocket {
  binaryType = "blob";
  protocol = "";
  closedWith?: number;
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  private inbound = "";
  readonly sentLines: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly onLine: (line: string, socket: ModelSocket) => void,
    private readonly options: {
      agreed?: string;
      split: (bytes: Uint8Array) => Uint8Array[];
      immediateCloseAfterOpen?: boolean;
      sendThrowsOnAuth?: boolean;
    },
  ) {
    queueMicrotask(() => {
      this.protocol = options.agreed ?? protocols[0] ?? "";
      this.emit("open", {});
      if (options.immediateCloseAfterOpen) {
        // Simulates runtime rejecting auth immediately in the same turn / next microtask before post-await listeners!
        this.closedWith = 1008;
        this.emit("close", { code: 1008 });
      }
    });
  }

  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: { data?: unknown; code?: number }) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  send(data: Uint8Array) {
    if (this.closedWith !== undefined) return;
    if (this.options.sendThrowsOnAuth && this.sentLines.length === 0) {
      throw new Error("Socket is already closing");
    }
    this.inbound += new TextDecoder().decode(data);
    let nl = this.inbound.indexOf("\n");
    while (nl !== -1) {
      const line = this.inbound.slice(0, nl);
      this.inbound = this.inbound.slice(nl + 1);
      this.sentLines.push(line);
      this.onLine(line, this);
      nl = this.inbound.indexOf("\n");
    }
  }

  sendRawBytes(bytes: Uint8Array) {
    for (const piece of this.options.split(bytes)) {
      const buf = piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength);
      queueMicrotask(() => this.emit("message", { data: buf }));
    }
  }

  reply(value: unknown) {
    this.sendRawBytes(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  }

  close(code = 1000) {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    queueMicrotask(() => this.emit("close", { code }));
  }
}

const byteSplitArb = fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 10 }).map((cuts) => (bytes: Uint8Array) => {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  for (const size of cuts) {
    if (offset >= bytes.length) break;
    pieces.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) pieces.push(bytes.slice(offset));
  return pieces;
});

type ClientStep =
  | { kind: "hello" }
  | { kind: "records"; after: number; limit: number }
  | { kind: "concurrent_burst"; count: number }
  | { kind: "server_close"; code: number }
  | { kind: "unsupported"; method: "execute" | "cancel" }
  | { kind: "close" };

describe("MathOS Platform client model", () => {
  it("models frame splitting, reconnects, preparing/asleep VMs, refusals and concurrent requests", async () => {
    const scenarioArb = fc.record({
      split: byteSplitArb,
      preparingPolls: fc.integer({ min: 0, max: 18 }),
      openMode: fc.constantFrom<"ready" | "asleep" | "401" | "403" | "500" | "bad_version" | "bad_ticket" | "unreachable" | "fail_then_ready">("ready", "ready", "ready", "asleep", "401", "403", "500", "bad_version", "bad_ticket", "unreachable", "fail_then_ready"),
      socketFault: fc.constantFrom<SocketFault>("none", "none", "none", "immediate_close_after_open", "send_throws_on_auth", "wrong_protocol", "text_frame", "oversized_line", "invalid_utf8_then_valid", "close_on_first_op", "coalesce_two_replies"),
      steps: fc.array(
        fc.oneof(
          { weight: 3, arbitrary: fc.constant<ClientStep>({ kind: "hello" }) },
          { weight: 4, arbitrary: fc.record({ kind: fc.constant("records" as const), after: fc.integer({ min: 0, max: 5 }), limit: fc.integer({ min: 1, max: 60 }) }) },
          { weight: 2, arbitrary: fc.record({ kind: fc.constant("concurrent_burst" as const), count: fc.integer({ min: 2, max: 18 }) }) },
          { weight: 2, arbitrary: fc.record({ kind: fc.constant("server_close" as const), code: fc.constantFrom(1000, 1006, 1008) }) },
          { weight: 1, arbitrary: fc.record({ kind: fc.constant("unsupported" as const), method: fc.constantFrom("execute" as const, "cancel" as const) }) },
          { weight: 1, arbitrary: fc.constant<ClientStep>({ kind: "close" }) },
        ),
        { minLength: 2, maxLength: 10 },
      ),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ split, preparingPolls, openMode, socketFault, steps }) => {
        let now = 0;
        let opens = 0;
        let prepRemaining = preparingPolls;
        let failedOnce = false;
        let faultUsed = false;
        const sockets: ModelSocket[] = [];
        const openBodies: Array<Record<string, unknown>> = [];
        const tickets: string[] = [];
        const opsPerOpen: number[] = [];
        let opensThisCall = 0;

        const fetch: MathosPlatformDeps["fetch"] = async (input, init) => {
          expect(init.redirect).toBe("error");
          if (openMode === "unreachable") throw new TypeError("fetch failed");
          if (input === `${ORIGIN}/app/`) {
            if (opensThisCall > 0) { opsPerOpen.push(opensThisCall); opensThisCall = 0; }
            return new Response(`<script src="/app/assets/index-Mod1.js"></script>`, { status: 200 });
          }
          if (input === `${ORIGIN}/app/assets/index-Mod1.js`) {
            return new Response("const x={runtime:\"0.62.0\",ipc:6};", { status: 200 });
          }
          if (input === `${ORIGIN}/v1/open`) {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            openBodies.push(body);
            // Invariant: NEVER wake an asleep VM!
            expect(body.wake).toBe(false);
            expect(body.ticket).toBe(true);
            opens++;
            opensThisCall++;
            if (openMode === "fail_then_ready" && !failedOnce) {
              failedOnce = true;
              return new Response(JSON.stringify({ error: "transient outage" }), { status: 503 });
            }
            if (openMode === "asleep") return new Response(JSON.stringify({ state: "asleep" }), { status: 200 });
            if (openMode === "401") return new Response(JSON.stringify({ error: "bad key" }), { status: 401 });
            if (openMode === "403") return new Response(JSON.stringify({ error: "no access" }), { status: 403 });
            if (openMode === "500") return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
            if (prepRemaining > 0) {
              prepRemaining--;
              return new Response(JSON.stringify({ state: "preparing" }), { status: 202 });
            }
            const ticket = `tkt-${opens}-secret`;
            tickets.push(ticket);
            if (openMode === "bad_version") {
              return new Response(JSON.stringify({ state: "ready", environment: ENV, version: "0.99.0", ipc_version: 6, ticket }), { status: 200 });
            }
            if (openMode === "bad_ticket") {
              return new Response(JSON.stringify({ state: "ready", environment: ENV, version: "0.62.0", ipc_version: 6, ticket: "bad ticket" }), { status: 200 });
            }
            return new Response(JSON.stringify({ state: "ready", environment: ENV, version: "0.62.0", ipc_version: 6, ticket }), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        };

        const serve = (line: string, sock: ModelSocket) => {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if ("nucleus_key" in frame) {
            expect(frame).toEqual({ nucleus_key: KEY });
            return;
          }
          // API key must never appear in any non-auth runtime line
          expect(line).not.toContain(KEY);
          const triggerFault = !faultUsed ? socketFault : "none";
          if (triggerFault === "text_frame") {
            faultUsed = true;
            queueMicrotask(() => sock.emit("message", { data: "unexpected text" }));
            return;
          }
          if (triggerFault === "oversized_line") {
            faultUsed = true;
            sock.reply({ id: frame.id, ok: { pad: "a".repeat(520_000) } });
            return;
          }
          if (triggerFault === "close_on_first_op") {
            faultUsed = true;
            sock.close(1006);
            return;
          }
          const replyPayload = frame.op === "whoami"
            ? { id: frame.id, ok: { handles: [{ endpoint: "swarm", actions: ["records", "status"] }] } }
            : frame.op === "swarm.records"
              ? { id: frame.id, ok: { swarm: frame.swarm, records: [{ seq: 1, text: "∑é🎉" }] } }
              : { id: frame.id, error: { code: "invalid_input", message: "unknown op" } };

          if (triggerFault === "invalid_utf8_then_valid") {
            faultUsed = true;
            const bad = new Uint8Array([0xff, 0xfe, 10]);
            const good = new TextEncoder().encode(`${JSON.stringify(replyPayload)}\n`);
            const combined = new Uint8Array(bad.length + good.length);
            combined.set(bad, 0);
            combined.set(good, bad.length);
            sock.sendRawBytes(combined);
            return;
          }
          if (triggerFault === "coalesce_two_replies") {
            faultUsed = true;
            const noise = new TextEncoder().encode(`{"id":999999,"ok":{}}\n${JSON.stringify(replyPayload)}\n`);
            sock.sendRawBytes(noise);
            return;
          }
          sock.reply(replyPayload);
        };

        class TestSocket extends ModelSocket {
          constructor(url: string, protocols: string[]) {
            const firstSocket = sockets.length === 0;
            super(url, protocols, serve, {
              agreed: firstSocket && socketFault === "wrong_protocol" ? "wrong-proto" : MATHOS_RUNTIME_SUBPROTOCOL,
              split,
              immediateCloseAfterOpen: firstSocket && socketFault === "immediate_close_after_open",
              sendThrowsOnAuth: firstSocket && socketFault === "send_throws_on_auth",
            });
            sockets.push(this);
          }
        }

        const deps: MathosPlatformDeps = {
          fetch,
          WebSocket: TestSocket,
          now: () => now,
          sleep: async (ms) => { now += ms; },
        };
        const conn = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, deps);
        let clientClosed = false;

        const assertNoSecretLeak = (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).not.toContain(KEY);
          for (const t of tickets) expect(msg).not.toContain(t);
        };

        // Guard against hanging requests (e.g., if immediate_close_after_open or send_throws_on_auth loses the close/error event!)
        const bounded = async <T,>(promise: Promise<T>): Promise<{ ok: T } | { err: unknown }> => {
          const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Request hung past 200ms")), 200));
          return await Promise.race([promise, timer]).then((ok) => ({ ok }), (err: unknown) => ({ err }));
        };

        for (const step of steps) {
          if (step.kind === "close") {
            conn.close();
            clientClosed = true;
          } else if (step.kind === "server_close") {
            sockets.at(-1)?.close(step.code);
            await new Promise((r) => setImmediate(r));
          } else if (step.kind === "unsupported") {
            const err = await conn.request(step.method, {}).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(Error);
            assertNoSecretLeak(err);
          } else if (step.kind === "hello") {
            const res = await bounded(conn.request("hello", {}));
            if ("err" in res) {
              expect(String(res.err)).not.toContain("Request hung past 200ms");
              assertNoSecretLeak(res.err);
            } else {
              expect(clientClosed).toBe(false);
              expect(res.ok).toMatchObject({ version: 1, import: true, execute: false, cancel: false, researchFunctions: false });
            }
          } else if (step.kind === "records") {
            const res = await bounded(conn.request("records", { project: "p", session: "s", swarm: "sw", after: step.after, limit: step.limit }));
            if ("err" in res) {
              expect(String(res.err)).not.toContain("Request hung past 200ms");
              assertNoSecretLeak(res.err);
            } else {
              expect(clientClosed).toBe(false);
              expect(res.ok).toMatchObject({ swarm: "sw", records: [{ seq: 1, text: "∑é🎉" }] });
            }
          } else if (step.kind === "concurrent_burst") {
            const results = await Promise.all(
              Array.from({ length: step.count }, (_, idx) =>
                bounded(conn.request("records", { project: "p", session: "s", swarm: `sw-${idx}`, after: 0, limit: 10 }))),
            );
            for (const r of results) {
              if ("err" in r) {
                expect(String(r.err)).not.toContain("Request hung past 200ms");
                assertNoSecretLeak(r.err);
              }
            }
            const okCount = results.filter((r) => "ok" in r).length;
            expect(okCount).toBeLessThanOrEqual(step.count);
          }
        }

        // If the first socket closed immediately after open, it MUST NOT hang or leave a live open socket;
        // a subsequent request on a ready platform must either fail fast or reconnect!
        conn.close();
        if (opensThisCall > 0) opsPerOpen.push(opensThisCall);
        for (const body of openBodies) expect(body.wake).toBe(false);
        // Each single openMathosRuntime call polls preparing at most 16 times (0s..30s at 2s intervals)
        for (const count of opsPerOpen) {
          expect(count).toBeLessThanOrEqual(16);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Shrunk counterexample from 1,000-run model (seed -719753315):
  // socket.send throwing while sending nucleus_key inside `open` left connectMathosRuntime
  // hanging until CONNECT_TIMEOUT_MS and emitted an uncaught exception.
  it("rejects immediately when socket.send throws while writing the initial auth line", async () => {
    class ThrowingAuthSocket extends ModelSocket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols, () => {}, { split: (b) => [b], agreed: MATHOS_RUNTIME_SUBPROTOCOL, sendThrowsOnAuth: true });
      }
    }
    await expect(
      connectMathosRuntime(
        { fetch: async () => new Response(), WebSocket: ThrowingAuthSocket },
        { origin: ORIGIN, team: TEAM, apiKey: KEY },
        { environment: ENV, ticket: "t1" },
      ),
    ).rejects.toThrow(/Could not send to the MathOS runtime/);
  });

  // Shrunk counterexample from 1,000-run model (seed -1239675193):
  // A 1008 close emitted right after `open` before post-await listeners attached was lost,
  // leaving closed=false and hanging requests until REQUEST_TIMEOUT_MS.
  it("marks the runtime socket closed when a 1008 close arrives right after open", async () => {
    class ImmediateCloseSocket extends ModelSocket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols, () => {}, { split: (b) => [b], agreed: MATHOS_RUNTIME_SUBPROTOCOL, immediateCloseAfterOpen: true });
      }
    }
    const rt = await connectMathosRuntime(
      { fetch: async () => new Response(), WebSocket: ImmediateCloseSocket },
      { origin: ORIGIN, team: TEAM, apiKey: KEY },
      { environment: ENV, ticket: "t1" },
    );
    expect(rt.closed).toBe(true);
    await expect(rt.request("whoami", {})).rejects.toThrow(/Not connected to the MathOS runtime/);
  });

  it("coalesces concurrent failed connects and shares a single recovery socket on retry", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (callers) => {
        let openAttempt = 0;
        const openedSockets: ModelSocket[] = [];
        const gate1 = Promise.withResolvers<void>();
        const fetch: MathosPlatformDeps["fetch"] = async (input) => {
          if (input === `${ORIGIN}/app/`) return new Response(`<script src="/app/assets/index-Race1.js"></script>`, { status: 200 });
          if (input === `${ORIGIN}/app/assets/index-Race1.js`) return new Response("const x={runtime:\"0.62.0\",ipc:6};", { status: 200 });
          if (input === `${ORIGIN}/v1/open`) {
            openAttempt++;
            if (openAttempt === 1) {
              await gate1.promise;
              return new Response(JSON.stringify({ error: "transient" }), { status: 503 });
            }
            return new Response(JSON.stringify({ state: "ready", environment: ENV, version: "0.62.0", ipc_version: 6, ticket: `t-${openAttempt}` }), { status: 200 });
          }
          return new Response("404", { status: 404 });
        };
        class RaceSocket extends ModelSocket {
          constructor(url: string, protocols: string[]) {
            super(
              url,
              protocols,
              (line, s) => {
                const f = JSON.parse(line) as Record<string, unknown>;
                if ("nucleus_key" in f) return;
                s.reply({ id: f.id, ok: { swarm: f.swarm, records: [] } });
              },
              { split: (b) => [b], agreed: MATHOS_RUNTIME_SUBPROTOCOL },
            );
            openedSockets.push(this);
          }
        }
        const conn = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, { fetch, WebSocket: RaceSocket, sleep: async () => {} });
        let retryPromise: Promise<unknown> | undefined;
        const firstBatch = Array.from({ length: callers }, (_, i) =>
          conn.request("records", { project: "p", session: "s", swarm: "sw" }).catch((e) => {
            if (i === 0) retryPromise = conn.request("records", { project: "p", session: "s", swarm: "sw-retry" });
            return e;
          }));
        gate1.resolve();
        await Promise.all(firstBatch);
        const followUp = conn.request("records", { project: "p", session: "s", swarm: "sw-follow" });
        await Promise.all([retryPromise, followUp]);
        // Concurrent initial failures coalesce on attempt 1, and concurrent recovery callers share attempt 2's socket.
        expect(openAttempt).toBe(2);
        expect(openedSockets).toHaveLength(1);
        conn.close();
      }),
      { numRuns: 50 },
    );
  });

  it("models listMathosTeams and listMathosSwarms paging, fallback and truncation", async () => {
    const pagingArb = fc.record({
      teamPages: fc.array(
        fc.array(fc.record({ valid: fc.boolean(), name: fc.string({ minLength: 0, maxLength: 20 }) }), { minLength: 0, maxLength: 4 }),
        { minLength: 1, maxLength: 7 },
      ),
      sessionCount: fc.integer({ min: 0, max: 215 }),
      sessionPageSize: fc.integer({ min: 5, max: 40 }),
      useConversationFallback: fc.boolean(),
      runningMask: fc.array(fc.constantFrom<"running" | "ended" | "no_swarm" | "refused">("running", "ended", "no_swarm", "refused"), { minLength: 1, maxLength: 10 }),
    });

    await fc.assert(
      fc.asyncProperty(pagingArb, async ({ teamPages, sessionCount, sessionPageSize, useConversationFallback, runningMask }) => {
        const allSessions = Array.from({ length: sessionCount }, (_, i) => ({ project: `p${i % 3}`, name: `s${i}` }));
        const fetch: MathosPlatformDeps["fetch"] = async (input, init) => {
          if (input === `${ORIGIN}/app/`) return new Response(`<script src="/app/assets/index-P1.js"></script>`, { status: 200 });
          if (input === `${ORIGIN}/app/assets/index-P1.js`) return new Response("const x={runtime:\"0.62.0\",ipc:6};", { status: 200 });
          if (input === `${ORIGIN}/v1/orgs`) {
            const body = JSON.parse(String(init.body)) as { after?: number };
            const pageIdx = body.after ?? 0;
            const entries = (teamPages[pageIdx] ?? []).map((entry, idx) => ({
              id: entry.valid ? `o-${String(pageIdx).padStart(8, "0")}-1234-4123-8123-${String(idx).padStart(12, "0")}` : `bad-${idx}`,
              name: entry.name,
            }));
            const hasMore = pageIdx + 1 < teamPages.length;
            return new Response(JSON.stringify({ orgs: entries, ...(hasMore ? { next: pageIdx + 1 } : {}) }), { status: 200 });
          }
          if (input === `${ORIGIN}/v1/open`) {
            return new Response(JSON.stringify({ state: "ready", environment: ENV, version: "0.62.0", ipc_version: 6, ticket: "t1" }), { status: 200 });
          }
          return new Response("404", { status: 404 });
        };

        class PagingSocket extends ModelSocket {
          constructor(url: string, protocols: string[]) {
            super(
              url,
              protocols,
              (line, sock) => {
                const frame = JSON.parse(line) as Record<string, unknown>;
                if ("nucleus_key" in frame) return;
                if (frame.op === "sessions.list") {
                  if (useConversationFallback) {
                    sock.reply({ id: frame.id, error: { code: "permission_denied", message: "no sessions" } });
                    return;
                  }
                  const start = typeof frame.after === "number" ? frame.after : 0;
                  const slice = allSessions.slice(start, start + sessionPageSize);
                  const next = start + slice.length < allSessions.length ? start + slice.length : undefined;
                  sock.reply({ id: frame.id, ok: { sessions: slice, ...(next !== undefined ? { next } : {}) } });
                  return;
                }
                if (frame.op === "conversation.list") {
                  const start = typeof frame.after === "number" ? frame.after : 0;
                  const slice = allSessions.slice(start, start + sessionPageSize);
                  const next = start + slice.length < allSessions.length ? start + slice.length : undefined;
                  sock.reply({ id: frame.id, ok: { sessions: slice, ...(next !== undefined ? { next_after: next } : {}) } });
                  return;
                }
                if (frame.op === "swarm.status") {
                  const idx = Number(String(frame.session).slice(1));
                  const kind = runningMask[idx % runningMask.length]!;
                  if (kind === "no_swarm") sock.reply({ id: frame.id, error: { code: "invalid_input", message: "this session has started no swarm" } });
                  else if (kind === "refused") sock.reply({ id: frame.id, error: { code: "permission_denied", message: "denied" } });
                  else sock.reply({ id: frame.id, ok: { swarm: `sw-${idx}`, state: kind, task: `Task ${idx}`, members: [{}], running: kind === "running" } });
                }
              },
              { split: (b) => [b], agreed: MATHOS_RUNTIME_SUBPROTOCOL },
            );
          }
        }

        const deps: MathosPlatformDeps = { fetch, WebSocket: PagingSocket, sleep: async () => {} };
        const teams = await listMathosTeams(deps, { origin: ORIGIN, apiKey: KEY });
        const expectedTeamCount = teamPages.slice(0, 5).reduce((sum, p) => sum + p.filter((e) => e.valid).length, 0);
        expect(teams).toHaveLength(expectedTeamCount);

        const maxVisible = Math.min(200, Math.min(sessionCount, 20 * sessionPageSize));
        const expectedSwarms = allSessions
          .slice(0, maxVisible)
          .filter((_, idx) => ["running", "ended"].includes(runningMask[idx % runningMask.length]!));
        const anyRefused = allSessions
          .slice(0, maxVisible)
          .some((_, idx) => runningMask[idx % runningMask.length] === "refused");

        if (expectedSwarms.length === 0 && anyRefused) {
          await expect(listMathosSwarms(deps, { origin: ORIGIN, team: TEAM, apiKey: KEY })).rejects.toThrow(/denied/);
        } else {
          const res = await listMathosSwarms(deps, { origin: ORIGIN, team: TEAM, apiKey: KEY });
          expect(res.sessions).toBe(maxVisible);
          expect(res.truncated).toBe(sessionCount > maxVisible);
          expect(res.swarms).toHaveLength(expectedSwarms.length);
          // Running swarms always precede non-running swarms
          const firstNonRunning = res.swarms.findIndex((s) => !s.running);
          if (firstNonRunning !== -1) {
            expect(res.swarms.slice(firstNonRunning).every((s) => !s.running)).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("stops polling a preparing VM immediately once the connection is closed", async () => {
    let polls = 0;
    let clock = 0;
    let sleeping = false;
    const gate = Promise.withResolvers<void>();
    const fetch: MathosPlatformDeps["fetch"] = async (input) => {
      if (input === `${ORIGIN}/app/`) return new Response(`<script src="/app/assets/index-Prep1.js"></script>`, { status: 200 });
      if (input === `${ORIGIN}/app/assets/index-Prep1.js`) return new Response("const x={runtime:\"0.62.0\",ipc:6};", { status: 200 });
      if (input === `${ORIGIN}/v1/open`) {
        polls++;
        return new Response(JSON.stringify({ state: "preparing" }), { status: 202 });
      }
      return new Response("404", { status: 404 });
    };
    const conn = openMathosPlatformConnection(
      { origin: ORIGIN, team: TEAM, apiKey: KEY },
      {
        fetch,
        WebSocket: ModelSocket as unknown as MathosPlatformDeps["WebSocket"],
        now: () => clock,
        sleep: async (ms) => {
          sleeping = true;
          clock += ms;
          if (polls === 1) await gate.promise;
        },
      },
    );
    const req = conn.request("hello", {});
    await vi.waitFor(() => expect(sleeping).toBe(true));
    conn.close();
    try {
      // Must reject immediately via abort signal while the polling sleep is still pending.
      await expect(req).rejects.toThrow(/closed/i);
      expect(polls).toBe(1);
    } finally {
      gate.resolve();
    }
  });

  it("enforces connect and request timeouts cleanly with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const silentSocket = class implements MathosSocket {
        protocol = MATHOS_RUNTIME_SUBPROTOCOL;
        binaryType = "blob";
        closed = false;
        listeners = new Map<string, Array<(e: { data?: unknown; code?: number }) => void>>();
        addEventListener(type: string, l: (e: { data?: unknown; code?: number }) => void) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
        }
        send() {}
        close() { this.closed = true; }
      };
      const connecting = connectMathosRuntime(
        { fetch: async () => new Response(), WebSocket: silentSocket },
        { origin: ORIGIN, team: TEAM, apiKey: KEY },
        { environment: ENV, ticket: "t1" },
      );
      const connectExpect = expect(connecting).rejects.toThrow(/did not answer in time/);
      await vi.advanceTimersByTimeAsync(15_001);
      await connectExpect;

      const openButSilent = class extends silentSocket {
        constructor() {
          super();
          queueMicrotask(() => {
            for (const l of this.listeners.get("open") ?? []) l({});
          });
        }
      };
      const rt = await connectMathosRuntime(
        { fetch: async () => new Response(), WebSocket: openButSilent },
        { origin: ORIGIN, team: TEAM, apiKey: KEY },
        { environment: ENV, ticket: "t1" },
      );
      const req = rt.request("whoami", {});
      const reqExpect = expect(req).rejects.toThrow(/did not answer in time/);
      await vi.advanceTimersByTimeAsync(30_001);
      await reqExpect;
      rt.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
