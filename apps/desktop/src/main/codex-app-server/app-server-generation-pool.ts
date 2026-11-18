import {
  decideCodexInstallationChange,
  type CodexExecutableIdentity,
  type CodexInstallationChangeReason,
} from "@pwragent/owner-core/codex-app-server/app-server-installation";
import type { CodexAppServerClient } from "./desktop-client";
import { readCodexExecutableIdentity } from "./executable-identity";
import { CODEX_CLIENT_ROUTES } from "./provider-runtime-client";

/**
 * Codex app server generations: replace the process when the installation
 * under it changes, without stopping work that still runs on it.
 *
 * A package manager can replace Codex while PwrAgent runs (see
 * `app-server-installation.ts`). The old process keeps working, but helpers
 * it spawns from beside its deleted executable are gone, so Code Mode fails
 * closed until Codex restarts. Waiting for every thread to go idle at once
 * can take days on a busy machine, so instead:
 *
 * - A check compares the running process's executable with what its command
 *   names now: at most every `minCheckIntervalMs` before new work (a new
 *   thread, fork, turn, review or compaction), and every `checkIntervalMs`.
 * - On a change, a new generation starts and must finish its handshake.
 *   Only then does it become current; a failed start leaves the old one in
 *   service and is retried after a growing delay.
 * - New threads and every thread without work bound to its process go to the
 *   current generation. A thread stays on a replaced generation only while
 *   that process holds work for it (`isThreadPinned`): a running turn, an
 *   unanswered approval or input request, a helper turn, a voice session, an
 *   unstarted first turn whose history exists only there, a background
 *   terminal or live tool item, a live sub-agent, or a pool call in flight.
 *   Queued input and reserved starts are not bound to a process: they start
 *   on the current generation, which resumes the thread from its history.
 * - A replaced generation retires once nothing it owns is busy by the
 *   owner's broader measure (`isThreadBusy`), no pool call is in flight, and
 *   the client confirms under its lifecycle barrier that Codex reports no
 *   active thread (`retireAppServerWhenIdle`). A retired client never starts
 *   again.
 *
 * Each generation is an independent client with its own process, turn
 * state and RPC IDs. Events for a thread are delivered only from the
 * generation that owns it, so a thread that moved is never routed twice.
 * Threadless events come from the current generation, except account
 * updates, which any generation running a turn may report.
 */
export type CodexAppServerGenerationPoolOptions = {
  /** Owner work that must finish before a replaced generation stops. */
  isThreadBusy: (threadId: string) => boolean;
  /** Owner work that only the process that started it can finish. */
  isThreadPinned: (threadId: string) => boolean;
  /** Test seam: what the launched command names now. */
  readExecutable?: (launched: CodexExecutableIdentity) => Promise<CodexExecutableIdentity>;
  /** A new generation became current. */
  onGenerationPromoted?: (event: CodexAppServerGenerationPromotion) => void;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 0 disables the periodic check (tests); new work still checks. */
  checkIntervalMs?: number;
  minCheckIntervalMs?: number;
  retireRetryMs?: number;
  /** Settle time after a replaced generation's terminal event. */
  retireSettleMs?: number;
  failureBackoffMs?: { initial: number; max: number };
  now?: () => number;
};

export type CodexAppServerGenerationPromotion = {
  generation: number;
  reason: CodexInstallationChangeReason;
  previous?: CodexExecutableIdentity;
  current?: CodexExecutableIdentity;
};

export type CodexAppServerGenerationStatus = {
  current: number;
  draining: Array<{ generation: number; threads: number }>;
  lastRollover?: { at: number; generation: number; reason: CodexInstallationChangeReason };
  lastFailure?: { at: number; reason: CodexInstallationChangeReason; error: string; retryAt: number };
};

export type CodexAppServerGenerationControls = {
  /** Start a new generation when the running installation changed. Never throws. */
  checkAppServerInstallation(): Promise<void>;
  readAppServerGenerationStatus(): CodexAppServerGenerationStatus;
};

// `exited`: a replaced process died. Its client still delivers the turn
// failures it synthesizes for that process, but serves nothing again.
type GenerationState = "starting" | "current" | "draining" | "retiring" | "exited" | "retired";
type Generation = {
  id: number;
  client: CodexAppServerClient;
  state: GenerationState;
  inFlight: number;
  inFlightByThread: Map<string, number>;
  retireTimer?: NodeJS.Timeout;
  retireAt?: number;
};
type Method = keyof CodexAppServerClient;
type Callback = (...args: unknown[]) => unknown;
type Subscription = { method: Method; args: unknown[]; stops: Map<Generation, () => void> };

