import type {
  MessagingDeliveryScope,
  MessagingRateLimitInfo,
} from "@pwragent/messaging-interface";

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
      return { outcome: "dropped", reason: "slow-mode", slowMode };
    }

    if (!this.hasCapacity(request.scope, state, request.priority)) {
      const slowModeUntil = Math.max(
        nextWindowAt(request.scope, state, now),
        now + SLOW_MODE_MINIMUM_MS,
      );
      state.slowModeUntil = Math.max(state.slowModeUntil ?? 0, slowModeUntil);
      slowMode = true;
      if (DEFERABLE_PRIORITIES.has(request.priority)) {
        return {
          outcome: "deferred",
          reason: "budget-exhausted",
          retryAt: slowModeUntil,
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
      state = { timestamps: [] };
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
