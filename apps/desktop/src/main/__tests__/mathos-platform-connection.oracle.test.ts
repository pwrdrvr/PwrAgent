import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { type ResearchHarnessRequest } from "@pwragent/shared/research-harness";
import { projectResearchRun } from "@pwragent/shared/research";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { ResearchHarnessService, type ResearchHarnessPorts } from "@pwragent/owner-core/research-harness-service";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import {
  MATHOS_RUNTIME_SUBPROTOCOL,
  listMathosSwarms,
  listMathosTeams,
  openMathosPlatformConnection,
  type MathosPlatformDeps,
  type MathosSocket,
} from "../research/mathos-platform-connection";

/**
 * The oracle: a fake MathOS Platform that answers exactly the shapes the
 * platform's own web client sends and checks, and a fake runtime socket that
 * splits its answers at arbitrary byte boundaries. An import through PwrAgent's
 * own client must read every source record into a run, and the key must reach
 * the platform only as the Bearer header and the runtime's first line.
 */

const ORIGIN = "https://os.example.test";
const TEAM = "o-12345678-1234-4123-8123-123456789abc";
const ENVIRONMENT = "avm-87654321-4321-4321-8321-cba987654321";
const KEY = "nuc_ak_contrived0000000000000000000000000000000000";
const SWARM = "fixture-swarm";

type OpenReply = { status: number; body: Record<string, unknown> };
type Platform = {
  deps: MathosPlatformDeps;
  calls: Array<{ url: string; method: string; authorization?: string; body?: Record<string, unknown> }>;
  sockets: FakeSocket[];
  frames: string[];
  opens: () => number;
};

class FakeSocket implements MathosSocket {
  binaryType = "blob";
  protocol = "";
  readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();
  private inbound = "";
  closedWith?: number;
  constructor(readonly url: string, readonly protocols: string[], private readonly server: (line: string, socket: FakeSocket) => void,
    agreed: string | undefined, private readonly split: (bytes: Uint8Array) => Uint8Array[]) {
    queueMicrotask(() => { this.protocol = agreed ?? protocols[0] ?? ""; this.emit("open", {}); });
  }
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown; code?: number }) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(data: Uint8Array) {
    this.inbound += new TextDecoder().decode(data);
    let newline = this.inbound.indexOf("\n");
    while (newline !== -1) {
      const line = this.inbound.slice(0, newline);
      this.inbound = this.inbound.slice(newline + 1);
      this.server(line, this);
      newline = this.inbound.indexOf("\n");
    }
  }
  /** Answers as binary frames, split where the test says. */
  reply(value: unknown) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    for (const piece of this.split(bytes)) {
      const buffer = piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength);
      queueMicrotask(() => this.emit("message", { data: buffer }));
    }
  }
  close(code = 1000) {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    queueMicrotask(() => this.emit("close", { code }));
  }
}

