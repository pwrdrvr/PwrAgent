import { RESEARCH_HARNESS_REVISION, MATHOS_TEAM_ID, type MathosSwarm, type MathosTeam } from "@pwragent/shared/research-harness";
import type { ResearchHarnessConnection } from "@pwragent/owner-core/research-harness-service";

/**
 * PwrAgent's own read-only client for the hosted MathOS Platform. It replaces a
 * bridge process for imports: the owner opens the team's VM the way the
 * platform's web app does and reads swarm records over the runtime socket.
 *
 * - Platform calls are HTTPS `POST /v1/<op>` with `Authorization: Bearer <key>`.
 * - `open` (`wake: false`, `ticket: true`) answers the VM's environment and a
 *   one-use runtime ticket. It never wakes an asleep VM.
 * - The runtime is a WebSocket on `/v1/runtime/<environment>?ticket=…` with the
 *   `agent-vm-runtime-v1` subprotocol. The first line carries the key; then
 *   binary UTF-8 JSON lines `{id, op, …}` are answered `{id, ok}` or `{id, error}`.
 *
 * The key leaves the owner only in those two requests to the configured
 * origin. It is never in a child process, a log line, an error or the journal.
 * Only reads are sent: `whoami`, `swarm.records`, `swarm.status` and, when the
 * runtime recognizes them, `runs.*` observations. Execution and cancellation
 * are not offered, so the owner never asks for them.
 */

