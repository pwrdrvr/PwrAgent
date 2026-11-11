import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessagingRateLimitGate,
  type MessagingDeliveryResult,
  type MessagingDeliveryScope,
  type MessagingInboundEvent,
  type MessagingRateLimitBucket,
  type MessagingRateLimitInfo,
  type MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type {
  DesktopMessagingAdapter,
  DesktopMessagingRuntime,
} from "../messaging/messaging-runtime";
import {
  cleanupMessagingRuntimeStores,
  createBackendBridge,
  initializeFederationForMessagingTests,
  prepareMessagingRuntimeStore,
  telegramConfig,
} from "./helpers/messaging-runtime-harness";

// Rule: once a provider has answered with a Retry-After, nothing is sent to
// that provider before the Retry-After expires, however many adapter
// restarts happen in between. A restart here is what the app really does:
// a config change that replaces every adapter (`inputDebounceMs`), or a
// messaging stop and start. Two layers each carry a block:
// - the controller's delivery budget, fed by `onRateLimit`;
// - the provider's own throttle (Slack's gate, Telegram's stream limits),
//   which the fake adapter models with a `MessagingRateLimitGate`.
// A send is a `deliver` call the provider throttle let through. The oracle:
// - a budget block or a provider block holds for every send, from any
//   adapter, whichever adapter recorded it;
// - only the running adapter sends: a stopped adapter is never called, so a
//   reply still waiting out a cool-off when its adapter restarts is handed
//   to the replacement;
// - replies reach the provider in the order they were requested;
// - nothing is lost: every requested reply is either sent or refused by the
//   provider throttle.

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock("../state/migration", () => ({
  migrateIfNeeded: () => ({ status: "already-migrated" }),
}));

vi.mock("../profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../profile")>();
  return {
    ...actual,
    resolveActiveProfilePath: (
      relativePath: Parameters<typeof actual.resolveActiveProfilePath>[0],
      options?: Parameters<typeof actual.resolveActiveProfilePath>[1],
    ) =>
      relativePath === "state/state.db"
        ? ":memory:"
        : actual.resolveActiveProfilePath(relativePath, options),
  };
});

const SCOPE: MessagingDeliveryScope = {
  platform: "telegram",
  id: "telegram:dm:chat-1",
  kind: "dm",
  label: "Telegram DM",
  budget: { limit: 1_000, intervalMs: 60_000, reserved: 0 },
};

const PROVIDER_BUCKET: MessagingRateLimitBucket = {
  id: "telegram:stream:chat-1",
  intervalMs: 60_000,
  limit: 1_000,
};

type Op =
  | { kind: "advance"; ms: number }
  | { kind: "send" }
  | { kind: "controller-429"; retryAfterMs: number }
  | { kind: "provider-429"; retryAfterMs: number }
  | { kind: "restart-adapters" }
  | { kind: "stop-start" }
  // Example tests only: messaging is turned off and stays off.
  | { kind: "stop" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 6_000 }).map((ms) => ({ kind: "advance" as const, ms })) },
  { weight: 4, arbitrary: fc.constant({ kind: "send" as const }) },
  { weight: 2, arbitrary: fc.integer({ min: 1_000, max: 20_000 }).map((retryAfterMs) => ({ kind: "controller-429" as const, retryAfterMs })) },
  { weight: 2, arbitrary: fc.integer({ min: 1_000, max: 20_000 }).map((retryAfterMs) => ({ kind: "provider-429" as const, retryAfterMs })) },
  { weight: 2, arbitrary: fc.constant({ kind: "restart-adapters" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "stop-start" as const }) },
);

type FakeAdapter = DesktopMessagingAdapter & {
  gate: MessagingRateLimitGate;
  generation: number;
  stopped: boolean;
  listener?: (event: MessagingInboundEvent) => Promise<void>;
  rateLimitListener?: (info: MessagingRateLimitInfo) => void;
};

type Oracle = {
  budgetBlockedUntil: number;
  providerBlocks: number[];
  providerRefusals: number;
  requested: number;
  sentOrder: number[];
  sends: number;
  violations: string[];
};