function platform(options: {
  records?: Array<Record<string, unknown>>;
  open?: () => OpenReply;
  split?: (bytes: Uint8Array) => Uint8Array[];
  agreed?: string;
  handles?: unknown;
  runtime?: (line: Record<string, unknown>, socket: FakeSocket) => boolean;
} = {}): Platform {
  const calls: Platform["calls"] = [];
  const sockets: FakeSocket[] = [];
  const frames: string[] = [];
  let opens = 0;
  const records = options.records ?? [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url: input, method: init.method ?? "GET", ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}), ...(body ? { body } : {}) });
    expect(init.redirect).toBe("error");
    // As the hosted platform does: / redirects to /app/, and a fetch that refuses redirects fails on it.
    if (input === `${ORIGIN}/`) throw new TypeError("fetch failed: redirect mode is set to error");
    if (input === `${ORIGIN}/app/`) return new Response(`<script type="module" src="/app/assets/index-Ab_9.js"></script>`, { status: 200 });
    if (input === `${ORIGIN}/app/assets/index-Ab_9.js`) return new Response("const config={web:!0,runtime:`0.61.0`,ipc:6};", { status: 200 });
    if (input === `${ORIGIN}/v1/orgs`) {
      return body?.after === undefined
        ? json(200, { orgs: [{ id: TEAM, name: "Contrived team", kind: "private", role: "owner" }, { id: "not-a-team", name: "Bad" }], next: "page-2" })
        : json(200, { orgs: [{ id: "o-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Second team", kind: "shared", role: "member" }] });
    }
    if (input === `${ORIGIN}/v1/open`) {
      opens += 1;
      const reply = options.open?.() ?? { status: 200, body: { state: "ready", environment: ENVIRONMENT, version: "0.61.0", ipc_version: 6,
        bundle_sha256: "0".repeat(64), programs_root: `/opt/nucleus/runtimes/${"0".repeat(64)}/bin`, ticket: `ticket-${opens}` } };
      return json(reply.status, reply.body);
    }
    return json(404, { error: "not found" });
  });
  const serve = (line: string, socket: FakeSocket) => {
    frames.push(line);
    const frame = JSON.parse(line) as Record<string, unknown>;
    if ("nucleus_key" in frame) { expect(frame).toEqual({ nucleus_key: KEY }); return; }
    if (options.runtime?.(frame, socket)) return;
    if (frame.op === "whoami") {
      socket.reply({ id: frame.id, ok: { process: 3, handles: options.handles ?? [{ endpoint: "swarm", actions: ["records", "status", "stop"] }], access: { kind: "window", role: "owner" } } });
    } else if (frame.op === "swarm.records") {
      const after = typeof frame.after === "number" ? frame.after : 0;
      const rest = records.filter((r) => (r.seq as number) > after);
      const page = rest.slice(0, frame.limit as number);
      socket.reply({ id: frame.id, ok: { swarm: frame.swarm, records: page, ...(rest.length > page.length ? { next: page.at(-1)!.seq } : {}) } });
    } else {
      socket.reply({ id: frame.id, error: { code: "invalid_input", message: `unknown variant \`${String(frame.op)}\`` } });
    }
  };
  const split = options.split ?? ((bytes: Uint8Array) => [bytes]);
  class Socket extends FakeSocket {
    constructor(url: string, protocols: string[]) { super(url, protocols, serve, options.agreed, split); sockets.push(this); }
  }
  return { deps: { fetch, WebSocket: Socket, sleep: async () => {} }, calls, sockets, frames, opens: () => opens };
}

/** A source swarm as the pinned record contract describes it. */
function sourceRecords(members: string[], findings: number): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [{ event: "started", swarm: SWARM, project: "fixture-project", session: "fixture-session", task: "Contrived objective",
    dir: `.ultramath/${SWARM}`, members, model: "fixture-model", member_steps: 10, budget: 30, deadline_at_ms: 1_800_000 }];
  for (let i = 0; i < findings; i++) {
    records.push({ event: "finding", swarm: SWARM, member: members[i % members.length], direction: `d${i}`, finding: `f${i}`, label: "note", text: `Contrived finding ${i}`, paths: [] });
  }
  records.push({ event: "ended", swarm: SWARM, outcome: "solved", calls: findings, reserved_calls: findings, checks: 0 });
  return records.map((record, i) => ({ ...record, seq: i + 1, at_ms: 1000 + i }));
}

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const services: ResearchHarnessService[] = [];
beforeEach(() => { fixture = createTempStateDb("pwragent-mathos-platform-"); db = StateDb.open(fixture.dbPath); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); });

function importRequest(): ResearchHarnessRequest {
  return { backend: "codex", threadId: "coordinator", requestId: randomUUID(), mode: "import", objective: "Contrived import", project: "fixture-project",
    session: "fixture-session", swarm: SWARM, budgetAcknowledged: false };
}

function service(target: Platform) {
  const store = new ResearchStore(db);
  const ports: ResearchHarnessPorts = { ownerId: "owner", ownerPid: 42, ownerStartedAt: 100, isOwnerAlive: () => true, changed: () => {}, now: () => 1000,
    schedule: () => () => {}, onError: () => {}, probe: async () => {},
    open: () => openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, target.deps) };
  const harness = new ResearchHarnessService(store, ports);
  services.push(harness);
  return { harness, store };
}

/** Cut points for a reply, so a JSON line arrives in arbitrary pieces. */
const splits = fc.array(fc.integer({ min: 1, max: 97 }), { maxLength: 6 }).map((sizes) => (bytes: Uint8Array) => {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) { if (offset >= bytes.length) break; pieces.push(bytes.slice(offset, offset + size)); offset += size; }
  if (offset < bytes.length) pieces.push(bytes.slice(offset));
  return pieces;
});