export const MATHOS_RUNTIME_SUBPROTOCOL = "agent-vm-runtime-v1";
/** Where the platform serves its web app. */
export const MATHOS_WEB_APP_PATH = "/app/";
const HTTP_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a check or import waits for a VM the platform is still preparing. */
const PREPARING_WAIT_MS = 30_000;
const PREPARING_POLL_MS = 2_000;
const MAX_HTTP_BYTES = 1_048_576;
/** The adapter's frame bound; the service validates pages far below it. */
const MAX_LINE_BYTES = 512_000;
const MAX_OUTSTANDING = 16;
const SEND_CHUNK_BYTES = 65_536;
const ENVIRONMENT_ID = /^avm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TICKET = /^[\x21-\x7e]{1,1024}$/;
const RUNTIME_PIN = /runtime:\s*["'`](\d{1,8}\.\d{1,8}\.\d{1,8})["'`]\s*,\s*ipc:\s*(\d{1,10})/;
const ENTRY_SCRIPT = /\/app\/assets\/index-[A-Za-z0-9_-]{1,64}\.js/;

export type MathosPlatformTarget = { origin: string; team: string; apiKey: string };
export type MathosRuntimeVersion = { version: string; ipc: number };

/** What the owner needs of a WebSocket; Node's global and test fakes both fit. */
export type MathosSocket = {
  readonly protocol: string;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown; code?: number }) => void): void;
};
export type MathosPlatformDeps = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  WebSocket: new (url: string, protocols: string[]) => MathosSocket;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class MathosPlatformError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** Reads a bounded body; refuses one larger than `limit`. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new MathosPlatformError("The MathOS Platform answered more than PwrAgent reads.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The platform's own words, bounded and on one line. Never contains the key, which is only sent in a header. */
function platformWords(value: unknown): string | undefined {
  const body = record(value);
  const text = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : undefined;
  return text?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

async function platformFetch(deps: MathosPlatformDeps, url: string, init: RequestInit): Promise<{ status: number; value: unknown; text: string }> {
  let response: Response;
  try {
    response = await deps.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    throw new MathosPlatformError("Could not reach the MathOS Platform. Check the address and your network.", "unreachable");
  }
  const text = await readBounded(response, MAX_HTTP_BYTES);
  return { status: response.status, value: parseJson(text), text };
}

/** One platform operation, as the platform's web client calls it. */
async function platformCall(deps: MathosPlatformDeps, target: Pick<MathosPlatformTarget, "origin" | "apiKey">, op: string, body: Record<string, unknown>) {
  return await platformFetch(deps, new URL(`/v1/${op}`, target.origin).href, {
    method: "POST",
    headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function refused(status: number, value: unknown, action: string): MathosPlatformError {
  if (status === 401) return new MathosPlatformError("The MathOS Platform did not accept this API key.", "unauthorized");
  if (status === 403) return new MathosPlatformError(`This API key may not ${action}.`, "forbidden");
  const words = platformWords(value);
  return new MathosPlatformError(`The MathOS Platform could not ${action} (HTTP ${status}${words ? `: ${words}` : ""}).`);
}

/**
 * The runtime version the platform's own web app opens VMs with. `open` names
 * a version, and asking for the one the platform currently serves is what
 * keeps this client from requesting a runtime change on the team's VM.
 */
export async function readMathosRuntimeVersion(deps: MathosPlatformDeps, origin: string): Promise<MathosRuntimeVersion> {
  const unreadable = (detail: string) =>
    new MathosPlatformError(`Could not read the MathOS Platform’s runtime version from its web app (${detail}).`, "runtime_version");
  // The web app lives at /app/; the platform answers / with a redirect there, and no request here follows redirects.
  // An unreachable platform keeps its own advice to check the address and the network.
  const wrap = (detail: string) => (error: unknown): never => {
    throw error instanceof MathosPlatformError && error.code === "unreachable" ? error : unreadable(detail);
  };
  const page = await platformFetch(deps, new URL(MATHOS_WEB_APP_PATH, origin).href, { method: "GET" }).catch(wrap(`${MATHOS_WEB_APP_PATH} did not load`));
  if (page.status !== 200) throw unreadable(`${MATHOS_WEB_APP_PATH} answered HTTP ${page.status}`);
  const entry = ENTRY_SCRIPT.exec(page.text)?.[0];
  if (!entry) throw unreadable("no entry script");
  const script = await platformFetch(deps, new URL(entry, origin).href, { method: "GET" }).catch(wrap("the entry script did not load"));
  const pin = RUNTIME_PIN.exec(script.text);
  const ipc = pin ? Number(pin[2]) : NaN;
  if (script.status !== 200) throw unreadable(`the entry script answered HTTP ${script.status}`);
  if (!pin || !Number.isSafeInteger(ipc) || ipc <= 0 || ipc > 4_294_967_295) throw unreadable("no runtime version in the entry script");
  return { version: pin[1]!, ipc };
}

/** The teams this key can open, for Settings. A page at a time, at most five pages. */
export async function listMathosTeams(deps: MathosPlatformDeps, target: Pick<MathosPlatformTarget, "origin" | "apiKey">): Promise<MathosTeam[]> {
  const teams: MathosTeam[] = [];
  let after: unknown;
  for (let page = 0; page < 5; page++) {
    const { status, value } = await platformCall(deps, target, "orgs", after === undefined ? {} : { after });
    if (status !== 200) throw refused(status, value, "list your teams");
    const body = record(value);
    if (!Array.isArray(body?.orgs)) throw new MathosPlatformError("The MathOS Platform returned an invalid team list.");
    for (const entry of body.orgs) {
      const team = record(entry);
      if (typeof team?.id === "string" && MATHOS_TEAM_ID.test(team.id) && typeof team.name === "string") {
        teams.push({ id: team.id, name: team.name.replace(/\s+/g, " ").trim().slice(0, 120) || team.id });
      }
    }
    after = body.next;
    if (after === undefined || after === null) break;
  }
  return teams;
}

/** Opens the team's VM for a runtime ticket. `wake: false`: an asleep VM stays asleep. */
export async function openMathosRuntime(deps: MathosPlatformDeps, target: MathosPlatformTarget, runtime: MathosRuntimeVersion): Promise<{ environment: string; ticket: string }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (;;) {
    const { status, value } = await platformCall(deps, target, "open",
      { version: runtime.version, ipc_version: runtime.ipc, wake: false, ticket: true, team: target.team });
    const body = record(value);
    if (body?.state === "asleep" || body?.code === "asleep") {
      throw new MathosPlatformError("This team’s MathOS VM is asleep. Open MathOS to wake it, then try again.", "asleep");
    }
    if ((status === 200 || status === 202) && body?.state === "preparing") {
      if (now() - started >= PREPARING_WAIT_MS) {
        throw new MathosPlatformError("The MathOS Platform is still preparing this team’s VM. Try again in a few minutes.", "preparing");
      }
      await sleep(PREPARING_POLL_MS);
      continue;
    }
    if (status !== 200) throw refused(status, value, "open this team’s VM");
    if (body?.state !== "ready" || typeof body.environment !== "string" || !ENVIRONMENT_ID.test(body.environment)
      || body.version !== runtime.version || body.ipc_version !== runtime.ipc) {
      throw new MathosPlatformError("The MathOS Platform opened a VM that does not match the requested runtime.");
    }
    if (typeof body.ticket !== "string" || !TICKET.test(body.ticket)) {
      throw new MathosPlatformError("The MathOS Platform returned an invalid runtime ticket.");
    }
    return { environment: body.environment, ticket: body.ticket };
  }
}

type RuntimeSocket = {
  request(op: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
  readonly closed: boolean;
};

/** Connects to the runtime and signs in with the key as its first line. */
export async function connectMathosRuntime(deps: MathosPlatformDeps, target: MathosPlatformTarget,
  opened: { environment: string; ticket: string }): Promise<RuntimeSocket> {
  const url = new URL(`/v1/runtime/${opened.environment}`, target.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", opened.ticket);
  const socket = new deps.WebSocket(url.href, [MATHOS_RUNTIME_SUBPROTOCOL]);
  socket.binaryType = "arraybuffer";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let closed = false;
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;

  const fail = (message: string) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new MathosPlatformError(message)); }
    pending.clear();
    try { socket.close(1000); } catch { /* already closing */ }
  };
  const write = (line: string) => {
    const bytes = encoder.encode(line);
    for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK_BYTES) socket.send(bytes.subarray(offset, offset + SEND_CHUNK_BYTES));
  };
  const answer = (bytes: Uint8Array) => {
    let frame: Record<string, unknown> | undefined;
    try { frame = record(JSON.parse(decoder.decode(bytes))); } catch { return; }
    const id = frame?.id;
    if (typeof id !== "number" || !pending.has(id)) return;
    const entry = pending.get(id)!;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (Object.hasOwn(frame!, "ok")) { entry.resolve(frame!.ok); return; }
    const error = record(frame!.error);
    const message = typeof error?.message === "string" ? error.message.replace(/\s+/g, " ").trim().slice(0, 300) : "The MathOS runtime refused the request.";
    entry.reject(new MathosPlatformError(message, typeof error?.code === "string" ? error.code : undefined));
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { closed = true; try { socket.close(1000); } catch { /* not open */ } reject(error); } else resolve();
    };
    const timer = setTimeout(() => settle(new MathosPlatformError("The MathOS runtime did not answer in time.")), CONNECT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      if (socket.protocol !== MATHOS_RUNTIME_SUBPROTOCOL) { settle(new MathosPlatformError("The MathOS runtime speaks a different protocol version.")); return; }
      write(`${JSON.stringify({ nucleus_key: target.apiKey })}\n`);
      settle();
    });
    socket.addEventListener("error", () => settle(new MathosPlatformError("Could not connect to the MathOS runtime.")));
    socket.addEventListener("close", () => settle(new MathosPlatformError("Could not connect to the MathOS runtime.")));
  });

  socket.addEventListener("message", ({ data }) => {
    if (closed) return;
    if (typeof data === "string") { fail("The MathOS runtime sent an unexpected text frame."); return; }
    const chunk = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
    if (!chunk) { fail("The MathOS runtime sent an unexpected frame."); return; }
    let start = 0;
    for (let newline = chunk.indexOf(10); newline !== -1 && !closed; newline = chunk.indexOf(10, start)) {
      // Refuse before copying: a frame's size is the runtime's choice, not ours.
      if (bufferedBytes + newline - start > MAX_LINE_BYTES) { fail("The MathOS runtime sent a line longer than PwrAgent reads."); return; }
      const line = new Uint8Array(bufferedBytes + newline - start);
      let offset = 0;
      for (const piece of buffered) { line.set(piece, offset); offset += piece.length; }
      line.set(chunk.subarray(start, newline), offset);
      buffered = [];
      bufferedBytes = 0;
      start = newline + 1;
      answer(line);
    }
    if (start < chunk.length) { buffered.push(chunk.slice(start)); bufferedBytes += chunk.length - start; }
    if (bufferedBytes > MAX_LINE_BYTES) fail("The MathOS runtime sent a line longer than PwrAgent reads.");
  });
  socket.addEventListener("close", ({ code }) => fail(code === 1008
    ? "The MathOS runtime refused this connection."
    : "The MathOS runtime connection closed."));

  return {
    request(op, params) {
      if (closed) return Promise.reject(new MathosPlatformError("Not connected to the MathOS runtime."));
      if (pending.size >= MAX_OUTSTANDING) return Promise.reject(new MathosPlatformError("Too many MathOS runtime requests are outstanding."));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new MathosPlatformError("The MathOS runtime did not answer in time.")); }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try { write(`${JSON.stringify({ ...params, op, id })}\n`); }
        catch { fail("Could not send to the MathOS runtime."); }
      });
    },
    close: () => fail("The MathOS runtime connection closed."),
    get closed() { return closed; },
  };
}