function createFakeAdapter(oracle: Oracle, generation: number): FakeAdapter {
  const gate = new MessagingRateLimitGate(() => Date.now());
  const adapter: FakeAdapter = {
    authorizedActorIds: ["user-1"],
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    channel: "telegram",
    gate,
    generation,
    stopped: false,
    resolveDeliveryScope: () => SCOPE,
    deliver: async (intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> => {
      const now = Date.now();
      if (adapter.stopped) {
        oracle.violations.push(`stopped adapter ${generation} was asked to send ${intent.kind}`);
      }
      if (!gate.admit(PROVIDER_BUCKET).admitted) {
        oracle.providerRefusals += 1;
        return { channel: "telegram", deliveredAt: now, outcome: "discarded" };
      }
      oracle.sends += 1;
      oracle.sentOrder.push(intent.audit?.occurredAt ?? -1);
      const blockedUntil = Math.max(
        oracle.budgetBlockedUntil,
        ...oracle.providerBlocks,
      );
      if (now < blockedUntil) {
        oracle.violations.push(
          `${intent.kind} sent at ${now}, ${blockedUntil - now} ms before Retry-After expired`,
        );
      }
      return {
        channel: "telegram",
        deliveredAt: now,
        outcome: "presented",
        surface: { channel: "telegram", id: `telegram:${intent.id}` },
      };
    },
    exportRateLimitCarryover: () => ({ blocks: gate.activeBlocks() }),
    restoreRateLimitCarryover: (carryover) => gate.restoreBlocks(carryover.blocks),
    onRateLimit: (listener) => {
      adapter.rateLimitListener = listener;
      return () => {
        adapter.rateLimitListener = undefined;
      };
    },
    start: async (listener) => {
      adapter.listener = listener;
    },
    stop: async () => {
      adapter.stopped = true;
      adapter.listener = undefined;
    },
  };
  return adapter;
}

let commandSequence = 0;

function helpCommand(): MessagingInboundEvent {
  commandSequence += 1;
  return {
    id: `event-help-${commandSequence}`,
    kind: "command",
    actor: { platformUserId: "user-1" },
    channel: {
      channel: "telegram",
      conversation: { id: "chat-1", kind: "dm" },
    },
    command: "help",
    args: [],
    rawText: "/help",
    receivedAt: Date.now(),
  };
}

beforeEach(async () => {
  await initializeFederationForMessagingTests();
  await prepareMessagingRuntimeStore("pwragent-rate-limit-restart-");
});

afterEach(cleanupMessagingRuntimeStores);

async function runScenario(ops: readonly Op[]): Promise<Oracle> {
  const oracle: Oracle = {
    budgetBlockedUntil: 0,
    providerBlocks: [],
    providerRefusals: 0,
    requested: 0,
    sentOrder: [],
    sends: 0,
    violations: [],
  };
  const adapters: FakeAdapter[] = [];
  let debounce = 0;
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime: DesktopMessagingRuntime = new Runtime({
    adapterFactory: () => {
      const adapter = createFakeAdapter(oracle, adapters.length);
      adapters.push(adapter);
      return [adapter];
    },
    backendBridge: createBackendBridge(),
    config: telegramConfig(debounce),
  });
  const current = (): FakeAdapter | undefined => adapters.at(-1);
  const pending: Promise<unknown>[] = [];
  try {
    await runtime.start();
    for (const op of ops) {
      if (op.kind === "advance") {
        await vi.advanceTimersByTimeAsync(op.ms);
      } else if (op.kind === "send") {
        const listener = current()?.listener;
        if (listener) {
          // A deferred send waits on the budget's timer, so it is not awaited
          // here; later `advance` ops release it. The 1 ms step gives each
          // reply its own audit time, which is how the oracle orders them.
          oracle.requested += 1;
          pending.push(listener(helpCommand()).catch(() => {}));
          await vi.advanceTimersByTimeAsync(1);
        }
      } else if (op.kind === "controller-429") {
        const adapter = current();
        if (adapter?.rateLimitListener) {
          const now = Date.now();
          adapter.rateLimitListener({
            message: "Too Many Requests",
            observedAt: now,
            retryAfterMs: op.retryAfterMs,
            scope: SCOPE,
          });
          oracle.budgetBlockedUntil = Math.max(
            oracle.budgetBlockedUntil,
            now + op.retryAfterMs,
          );
        }
      } else if (op.kind === "provider-429") {
        const adapter = current();
        if (adapter?.listener) {
          adapter.gate.recordRateLimit(PROVIDER_BUCKET.id, op.retryAfterMs);
          oracle.providerBlocks.push(Date.now() + op.retryAfterMs);
        }
      } else if (op.kind === "restart-adapters") {
        debounce = debounce === 0 ? 250 : 0;
        await runtime.applyConfig(telegramConfig(debounce));
      } else if (op.kind === "stop") {
        await runtime.stop();
      } else {
        await runtime.stop();
        await runtime.start();
      }
    }
    // Release every deferred send, then let them finish.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(pending);
  } finally {
    await runtime.stop().catch(() => {});
    await vi.advanceTimersByTimeAsync(0).catch(() => {});
  }
  return oracle;
}

describe("messaging rate limits across adapter restarts", () => {
  it("restarts replace the adapter, and a send reaches the provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const oracle = await runScenario([
      { kind: "send" },
      { kind: "restart-adapters" },
      { kind: "send" },
      { kind: "stop-start" },
      { kind: "send" },
    ]);
    // Guards the property below against passing because nothing was sent.
    expect(oracle.sends).toBe(3);
    expect(oracle.requested).toBe(3);
    expect(oracle.violations).toEqual([]);
  }, 30_000);

  it("keeps replies in order when a second 429 extends the cool-off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // The first reply wakes when the first cool-off ends, finds the second
    // one still running, and must not lose its place to the second reply.
    const oracle = await runScenario([
      { kind: "controller-429", retryAfterMs: 1_000 },
      { kind: "send" },
      { kind: "controller-429", retryAfterMs: 1_000 },
      { kind: "send" },
    ]);
    expect(oracle.sends).toBe(2);
    expect(oracle.sentOrder).toEqual([1_000_000, 1_000_001]);
    expect(oracle.violations).toEqual([]);
  }, 30_000);

  it("discards a waiting reply when messaging stops with nothing to replace its adapter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const oracle = await runScenario([
      { kind: "controller-429", retryAfterMs: 1_000 },
      { kind: "send" },
      { kind: "stop" },
    ]);
    expect(oracle.requested).toBe(1);
    expect(oracle.sends).toBe(0);
    expect(oracle.violations).toEqual([]);
  }, 30_000);

  it("sends nothing before a recorded Retry-After expires, whatever restarts happen in between", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
          const oracle = await runScenario(ops);
          expect(oracle.violations).toEqual([]);
          expect(oracle.sentOrder).toEqual(
            [...oracle.sentOrder].sort((a, b) => a - b),
          );
          expect(oracle.sends + oracle.providerRefusals).toBe(oracle.requested);
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});