describe("PwrAgent's MathOS Platform client", () => {
  it("imports every source record into a run, whatever way the runtime splits its frames", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 120 }), splits, async (memberCount, findings, split) => {
      const records = sourceRecords(Array.from({ length: memberCount }, (_, i) => `m${i + 1}`), findings);
      const target = platform({ records, split });
      const { harness, store } = service(target);
      const started = await harness.start(importRequest(), fixture.tempDir);
      for (let i = 0; i < 10 && store.header(started.id)!.harness!.cursor < records.length; i++) await harness.poll(started.id);
      const run = store.get(started.id)!;
      expect(run).toEqual(projectResearchRun(run.id, run.events));
      // The source's own `ended` record settles the import.
      expect(run.harness).toMatchObject({ mode: "import", state: "ended", project: "fixture-project", session: "fixture-session", swarm: SWARM, cursor: records.length });
      expect(run.harness!.members).toHaveLength(memberCount);
      expect(run.findings).toHaveLength(findings);
      // Only reads were sent, and the key went only where the platform's web client sends it.
      const ops = target.frames.map((line) => JSON.parse(line) as Record<string, unknown>).filter((frame) => "op" in frame).map((frame) => frame.op);
      expect(new Set(ops)).toEqual(new Set(["whoami", "swarm.records"]));
      for (const line of target.frames) if (!line.startsWith("{\"nucleus_key\"")) expect(line).not.toContain(KEY);
      for (const call of target.calls) {
        expect(call.url).not.toContain(KEY);
        expect(JSON.stringify(call.body ?? {})).not.toContain(KEY);
        if (call.url.includes("/v1/")) expect(call.authorization).toBe(`Bearer ${KEY}`);
        else expect(call.authorization).toBeUndefined();
      }
    }), { numRuns: 40 });
  });

  it("opens the VM as the web app does, never waking it, and reports only what the runtime offers", async () => {
    const target = platform();
    const connection = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, target.deps);
    const hello = await connection.request("hello", {}) as Record<string, unknown>;
    expect(hello).toMatchObject({ version: 1, import: true, discovery: false, execute: false, cancel: false, researchFunctions: false });
    const open = target.calls.find((call) => call.url === `${ORIGIN}/v1/open`)!;
    expect(open.body).toEqual({ version: "0.61.0", ipc_version: 6, wake: false, ticket: true, team: TEAM });
    const socket = target.sockets[0]!;
    expect(socket.url).toBe(`wss://os.example.test/v1/runtime/${ENVIRONMENT}?ticket=ticket-1`);
    expect(socket.protocols).toEqual([MATHOS_RUNTIME_SUBPROTOCOL]);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(JSON.parse(target.frames[0]!)).toEqual({ nucleus_key: KEY });
    await expect(connection.request("execute", {})).rejects.toThrow(/only imports/);
    await expect(connection.request("cancel", {})).rejects.toThrow(/only imports/);
    await connection.close();
  });

  it("offers discovery only when the runtime both grants it and recognizes runs.list", async () => {
    const granted = [{ endpoint: "swarm", actions: ["records"] }, { endpoint: "discovery", actions: ["list", "status"] }];
    const unknown = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, platform({ handles: granted }).deps);
    expect(await unknown.request("hello", {})).toMatchObject({ discovery: false });
    const known = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, platform({ handles: granted, runtime: (frame, socket) => {
      if (frame.op !== "runs.list") return false;
      socket.reply({ id: frame.id, ok: { runs: [] } });
      return true;
    } }).deps);
    expect(await known.request("hello", {})).toMatchObject({ discovery: true, import: true });
  });

  it("says why it cannot open the VM, without the key", async () => {
    const cases: Array<[OpenReply, RegExp]> = [
      [{ status: 200, body: { state: "asleep" } }, /asleep\. Open MathOS to wake it/],
      [{ status: 401, body: { error: "invalid credential" } }, /did not accept this API key/],
      [{ status: 403, body: {} }, /may not open this team/],
      [{ status: 500, body: { error: "boom" } }, /HTTP 500: boom/],
      [{ status: 200, body: { state: "ready", environment: ENVIRONMENT, version: "0.60.0", ipc_version: 6, ticket: "t" } }, /does not match the requested runtime/],
      [{ status: 200, body: { state: "ready", environment: ENVIRONMENT, version: "0.61.0", ipc_version: 6, ticket: "has space" } }, /invalid runtime ticket/],
    ];
    for (const [reply, expected] of cases) {
      const target = platform({ open: () => reply });
      const connection = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, target.deps);
      const error = await connection.request("hello", {}).catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(expected);
      expect((error as Error).message).not.toContain(KEY);
      expect(target.calls.filter((call) => call.url.endsWith("/v1/open")).every((call) => call.body?.wake === false)).toBe(true);
    }
  });

  it("waits a bounded time for a VM the platform is preparing", async () => {
    let clock = 0;
    let replies = 0;
    const target = platform({ open: () => (++replies < 3
      ? { status: 202, body: { state: "preparing", stage: "starting" } }
      : { status: 200, body: { state: "ready", environment: ENVIRONMENT, version: "0.61.0", ipc_version: 6, ticket: "ticket-ready" } }) });
    const connection = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY },
      { ...target.deps, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(await connection.request("hello", {})).toMatchObject({ import: true });
    expect(replies).toBe(3);
    const forever = platform({ open: () => ({ status: 202, body: { state: "preparing", stage: "waiting_for_machine" } }) });
    const stuck = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY },
      { ...forever.deps, now: () => clock, sleep: async (ms) => { clock += ms; } });
    await expect(stuck.request("hello", {})).rejects.toThrow(/still preparing/);
    // It polled, and it stopped at its bound instead of waiting forever.
    expect(forever.opens()).toBeGreaterThan(1);
    expect(forever.opens()).toBeLessThanOrEqual(16);
  });

  it("refuses a different runtime protocol and an over-long line, and reconnects after the runtime closes", async () => {
    const mismatched = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, platform({ agreed: "something-else" }).deps);
    await expect(mismatched.request("hello", {})).rejects.toThrow(/different protocol version/);

    const flood = platform({ runtime: (frame, socket) => {
      if (frame.op !== "whoami") return false;
      socket.reply({ id: frame.id, ok: { padding: "x".repeat(600_000) } });
      return true;
    } });
    const flooded = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, flood.deps);
    await expect(flooded.request("hello", {})).rejects.toThrow(/longer than PwrAgent reads/);

    const target = platform({ records: sourceRecords(["m1"], 3) });
    const connection = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, target.deps);
    await connection.request("hello", {});
    target.sockets[0]!.close(1006);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const page = await connection.request("records", { project: "fixture-project", session: "fixture-session", swarm: SWARM, after: 0, limit: 50 }) as { records: unknown[] };
    expect(page.records).toHaveLength(5);
    // A fresh ticket for the new socket: reads are repeatable, tickets are not.
    expect(target.opens()).toBe(2);
    expect(target.sockets[1]!.url).toContain("ticket=ticket-2");
  });

  it("never continues a run from a different source than the one it was imported from", async () => {
    const records = sourceRecords(["m1", "m2"], 4).filter((record) => record.event !== "ended");
    const first = platform({ records: records.slice(0, 3) });
    const other = platform({ records });
    let target = { team: TEAM, deps: first.deps };
    const store = new ResearchStore(db);
    const harness = new ResearchHarnessService(store, { ownerId: "owner", ownerPid: 42, ownerStartedAt: 100, isOwnerAlive: () => true, changed: () => {},
      now: () => 1000, schedule: () => () => {}, onError: () => {}, probe: async () => {},
      open: () => openMathosPlatformConnection({ origin: ORIGIN, team: target.team, apiKey: KEY }, target.deps) });
    services.push(harness);
    const started = await harness.start(importRequest(), fixture.tempDir);
    for (let i = 0; i < 5 && store.header(started.id)!.harness!.cursor < 3; i++) await harness.poll(started.id);
    await harness.stop(started.id, { backend: "codex", threadId: "coordinator", kind: "operator" }, "stopped", "Contrived stop").catch(() => undefined);
    const before = store.get(started.id)!.harness!;
    expect(before.sourceKey).toBe(`mathos:${ORIGIN}#${TEAM}`);
    // Another team holding the same project, session and swarm names is a different source.
    target = { team: "o-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", deps: other.deps };
    const refused = await harness.reconcile(started.id, { backend: "codex", threadId: "coordinator", kind: "operator" });
    expect(refused.harness!.cursor).toBe(before.cursor);
    expect(refused.harness!.note).toMatch(/different Harness source/);
    expect(other.frames.filter((line) => line.includes("swarm.records"))).toHaveLength(0);
  });

  it("says which step failed when the web app's runtime version cannot be read", async () => {
    const missing = platform();
    const deps = { ...missing.deps, fetch: async (input: string, init: RequestInit) =>
      (input.endsWith("/app/") ? new Response("<html></html>", { status: 200 }) : missing.deps.fetch(input, init)) };
    const connection = openMathosPlatformConnection({ origin: ORIGIN, team: TEAM, apiKey: KEY }, deps);
    await expect(connection.request("hello", {})).rejects.toThrow(/runtime version from its web app \(no entry script\)/);
    // Nothing was opened without a runtime version.
    expect(missing.opens()).toBe(0);
  });

  it("lists each session's swarm across session pages, skipping sessions that started none", async () => {
    const sessions = [
      { project: "alpha", name: "default" }, { project: "alpha", name: "quiet" },
      { project: "beta", name: "default" }, { project: "beta", name: "second" },
    ];
    const statuses: Record<string, Record<string, unknown>> = {
      "alpha/default": { swarm: "s-old", state: "ended", task: "Prove   the lemma\n quickly", members: [{}, {}], running: false },
      "beta/second": { swarm: "s-live", state: "running", task: "Search", limits: { members: 3 }, running: true },
      "beta/default": { swarm: "s-two", state: "interrupted", task: "", members: [{}], running: false },
    };
    const target = platform({ runtime: (frame, socket) => {
      if (frame.op === "sessions.list") {
        const page = frame.after === undefined ? { sessions: sessions.slice(0, 2), next: "alpha/quiet" } : { sessions: sessions.slice(2) };
        socket.reply({ id: frame.id, ok: page });
        return true;
      }
      if (frame.op === "swarm.status") {
        const status = statuses[`${String(frame.project)}/${String(frame.session)}`];
        socket.reply(status ? { id: frame.id, ok: status } : { id: frame.id, error: { code: "invalid_input", message: "this session has started no swarm" } });
        return true;
      }
      return false;
    } });
    const listed = await listMathosSwarms(target.deps, { origin: ORIGIN, team: TEAM, apiKey: KEY });
    expect(listed).toEqual({ sessions: 4, truncated: false, swarms: [
      // Running first, then in the order the VM lists its sessions.
      { project: "beta", session: "second", swarm: "s-live", state: "running", task: "Search", members: 3, running: true },
      { project: "alpha", session: "default", swarm: "s-old", state: "ended", task: "Prove the lemma quickly", members: 2, running: false },
      { project: "beta", session: "default", swarm: "s-two", state: "interrupted", task: "", members: 1, running: false },
    ] });
    // Only reads, and the socket is closed when the list is done.
    const ops = new Set(target.frames.map((line) => JSON.parse(line) as Record<string, unknown>).filter((frame) => "op" in frame).map((frame) => frame.op));
    expect(ops).toEqual(new Set(["sessions.list", "swarm.status"]));
    expect(target.sockets[0]!.closedWith).toBe(1000);
    expect(target.opens()).toBe(1);
  });

  it("falls back to the conversation list, and reports a refusal rather than an empty VM", async () => {
    const fallback = platform({ runtime: (frame, socket) => {
      if (frame.op === "sessions.list") { socket.reply({ id: frame.id, error: { code: "permission_denied", message: "not granted" } }); return true; }
      if (frame.op === "conversation.list") { socket.reply({ id: frame.id, ok: { sessions: [{ project: "alpha", name: "default" }], next_after: null } }); return true; }
      if (frame.op === "swarm.status") { socket.reply({ id: frame.id, ok: { swarm: "s1", state: "ended", task: "T", members: [], running: false } }); return true; }
      return false;
    } });
    expect((await listMathosSwarms(fallback.deps, { origin: ORIGIN, team: TEAM, apiKey: KEY })).swarms.map((entry) => entry.swarm)).toEqual(["s1"]);

    const refused = platform({ runtime: (frame, socket) => {
      if (frame.op === "sessions.list") { socket.reply({ id: frame.id, ok: { sessions: [{ project: "alpha", name: "default" }] } }); return true; }
      if (frame.op === "swarm.status") { socket.reply({ id: frame.id, error: { code: "permission_denied", message: "swarm status is not granted" } }); return true; }
      return false;
    } });
    await expect(listMathosSwarms(refused.deps, { origin: ORIGIN, team: TEAM, apiKey: KEY })).rejects.toThrow(/not granted/);
  });

  it("lists the key's teams across pages and drops anything that is not a team", async () => {
    const target = platform();
    expect(await listMathosTeams(target.deps, { origin: ORIGIN, apiKey: KEY })).toEqual([
      { id: TEAM, name: "Contrived team" },
      { id: "o-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Second team" },
    ]);
  });
});