/** Sessions looked through for swarms; the rest are reported as not looked at. */
const MAX_LISTED_SESSIONS = 200;
/** Session status reads in flight at once, well inside the runtime's request bound. */
const STATUS_CONCURRENCY = 8;
const NO_SWARM = /started no swarm|has no swarm/i;

type SessionRef = { project: string; session: string };

/** Every session on the VM by project and name, a page at a time: `sessions.list`, else `conversation.list`. */
async function listSessions(runtime: RuntimeSocket): Promise<{ sessions: SessionRef[]; truncated: boolean }> {
  const read = async (op: "sessions.list" | "conversation.list") => {
    const sessions: SessionRef[] = [];
    let after: unknown;
    for (let page = 0; page < 20; page++) {
      const body = record(await runtime.request(op, after === undefined ? {} : { after }));
      if (!Array.isArray(body?.sessions)) throw new MathosPlatformError("The MathOS runtime returned an invalid session list.");
      after = op === "sessions.list" ? body.next : body.next_after;
      const more = after !== undefined && after !== null;
      for (const [index, entry] of body.sessions.entries()) {
        const session = record(entry);
        if (typeof session?.project === "string" && typeof session.name === "string") sessions.push({ project: session.project, session: session.name });
        // Truncated only when something is left unread: later entries on this page, or another page.
        if (sessions.length >= MAX_LISTED_SESSIONS) return { sessions, truncated: more || index < body.sessions.length - 1 };
      }
      if (!more) return { sessions, truncated: false };
    }
    return { sessions, truncated: true };
  };
  try {
    return await read("sessions.list");
  } catch (error) {
    // A window may hold the conversation list without the sessions service's.
    if (error instanceof MathosPlatformError && error.code === "permission_denied") return await read("conversation.list");
    throw error;
  }
}

