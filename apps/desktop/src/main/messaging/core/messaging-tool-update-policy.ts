import type { MessagingToolUpdateMode } from "@pwragnt/shared";
import type { MessagingToolActivity } from "./messaging-tool-activity.js";

export type MessagingToolUpdatePolicyDelivery = {
  activities: MessagingToolActivity[];
  bindingId: string;
  kind: "individual" | "batch";
  mode: MessagingToolUpdateMode;
  turnId: string;
};

type PolicyState = {
  bindingId: string;
  individualCount: number;
  mode: MessagingToolUpdateMode;
  noisy: boolean;
  pending: MessagingToolActivity[];
  seenActivityIds: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  turnId: string;
  windowStartedAt: number;
};

type ModePolicy = {
  individualThreshold: number;
  startsNoisy: boolean;
  windowMs?: number;
};

const MODE_POLICIES: Record<MessagingToolUpdateMode, ModePolicy> = {
  show_all: {
    individualThreshold: Number.POSITIVE_INFINITY,
    startsNoisy: false,
  },
  show_more: {
    individualThreshold: 5,
    startsNoisy: false,
    windowMs: 15_000,
  },
  show_some: {
    individualThreshold: 3,
    startsNoisy: false,
    windowMs: 30_000,
  },
  show_less: {
    individualThreshold: 0,
    startsNoisy: true,
    windowMs: 60_000,
  },
  show_none: {
    individualThreshold: 0,
    startsNoisy: false,
  },
};

export class MessagingToolUpdatePolicy {
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly now: () => number;
  private readonly onBatchReady?: (
    delivery: MessagingToolUpdatePolicyDelivery,
  ) => void | Promise<void>;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly states = new Map<string, PolicyState>();

  constructor(options?: {
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    now?: () => number;
    onBatchReady?: (delivery: MessagingToolUpdatePolicyDelivery) => void | Promise<void>;
    setTimer?: (
      callback: () => void,
      delayMs: number,
    ) => ReturnType<typeof setTimeout>;
  }) {
    this.clearTimer = options?.clearTimer ?? clearTimeout;
    this.now = options?.now ?? Date.now;
    this.onBatchReady = options?.onBatchReady;
    this.setTimer = options?.setTimer ?? setTimeout;
  }

  processActivity(params: {
    activity: MessagingToolActivity;
    bindingId: string;
    mode: MessagingToolUpdateMode;
    turnId: string;
  }): MessagingToolUpdatePolicyDelivery[] {
    if (params.mode === "show_none") {
      return [];
    }

    if (params.mode === "show_all") {
      const state = this.stateFor(params);
      if (state.seenActivityIds.has(params.activity.id)) {
        return [];
      }
      state.seenActivityIds.add(params.activity.id);
      return [
        {
          activities: [params.activity],
          bindingId: params.bindingId,
          kind: "individual",
          mode: params.mode,
          turnId: params.turnId,
        },
      ];
    }

    const state = this.stateFor(params);
    if (state.seenActivityIds.has(params.activity.id)) {
      return [];
    }
    state.seenActivityIds.add(params.activity.id);

    const policy = MODE_POLICIES[params.mode];
    this.resetQuietWindowIfElapsed(state, policy);

    if (!state.noisy && state.individualCount < policy.individualThreshold) {
      state.individualCount += 1;
      return [
        {
          activities: [params.activity],
          bindingId: params.bindingId,
          kind: "individual",
          mode: params.mode,
          turnId: params.turnId,
        },
      ];
    }

    state.noisy = true;
    state.pending.push(params.activity);
    this.scheduleFlush(state, policy);
    return [];
  }

  flush(params?: {
    bindingId?: string;
    clear?: boolean;
    turnId?: string;
  }): MessagingToolUpdatePolicyDelivery[] {
    const deliveries: MessagingToolUpdatePolicyDelivery[] = [];
    for (const [key, state] of [...this.states.entries()]) {
      if (params?.bindingId && state.bindingId !== params.bindingId) {
        continue;
      }
      if (params?.turnId && state.turnId !== params.turnId) {
        continue;
      }
      const delivery = this.flushState(key, state, {
        clear: params?.clear ?? true,
      });
      if (delivery) {
        deliveries.push(delivery);
      }
    }
    return deliveries;
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        this.clearTimer(state.timer);
      }
    }
    this.states.clear();
  }

  private stateFor(params: {
    bindingId: string;
    mode: MessagingToolUpdateMode;
    turnId: string;
  }): PolicyState {
    const key = this.keyFor(params);
    let state = this.states.get(key);
    if (!state) {
      state = {
        bindingId: params.bindingId,
        individualCount: 0,
        mode: params.mode,
        noisy: MODE_POLICIES[params.mode].startsNoisy,
        pending: [],
        seenActivityIds: new Set(),
        turnId: params.turnId,
        windowStartedAt: this.now(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  private resetQuietWindowIfElapsed(
    state: PolicyState,
    policy: ModePolicy,
  ): void {
    if (state.noisy || !policy.windowMs) {
      return;
    }
    if (this.now() - state.windowStartedAt < policy.windowMs) {
      return;
    }
    state.individualCount = 0;
    state.windowStartedAt = this.now();
  }

  private scheduleFlush(state: PolicyState, policy: ModePolicy): void {
    if (!policy.windowMs || state.timer) {
      return;
    }

    const elapsedMs = Math.max(0, this.now() - state.windowStartedAt);
    const delayMs = Math.max(0, policy.windowMs - elapsedMs);
    const key = this.keyFor(state);
    state.timer = this.setTimer(() => {
      const current = this.states.get(key);
      if (!current) {
        return;
      }
      const delivery = this.flushState(key, current, { clear: false });
      if (delivery) {
        void this.onBatchReady?.(delivery);
      }
    }, delayMs);
  }

  private flushState(
    key: string,
    state: PolicyState,
    options: { clear: boolean },
  ): MessagingToolUpdatePolicyDelivery | undefined {
    if (state.timer) {
      this.clearTimer(state.timer);
      state.timer = undefined;
    }

    const activities = state.pending.splice(0);
    if (options.clear) {
      this.states.delete(key);
    } else {
      state.windowStartedAt = this.now();
    }

    if (activities.length === 0) {
      return undefined;
    }

    return {
      activities,
      bindingId: state.bindingId,
      kind: "batch",
      mode: state.mode,
      turnId: state.turnId,
    };
  }

  private keyFor(params: {
    bindingId: string;
    mode: MessagingToolUpdateMode;
    turnId: string;
  }): string {
    return `${params.bindingId}\0${params.turnId}\0${params.mode}`;
  }
}
