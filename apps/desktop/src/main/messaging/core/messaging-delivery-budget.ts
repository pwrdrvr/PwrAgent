import type {
  MessagingDeliveryScope,
  MessagingRateLimitInfo,
} from "@pwragent/messaging-interface";
import { coalesceBackoffMs } from "./messaging-coalesce-backoff.js";

export type MessagingDeliveryPriority =
  | "critical_interactive"
  | "final_turn"
  | "user_command"
  | "routine_status"
  | "tool_progress"
  | "stream_partial";

export type MessagingDeliveryAdmission =
  | {
      outcome: "admitted";
      slowMode: boolean;
    }
  | {
      outcome: "deferred";
      reason: "cool-off" | "budget-exhausted";
      retryAt: number;
      slowMode: boolean;
    }
  | {
      outcome: "dropped";
      reason:
        | "cool-off"
        | "slow-mode"
        | "budget-exhausted"
        | "missing-scope";
      slowMode: boolean;
    };

type ScopeState = {
  coolOffUntil?: number;
  slowModeUntil?: number;
  // Slow-mode coalescing gate for droppable (routine/tool/stream-partial)
  // traffic. Rather than dropping every such update while a scope is throttled,
  // one is released per exponential-backoff window and the rest are coalesced
  // away. `slowModeReleaseAt` is the next time a droppable update may be
  // released; `slowModeReleaseCount` drives the backoff. Both reset when slow
  // mode ends. See {@link coalesceBackoffMs}.
  slowModeReleaseAt?: number;
  slowModeReleaseCount: number;
  timestamps: number[];
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_LIMIT = 60;
const DEFAULT_RESERVED = 1;
const RATE_LIMIT_SAFETY_BUFFER_MS = 2_000;
const SLOW_MODE_RECOVERY_MS = 5 * 60_000;
const SLOW_MODE_MINIMUM_MS = 5_000;

const SLOW_MODE_DROP_PRIORITIES = new Set<MessagingDeliveryPriority>([
  "routine_status",
  "tool_progress",
  "stream_partial",
]);

const DEFERABLE_PRIORITIES = new Set<MessagingDeliveryPriority>([
  "critical_interactive",
  "final_turn",
  "user_command",
]);

export class MessagingDeliveryBudget {
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
  }

  admit(request: {
    consumeCapacity?: boolean;
    priority: MessagingDeliveryPriority;
    scope?: MessagingDeliveryScope;
  }): MessagingDeliveryAdmission {
    if (!request.scope) {
      return { outcome: "admitted", slowMode: false };
    }

    const now = this.now();
    const state = this.stateFor(request.scope);
    this.pruneState(state, request.scope, now);
    let slowMode = this.isScopeInSlowMode(request.scope);

    if (state.coolOffUntil !== undefined && state.coolOffUntil > now) {
      if (DEFERABLE_PRIORITIES.has(request.priority)) {
        return {
          outcome: "deferred",
          reason: "cool-off",
          retryAt: state.coolOffUntil,
          slowMode,
        };
      }
      return { outcome: "dropped", reason: "cool-off", slowMode };
    }

    if (slowMode && SLOW_MODE_DROP_PRIORITIES.has(request.priority)) {
      // Coalesce droppable traffic instead of dropping it outright: release one
      // update per exponential-backoff window (~400ms → 1s → 2s → ... → 16s)
      // and buffer/drop the rest. This keeps periodic progress flowing during
      // slow mode without re-tripping the provider rate limit. Non-capacity
      // probes (consumeCapacity === false) only observe — they neither open the
      // coalescing window nor consume a release.
      if (request.consumeCapacity !== false) {
        if (state.slowModeReleaseAt !== undefined && state.slowModeReleaseAt <= now) {
          state.slowModeReleaseCount += 1;
          state.slowModeReleaseAt = now + coalesceBackoffMs(state.slowModeReleaseCount);
          state.timestamps.push(now);
          return { outcome: "admitted", slowMode };
        }
        if (state.slowModeReleaseAt === undefined) {
          // First droppable update since slow mode armed: open the coalescing
          // window. It is buffered (dropped) until the initial window elapses.
          state.slowModeReleaseAt = now + coalesceBackoffMs(0);
        }
      }
      return { outcome: "dropped", reason: "slow-mode", slowMode };
    }

    if (request.consumeCapacity === false) {
      return { outcome: "admitted", slowMode };
    }

    if (!this.hasCapacity(request.scope, state, request.priority)) {
      // Local budget (not a provider 429): capacity frees at the next sliding
      // window, so a deferrable message should retry then rather than waiting
      // the full slow-mode floor. Slow mode itself still arms at the floor so
      // low-priority chatter stays suppressed for at least SLOW_MODE_MINIMUM_MS.
      const nextWindow = nextWindowAt(request.scope, state, now);
      const slowModeUntil = Math.max(nextWindow, now + SLOW_MODE_MINIMUM_MS);
      state.slowModeUntil = Math.max(state.slowModeUntil ?? 0, slowModeUntil);
      slowMode = true;
      if (DEFERABLE_PRIORITIES.has(request.priority)) {
        return {
          outcome: "deferred",
          reason: "budget-exhausted",
          retryAt: nextWindow,
          slowMode,
        };
      }
      return { outcome: "dropped", reason: "budget-exhausted", slowMode };
    }

    state.timestamps.push(now);
    return { outcome: "admitted", slowMode };
  }

  recordRateLimit(info: MessagingRateLimitInfo): void {
    const now = info.observedAt ?? this.now();
    const retryAfterMs = Math.max(0, Math.floor(info.retryAfterMs ?? 0));
    const state = this.stateFor(info.scope);
    const coolOffUntil = now + retryAfterMs + RATE_LIMIT_SAFETY_BUFFER_MS;
    state.coolOffUntil = Math.max(state.coolOffUntil ?? 0, coolOffUntil);
    state.slowModeUntil = Math.max(
      state.slowModeUntil ?? 0,
      state.coolOffUntil + SLOW_MODE_RECOVERY_MS,
    );
  }

  isScopeInSlowMode(scope: MessagingDeliveryScope | undefined): boolean {
    if (!scope) {
      return false;
    }
    const state = this.scopes.get(scope.id);
    if (!state) {
      return false;
    }
    this.pruneState(state, scope, this.now());
    return state.slowModeUntil !== undefined && state.slowModeUntil > this.now();
  }

  private stateFor(scope: MessagingDeliveryScope): ScopeState {
    let state = this.scopes.get(scope.id);
    if (!state) {
      state = { slowModeReleaseCount: 0, timestamps: [] };
      this.scopes.set(scope.id, state);
    }
    return state;
  }

  private pruneState(
    state: ScopeState,
    scope: MessagingDeliveryScope,
    now: number,
  ): void {
    const intervalMs = budgetIntervalMs(scope);
    const cutoff = now - intervalMs;
    state.timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff);
    if (state.coolOffUntil !== undefined && state.coolOffUntil <= now) {
      state.coolOffUntil = undefined;
    }
    if (state.slowModeUntil !== undefined && state.slowModeUntil <= now) {
      state.slowModeUntil = undefined;
      // Slow mode ended: reset the coalescing gate so the next episode starts
      // fresh at the initial window rather than at a stale backoff step.
      state.slowModeReleaseAt = undefined;
      state.slowModeReleaseCount = 0;
    }
  }

  private hasCapacity(
    scope: MessagingDeliveryScope,
    state: ScopeState,
    priority: MessagingDeliveryPriority,
  ): boolean {
    const limit = budgetLimit(scope);
    if (state.timestamps.length >= limit) {
      return false;
    }
    if (DEFERABLE_PRIORITIES.has(priority)) {
      return true;
    }
    return state.timestamps.length < Math.max(0, limit - budgetReserved(scope));
  }
}

function nextWindowAt(
  scope: MessagingDeliveryScope,
  state: ScopeState,
  now: number,
): number {
  const oldest = state.timestamps[0];
  return oldest === undefined ? now : oldest + budgetIntervalMs(scope);
}

function budgetLimit(scope: MessagingDeliveryScope): number {
  return Math.max(1, Math.floor(scope.budget?.limit ?? DEFAULT_LIMIT));
}

function budgetIntervalMs(scope: MessagingDeliveryScope): number {
  return Math.max(1, Math.floor(scope.budget?.intervalMs ?? DEFAULT_INTERVAL_MS));
}

function budgetReserved(scope: MessagingDeliveryScope): number {
  return Math.max(0, Math.floor(scope.budget?.reserved ?? DEFAULT_RESERVED));
}