/**
 * The swarms on the team's VM: each session's running or latest swarm, from
 * its read-only `swarm.status`. Sessions that started none are skipped. Opens
 * the VM as an import does, reads, and closes; nothing is written anywhere.
 */
export async function listMathosSwarms(deps: MathosPlatformDeps, target: MathosPlatformTarget):
  Promise<{ swarms: MathosSwarm[]; sessions: number; truncated: boolean }> {
  const version = await readMathosRuntimeVersion(deps, target.origin);
  const runtime = await connectMathosRuntime(deps, target, await openMathosRuntime(deps, target, version));
  try {
    const { sessions, truncated } = await listSessions(runtime);
    const swarms: Array<MathosSwarm | undefined> = new Array(sessions.length);
    let refused: unknown;
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < sessions.length; i = next++) {
        const { project, session } = sessions[i]!;
        try {
          const status = record(await runtime.request("swarm.status", { project, session }));
          const limits = record(status?.limits);
          if (typeof status?.swarm !== "string") continue;
          swarms[i] = {
            project, session, swarm: status.swarm,
            state: typeof status.state === "string" ? status.state : "unknown",
            task: typeof status.task === "string" ? status.task.replace(/\s+/g, " ").trim().slice(0, 240) : "",
            members: Array.isArray(status.members) ? status.members.length : typeof limits?.members === "number" ? limits.members : 0,
            running: status.running === true,
          };
        } catch (error) {
          if (!(error instanceof MathosPlatformError && NO_SWARM.test(error.message))) refused ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, sessions.length) }, worker));
    const found = swarms.filter((swarm): swarm is MathosSwarm => swarm !== undefined);
    // Every status read refused for another reason: say why rather than report an empty VM.
    if (!found.length && refused) throw refused;
    // Running swarms first, then by project and session as the VM lists them.
    found.sort((a, b) => Number(b.running) - Number(a.running));
    return { swarms: found, sessions: sessions.length, truncated };
  } finally {
    runtime.close();
  }
}