const NEW_WORK = new Set<Method>(["startThread", "forkThread", "startTurn", "startReview", "compactThread"]);
const CURRENT_ONLY_ALL = new Set<Method>(["restartAppServer", "maybeRecycleIdleAppServer"]);
const SYNC_ALL = new Set<Method>(["resetAppServerRestarts", "invalidateThreadListings"]);
const TERMINAL_EVENTS = new Set([
  "turn/completed", "turn/failed", "turn/cancelled", "thread/status/changed",
  "thread/closed", "item/completed", "serverRequest/resolved",
]);

export function createCodexAppServerGenerationPool(
  create: () => CodexAppServerClient,
  options: CodexAppServerGenerationPoolOptions,
): CodexAppServerClient & CodexAppServerGenerationControls {
  const now = options.now ?? (() => Date.now());
  const minCheckIntervalMs = options.minCheckIntervalMs ?? 5_000;
  const retireRetryMs = options.retireRetryMs ?? 30_000;
  const retireSettleMs = options.retireSettleMs ?? 1_000;
  const backoff = options.failureBackoffMs ?? { initial: 30_000, max: 10 * 60_000 };
  const readExecutable = options.readExecutable
    ?? ((launched: CodexExecutableIdentity) => readCodexExecutableIdentity(launched.command));
  const subscriptions = new Set<Subscription>();
  const owners = new Map<string, Generation>();
  const generations: Generation[] = [];
  let nextId = 1;
  // Bumped by close(): a rollover that started earlier must not promote.
  let epoch = 0;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let check: Promise<void> | undefined;
  let rollover: Promise<void> | undefined;
  let failures = 0;
  let retryAt = 0;
  let status: Omit<CodexAppServerGenerationStatus, "current" | "draining"> = {};

  const invoke = (client: CodexAppServerClient, method: Method, args: unknown[]): unknown =>
    (client[method] as Callback).apply(client, args);
  const live = (): Generation[] => generations.filter((generation) => generation.state !== "retired");
  // Clients a call may reach: an exited one would start its process again.
  const serving = (): Generation[] => live().filter((generation) => generation.state !== "exited");
  const threadIdOf = (value: unknown): string | undefined => {
    const fields = record(value);
    const id = fields?.threadId ?? record(fields?.thread)?.id;
    return typeof id === "string" ? id : undefined;
  };
  const ownedThreads = (generation: Generation): string[] =>
    [...owners].filter(([, owner]) => owner === generation).map(([threadId]) => threadId);

  const makeGeneration = (): Generation => {
    const generation: Generation = {
      id: nextId++,
      client: create(),
      state: "current",
      inFlight: 0,
      inFlightByThread: new Map(),
    };
    generations.push(generation);
    for (const subscription of subscriptions) subscribe(subscription, generation);
    return generation;
  };
  let current = makeGeneration();

  const pinned = (generation: Generation, threadId: string): boolean =>
    (generation.inFlightByThread.get(threadId) ?? 0) > 0
    || generation.client.threadDependsOnAppServer?.(threadId) === true
    || options.isThreadPinned(threadId);

  /** Which generation serves the thread now, moving it off a replaced one when free. */
  const route = (threadId: string | undefined): Generation => {
    if (!threadId) return current;
    const owner = owners.get(threadId);
    if (!owner || owner === current) return current;
    const reachable = owner.state !== "retired" && owner.state !== "exited";
    if (reachable && pinned(owner, threadId)) return owner;
    owners.set(threadId, current);
    if (reachable) {
      void owner.client.releaseThread?.(threadId).catch(() => false);
      scheduleRetirement(owner, retireSettleMs);
    }
    options.logger?.info("Codex thread moved to the current app server generation", {
      threadId,
      from: owner.id,
      to: current.id,
    });
    return current;
  };

  const accept = (generation: Generation, method: string, params: unknown): boolean => {
    if (generation.state === "retired") return false;
    const threadId = threadIdOf(params);
    if (!threadId) return generation === current || method.startsWith("account/");
    const owner = owners.get(threadId);
    if (!owner || owner.state === "retired") {
      owners.set(threadId, generation);
      return true;
    }
    return owner === generation;
  };

  const subscribe = (subscription: Subscription, generation: Generation): void => {
    const callback = subscription.args[0] as Callback;
    let args = subscription.args;
    if (subscription.method === "onNotification") {
      args = [(notification: unknown) => {
        const method = String(record(notification)?.method ?? "");
        const params = record(notification)?.params;
        if (generation !== current && TERMINAL_EVENTS.has(method)) scheduleRetirement(generation, retireSettleMs);
        if (!accept(generation, method, params)) return;
        return callback(notification);
      }];
    } else if (subscription.method === "onRequest") {
      args = [(value: unknown) => {
        if (generation.state === "retired") throw new Error("codex app server generation retired");
        const request = record(value);
        const params = record(request?.params);
        const threadId = threadIdOf(params);
        if (threadId && !owners.has(threadId)) owners.set(threadId, generation);
        if (!request || !params || generation.id === 1) return callback(value);
        const copy = { ...request, params: { ...params, requestId: `g${generation.id}:${String(params.requestId)}` } };
        const flushed = (request as { responseFlushed?: unknown }).responseFlushed;
        if (flushed) Object.defineProperty(copy, "responseFlushed", { value: flushed });
        return callback(copy);
      }];
    } else if (subscription.method === "onRealtimeEvent" || subscription.method === "onRealtimeDisconnect") {
      args = [(...values: unknown[]) => {
        const threadId = subscription.args[1];
        const owner = typeof threadId === "string" ? owners.get(threadId) ?? current : current;
        if (owner !== generation) return;
        return callback(...values);
      }, ...subscription.args.slice(1)];
    } else if (subscription.method === "onAppServerUnexpectedExit") {
      args = [() => {
        const affected = new Set(ownedThreads(generation));
        if (generation !== current && generation.state !== "retired" && generation.state !== "exited") {
          // A replaced process that died has nothing left to drain, and its
          // client must not start it again. It reports the turns that died
          // with it after this listener returns, so stop it a little later.
          generation.state = "exited";
          if (generation.retireTimer) clearTimeout(generation.retireTimer);
          generation.retireTimer = setTimeout(() => finalize(generation, "exited"), retireRetryMs);
          generation.retireTimer.unref?.();
        }
        return callback(affected);
      }];
    } else if (subscription.method === "onAppServerRestartStatusChanged") {
      args = [(...values: unknown[]) => generation === current ? callback(...values) : undefined];
    }
    const stop = invoke(generation.client, subscription.method, args);
    if (typeof stop === "function") subscription.stops.set(generation, stop as () => void);
  };

  const finalize = (generation: Generation, reason: "retired" | "exited" | "closed"): void => {
    if (generation.state === "retired") return;
    generation.state = "retired";
    if (generation.retireTimer) clearTimeout(generation.retireTimer);
    generation.retireTimer = undefined;
    generation.retireAt = undefined;
    for (const subscription of subscriptions) {
      subscription.stops.get(generation)?.();
      subscription.stops.delete(generation);
    }
    for (const threadId of ownedThreads(generation)) owners.delete(threadId);
    const index = generations.indexOf(generation);
    if (index >= 0) generations.splice(index, 1);
    // Releases what the client owns beside its process (provider bridges).
    void Promise.resolve(generation.client.close()).catch(() => undefined);
    options.logger?.info("Codex app server generation stopped", { generation: generation.id, reason });
  };

  /** The earliest requested attempt wins: a finished turn need not wait out a retry. */
  const scheduleRetirement = (generation: Generation, delayMs: number): void => {
    if (generation === current || generation.state !== "draining") return;
    const at = now() + delayMs;
    if (generation.retireTimer && generation.retireAt !== undefined && generation.retireAt <= at) return;
    if (generation.retireTimer) clearTimeout(generation.retireTimer);
    generation.retireAt = at;
    generation.retireTimer = setTimeout(() => {
      generation.retireTimer = undefined;
      generation.retireAt = undefined;
      void tryRetire(generation);
    }, delayMs);
    generation.retireTimer.unref?.();
  };

  const busyThread = (generation: Generation): string | undefined =>
    ownedThreads(generation).find((threadId) => pinned(generation, threadId) || options.isThreadBusy(threadId));

  const tryRetire = async (generation: Generation): Promise<void> => {
    if (generation === current || generation.state !== "draining") return;
    generation.state = "retiring";
    let retired = false;
    try {
      if (generation.inFlight > 0 || busyThread(generation)) return;
      const outcome = await generation.client.retireAppServerWhenIdle?.({
        // Threads that moved to another generation are not this one's work.
        isThreadBusy: (threadId) => {
          const owner = owners.get(threadId);
          return (owner === undefined || owner === generation)
            && (pinned(generation, threadId) || options.isThreadBusy(threadId));
        },
        blocker: () => generation.inFlight > 0 ? "pool-request" : busyThread(generation) ? "owner-work" : undefined,
      });
      retired = outcome?.kind === "retired";
    } catch (error) {
      options.logger?.warn("Codex app server generation retirement failed", {
        generation: generation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (retired) {
        finalize(generation, "retired");
      } else if (generation.state === "retiring") {
        generation.state = "draining";
        scheduleRetirement(generation, retireRetryMs);
      }
    }
  };

  const promote = (candidate: Generation, reason: CodexInstallationChangeReason, previous?: CodexExecutableIdentity): void => {
    const replaced = current;
    replaced.state = "draining";
    candidate.state = "current";
    current = candidate;
    failures = 0;
    retryAt = 0;
    status = { ...status, lastRollover: { at: now(), generation: candidate.id, reason } };
    const executable = candidate.client.readAppServerExecutable?.();
    options.logger?.info("Codex app server generation replaced", {
      reason,
      generation: candidate.id,
      replaced: replaced.id,
      draining: ownedThreads(replaced).length,
      ...(previous?.version ? { previousVersion: previous.version } : {}),
      ...(executable?.version ? { version: executable.version } : {}),
    });
    try {
      options.onGenerationPromoted?.({
        generation: candidate.id,
        reason,
        ...(previous ? { previous } : {}),
        ...(executable ? { current: executable } : {}),
      });
    } catch (error) {
      options.logger?.warn("Codex generation promotion listener failed", { error: String(error) });
    }
    void tryRetire(replaced);
  };

  const startRollover = (reason: CodexInstallationChangeReason, from: Generation, launched: CodexExecutableIdentity): Promise<void> => {
    rollover ??= (async () => {
      const startedEpoch = epoch;
      const candidate = makeGeneration();
      // Not current until it proves it can start; it owns nothing yet.
      candidate.state = "starting";
      try {
        await candidate.client.getInitializeResult();
        if (startedEpoch !== epoch || from !== current || (candidate.state as GenerationState) === "retired") {
          finalize(candidate, "closed");
          return;
        }
        promote(candidate, reason, launched);
      } catch (error) {
        finalize(candidate, "closed");
        if (startedEpoch !== epoch) return;
        failures += 1;
        const delayMs = Math.min(backoff.max, backoff.initial * 2 ** (failures - 1));
        retryAt = now() + delayMs;
        const message = error instanceof Error ? error.message : String(error);
        status = { ...status, lastFailure: { at: now(), reason, error: message, retryAt } };
        options.logger?.warn("Codex app server generation failed to start; the running one stays in service", {
          reason,
          error: message,
          retryInMs: delayMs,
        });
      }
    })().finally(() => {
      rollover = undefined;
    });
    return rollover;
  };

  const checkInstallation = async (): Promise<void> => {
    if (rollover) return await rollover;
    if (now() < retryAt) return;
    const generation = current;
    const launched = generation.client.readAppServerExecutable?.();
    // Nothing is running: the next launch starts whatever is installed.
    if (!launched) return;
    let reason: CodexInstallationChangeReason | undefined;
    try {
      reason = decideCodexInstallationChange(launched, await readExecutable(launched));
    } catch {
      return;
    }
    if (!reason || generation !== current) return;
    await startRollover(reason, generation, launched);
  };

  const checkAppServerInstallation = (): Promise<void> => {
    checkedAt = now();
    check ??= checkInstallation()
      .catch((error) => options.logger?.warn("Codex installation check failed", { error: String(error) }))
      .finally(() => {
        check = undefined;
      });
    return check;
  };

  const beforeNewWork = async (): Promise<void> => {
    if (rollover) return await rollover;
    if (check) return await check;
    if (now() - checkedAt < minCheckIntervalMs) return;
    await checkAppServerInstallation();
  };

  // Runs only while Codex does: a pool nobody uses, or whose runtime was
  // dropped, stops looking on its next tick.
  const intervalMs = options.checkIntervalMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const ensureTimer = (): void => {
    if (intervalMs <= 0 || timer) return;
    timer = setInterval(() => {
      if (!rollover && live().length === 1 && !current.client.readAppServerExecutable?.()) {
        clearInterval(timer);
        timer = undefined;
        return;
      }
      void checkAppServerInstallation();
    }, intervalMs);
    timer.unref?.();
  };

  const run = async (generation: Generation, threadId: string | undefined, method: Method, args: unknown[]): Promise<unknown> => {
    ensureTimer();
    generation.inFlight += 1;
    if (threadId) generation.inFlightByThread.set(threadId, (generation.inFlightByThread.get(threadId) ?? 0) + 1);
    try {
      const result = await invoke(generation.client, method, args);
      const created = method === "startThread" || method === "forkThread" ? threadIdOf(result) : undefined;
      if (created && generation.state !== "retired") owners.set(created, generation);
      if (threadId && generation.state !== "retired" && !owners.has(threadId)) owners.set(threadId, generation);
      return result;
    } finally {
      generation.inFlight -= 1;
      if (threadId) {
        const remaining = (generation.inFlightByThread.get(threadId) ?? 1) - 1;
        if (remaining > 0) generation.inFlightByThread.set(threadId, remaining);
        else generation.inFlightByThread.delete(threadId);
      }
      if (generation !== current) scheduleRetirement(generation, retireSettleMs);
    }
  };

  const dispatch = async (method: Method, threadId: string | undefined, args: unknown[]): Promise<unknown> => {
    if (NEW_WORK.has(method)) await beforeNewWork();
    const generation = route(threadId);
    return await run(generation, threadId, method, args);
  };

  const closeAll = async (args: unknown[]): Promise<void> => {
    epoch += 1;
    const replaced = live().filter((generation) => generation !== current);
    for (const generation of replaced) finalize(generation, "closed");
    for (const threadId of [...owners.keys()]) {
      if (owners.get(threadId) !== current) owners.delete(threadId);
    }
    // The current client reconnects on its next request, as it always has.
    await invoke(current.client, "close", args);
  };

  const controls: CodexAppServerGenerationControls = {
    checkAppServerInstallation,
    readAppServerGenerationStatus: () => ({
      current: current.id,
      draining: live().filter((generation) => generation !== current)
        .map((generation) => ({ generation: generation.id, threads: ownedThreads(generation).length })),
      ...status,
    }),
  };

  return new Proxy(current.client, {
    get(_target, property) {
      if (property === "checkAppServerInstallation" || property === "readAppServerGenerationStatus") {
        return controls[property];
      }
      const target = current.client;
      if (typeof property !== "string" || !Object.hasOwn(CODEX_CLIENT_ROUTES, property)
        || typeof Reflect.get(target, property, target) !== "function") {
        return Reflect.get(target, property, target);
      }
      const method = property as Method;
      const route = CODEX_CLIENT_ROUTES[method];
      if (route === "subscribe" || method === "onAppServerRestartStatusChanged") return (...args: unknown[]) => {
        const subscription: Subscription = { method, args, stops: new Map() };
        subscriptions.add(subscription);
        for (const generation of live()) subscribe(subscription, generation);
        return () => {
          subscriptions.delete(subscription);
          for (const stop of subscription.stops.values()) stop();
          subscription.stops.clear();
        };
      };
      if (method === "close") return (...args: unknown[]) => closeAll(args);
      if (route === "all") return (...args: unknown[]) => {
        if (CURRENT_ONLY_ALL.has(method)) return invoke(current.client, method, args);
        const results = serving().map((generation) => invoke(generation.client, method, args));
        if (SYNC_ALL.has(method)) return;
        return Promise.allSettled(results).then((settled) => {
          const values = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          const failed = settled.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          return Array.isArray(values[0]) ? values.flat() : values[0];
        });
      };
      if (method === "getSubscribedThreadCount") return () =>
        serving().reduce((total, generation) => total + generation.client.getSubscribedThreadCount(), 0);
      if (route === "provider" || route === "reportedProvider" || method === "threadDependsOnAppServer") {
        return (threadId: string) => {
          const owner = owners.get(threadId);
          return invoke((owner && owner.state !== "exited" ? owner : current).client, method, [threadId]);
        };
      }
      if (route === "thread" || route === "threadId") return (...args: unknown[]) => {
        const threadId = route === "threadId" ? args[0] : record(args[0])?.threadId;
        return dispatch(method, typeof threadId === "string" ? threadId : undefined, args);
      };
      if (route === "model" || NEW_WORK.has(method)) return (...args: unknown[]) => dispatch(method, undefined, args);
      return (...args: unknown[]) => invoke(current.client, method, args);
    },
  }) as CodexAppServerClient & CodexAppServerGenerationControls;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
