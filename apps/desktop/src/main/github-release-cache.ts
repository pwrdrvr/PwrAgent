import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lockSync } from "proper-lockfile";
import { resolvePwragentRoot } from "./profile";

export const RELEASE_FIRST_CHECK_DELAY_MS = 10 * 60_000;
export const RELEASE_AUTOMATIC_TTL_MS = 60 * 60_000;
export const RELEASE_AUTOMATIC_HOURLY_BUDGET = 6;
const REQUEST_LEASE_MS = 30_000;

type Entry = {
  lastAttempt?: number;
  lastSuccess?: number;
  nextAttempt?: number;
  pendingUntil?: number;
  failures?: number;
  etag?: string;
  body?: string;
};
type State = {
  version: 1;
  createdAt: number;
  automaticAttempts: number[];
  appCheckAt?: number;
  rateLimitUntil?: number;
  entries: Record<string, Entry>;
};

type Options = {
  directory?: string;
  now?: () => number;
  fetch?: typeof fetch;
  manual?: boolean;
  ttlMs?: number;
};

export class ReleaseCheckDeferredError extends Error {
  constructor(readonly retryAt: number) {
    super(`Release checks resume at ${new Date(retryAt).toISOString()}.`);
    this.name = "ReleaseCheckDeferredError";
  }
}

/** One public-release cache per PwrAgent root, independent of profile/version. */
function withState<T>(options: Options, operation: (state: State, now: number) => { value: T; changed?: boolean }): T {
  const now = (options.now ?? Date.now)();
  const directory = options.directory ?? path.join(resolvePwragentRoot(), "cache", "github-releases");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "state.json");
  // Only the synchronous read/reserve/write is locked, never the HTTP wait.
  // proper-lockfile recovers abandoned locks without a PID-reuse race.
  let unlock: () => void;
  try {
    unlock = lockSync(file, { realpath: false, retries: 0, stale: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new ReleaseCheckDeferredError(now + REQUEST_LEASE_MS);
    }
    throw error;
  }
  try {
    let state: State;
    let fresh = false;
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as State;
      if (state.version !== 1 || !Number.isFinite(state.createdAt)
        || !Array.isArray(state.automaticAttempts) || !state.entries
        || typeof state.entries !== "object") throw new Error("Invalid release cache");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)
        && !(error instanceof Error && error.message === "Invalid release cache")) throw error;
      state = { version: 1, createdAt: now, automaticAttempts: [], entries: {} };
      fresh = true;
    }
    const result = operation(state, now);
    if (fresh || result.changed) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, file);
    }
    return result.value;
  } finally {
    unlock();
  }
}

function freshRootDelay(state: State, now: number): number {
  // A backwards clock jump must not make an old timestamp immediately eligible.
  return Math.max(state.createdAt + RELEASE_FIRST_CHECK_DELAY_MS, now < state.createdAt ? now + RELEASE_FIRST_CHECK_DELAY_MS : 0);
}

/** Reserve the whole updater check, including the generic manifest request. */
export function reserveAppReleaseCheck(manual: boolean, options: Options = {}): void {
  const retryAt = withState(options, (state, now) => {
    const blockedUntil = Math.max(state.rateLimitUntil ?? 0, manual ? 0 : freshRootDelay(state, now),
      manual || state.appCheckAt === undefined ? 0 : state.appCheckAt + RELEASE_AUTOMATIC_TTL_MS);
    if (now < blockedUntil) return { value: blockedUntil };
    state.appCheckAt = now;
    return { value: 0, changed: true };
  });
  if (retryAt) throw new ReleaseCheckDeferredError(retryAt);
}

function cachedResponse(entry: Entry): Response {
  return new Response(entry.body, { headers: {
    "Content-Type": "application/json",
    ...(entry.etag ? { etag: entry.etag } : {}),
  } });
}

/** Persist reservations before HTTP so crashes/restarts cannot reset the budget. */
export async function fetchGitHubReleaseMetadata(
  url: string,
  init: RequestInit = {},
  options: Options = {},
): Promise<Response> {
  const key = createHash("sha256").update(url).digest("hex");
  const ttl = options.ttlMs ?? RELEASE_AUTOMATIC_TTL_MS;
  const reservation = withState(options, (state, now) => {
    const entry = state.entries[key] ?? {};
    const attempts = state.automaticAttempts.filter((at) => at > now - RELEASE_AUTOMATIC_TTL_MS);
    const budgetUntil = attempts.length >= RELEASE_AUTOMATIC_HOURLY_BUDGET
      ? Math.min(...attempts) + RELEASE_AUTOMATIC_TTL_MS : 0;
    const blockedUntil = Math.max(state.rateLimitUntil ?? 0, entry.pendingUntil ?? 0,
      options.manual ? 0 : Math.max(freshRootDelay(state, now), entry.nextAttempt ?? 0, budgetUntil));
    if (now < blockedUntil) {
      return { value: { entry, blockedUntil } };
    }
    state.entries[key] = { ...entry, lastAttempt: now, pendingUntil: now + REQUEST_LEASE_MS,
      nextAttempt: now + ttl };
    state.automaticAttempts = options.manual ? attempts : [...attempts, now];
    return { value: { entry, blockedUntil: 0 }, changed: true };
  });
  if (reservation.blockedUntil) {
    if (reservation.entry.body !== undefined && !options.manual) return cachedResponse(reservation.entry);
    throw new ReleaseCheckDeferredError(reservation.blockedUntil);
  }
  const headers = new Headers(init.headers);
  if (reservation.entry.etag) headers.set("If-None-Match", reservation.entry.etag);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      ...init, headers,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    const body = response.status === 304 ? reservation.entry.body
      : response.ok ? await response.text() : undefined;
    const success = (response.ok || response.status === 304) && body !== undefined;
    // Validate before persisting: a proxy's HTML error page is not a release list.
    if (success) JSON.parse(body);
    withState(options, (state, now) => {
      const entry = state.entries[key];
      entry.pendingUntil = undefined;
      if (success) {
        entry.body = body;
        entry.etag = response.headers.get("etag") ?? entry.etag;
        entry.lastSuccess = now;
        entry.failures = 0;
        entry.nextAttempt = now + ttl;
      } else {
        recordFailure(entry, now);
        if (response.status === 403 || response.status === 429) {
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
          const retry = response.headers.get("retry-after");
          const retryAt = retry && /^\d+$/.test(retry) ? now + Number(retry) * 1_000 : Date.parse(retry ?? "");
          state.rateLimitUntil = Math.max(state.rateLimitUntil ?? 0,
            Number.isFinite(reset) && reset > now ? reset : now + RELEASE_FIRST_CHECK_DELAY_MS,
            Number.isFinite(retryAt) ? retryAt : 0);
        }
      }
      return { value: undefined, changed: true };
    });
    if (success) return cachedResponse({ body, etag: response.headers.get("etag") ?? reservation.entry.etag });
    return response;
  } catch (error) {
    withState(options, (state, now) => {
      const entry = state.entries[key];
      entry.pendingUntil = undefined;
      recordFailure(entry, now);
      return { value: undefined, changed: true };
    });
    throw error;
  }
}

function recordFailure(entry: Entry, now: number): void {
  entry.failures = Math.min((entry.failures ?? 0) + 1, 5);
  entry.nextAttempt = now + Math.min(RELEASE_AUTOMATIC_TTL_MS, 5 * 60_000 * 2 ** (entry.failures - 1));
}