type Handle = { endpoint: string; actions: string[] };
function handles(whoami: unknown): Handle[] {
  const list = record(whoami)?.handles;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const handle = record(entry);
    return typeof handle?.endpoint === "string" && Array.isArray(handle.actions)
      ? [{ endpoint: handle.endpoint, actions: handle.actions.filter((action): action is string => typeof action === "string") }]
      : [];
  });
}
const may = (list: Handle[], endpoint: string, action: string) => list.some((h) => h.endpoint === endpoint && h.actions.includes(action));

/**
 * The connection the Harness owner uses in place of a bridge process. It opens
 * the VM on first use and again after the runtime closes, since every request
 * it sends is a read that can be repeated.
 */
export function openMathosPlatformConnection(target: MathosPlatformTarget, deps: MathosPlatformDeps): ResearchHarnessConnection {
  let runtime: Promise<RuntimeSocket> | undefined;
  let socket: RuntimeSocket | undefined;
  let closed = false;

  const connect = async (): Promise<RuntimeSocket> => {
    if (closed) throw new MathosPlatformError("The MathOS Platform connection is closed.");
    if (socket?.closed) { runtime = undefined; socket = undefined; }
    runtime ??= (async () => {
      const version = await readMathosRuntimeVersion(deps, target.origin);
      const opened = await openMathosRuntime(deps, target, version);
      const connected = await connectMathosRuntime(deps, target, opened);
      if (closed) { connected.close(); throw new MathosPlatformError("The MathOS Platform connection is closed."); }
      socket = connected;
      return connected;
    })();
    try { return await runtime; } catch (error) { runtime = undefined; throw error; }
  };

  const observe = async (op: string, params: Record<string, unknown>) => (await connect()).request(op, params);
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);

  return {
    source: `mathos:${target.origin}#${target.team}`,
    async request(method, params) {
      if (method === "hello") {
        const runtimeSocket = await connect();
        const usable = handles(await runtimeSocket.request("whoami", {}));
        // A handle alone does not show the window offers the operation: the
        // deployed runtime held a discovery-capable team with no `runs.*`.
        // A read-only `runs.list` of one run settles it; any refusal means no discovery.
        const discovery = may(usable, "discovery", "status")
          && await runtimeSocket.request("runs.list", { limit: 1 }).then(() => true, () => false);
        return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: may(usable, "swarm", "records"),
          discovery, execute: false, cancel: false, researchFunctions: false };
      }
      const project = text(params.project);
      if (method === "records") {
        const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(50, params.limit) : 50;
        return await observe("swarm.records", { project, session: text(params.session), swarm: text(params.swarm),
          ...(typeof params.after === "number" ? { after: params.after } : {}), limit });
      }
      if (method === "status") return await observe("swarm.status", { project, session: text(params.session), swarm: text(params.swarm) });
      if (method === "discovery.status") return await observe("runs.status", { project, run: text(params.run) });
      if (method === "discovery.problems") return await observe("runs.problems", { project, run: text(params.run) });
      if (method === "discovery.tree") return await observe("runs.tree", { project, run: text(params.run), problem: text(params.problem) });
      throw new MathosPlatformError("The MathOS Platform does not offer that to PwrAgent; only imports are available.");
    },
    close() {
      closed = true;
      socket?.close();
      void runtime?.then((connected) => connected.close(), () => undefined);
    },
  };
}
