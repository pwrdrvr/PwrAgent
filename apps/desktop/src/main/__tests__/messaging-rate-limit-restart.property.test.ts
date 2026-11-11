import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import type { DesktopMessagingConfig } from "../messaging/messaging-config";
import type {
  DesktopMessagingAdapter,
  DesktopMessagingRuntime,
} from "../messaging/messaging-runtime";

// Rule: once a provider has answered with a Retry-After, nothing is sent to
// that provider before the Retry-After expires, however many adapter
// restarts happen in between. A restart here is what the app really does:
// a config change that replaces every adapter (`inputDebounceMs`), or a
// messaging stop and start. Two layers each carry a block:
// - the controller's delivery budget, fed by `onRateLimit`;
// - the provider's own throttle (Slack's gate, Telegram's stream limits),
//   which the fake adapter models with a `MessagingRateLimitGate`.
// A send is a `deliver` call the provider throttle let through. The oracle:
// - a budget block holds for every send, from any adapter;
// - a provider block holds for sends through the adapter that recorded it
//   and every adapter that replaced it.
// Not covered: a send that was already waiting on the budget when the
// adapter restarted wakes on the disposed controller and goes out through
// the stopped adapter, which never sees a 429 its replacement records later.
// That is a question of where in-flight deliveries go after a restart, not
// of carrying state, and is tracked separately.

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
  | { kind: "stop-start" };

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
  listener?: (event: MessagingInboundEvent) => Promise<void>;
  rateLimitListener?: (info: MessagingRateLimitInfo) => void;
};

type Oracle = {
  budgetBlockedUntil: number;
  providerBlocks: Array<{ generation: number; until: number }>;
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
    resolveDeliveryScope: () => SCOPE,
    deliver: async (intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> => {
      const now = Date.now();
      if (!gate.admit(PROVIDER_BUCKET).admitted) {
        return { channel: "telegram", deliveredAt: now, outcome: "discarded" };
      }
      oracle.sends += 1;
      const blockedUntil = Math.max(
        oracle.budgetBlockedUntil,
        ...oracle.providerBlocks
          .filter((block) => block.generation <= generation)
          .map((block) => block.until),
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
      adapter.listener = undefined;
    },
  };
  return adapter;
}

function createBackendBridge(): MessagingBackendBridge {
  return {
    getNavigationSnapshot: vi.fn(async () => {
      throw new Error("not used");
    }),
    onEvent: () => () => {},
  } as unknown as MessagingBackendBridge;
}

function telegramConfig(inputDebounceMs: number): DesktopMessagingConfig {
  return {
    inputDebounceMs,
    telegram: {
      channel: "telegram",
      botToken: "telegram-token",
      authorizedActorIds: [{ id: "user-1", displayName: "" }],
    },
  } as DesktopMessagingConfig;
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

const tempDirs: string[] = [];

async function prepareRuntimeStore(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-rate-limit-restart-"));
  tempDirs.push(tempDir);
  vi.stubEnv("PWRAGENT_HOME", tempDir);
  const { initializeAppState, resetAppStateForTests } = await import(
    "../state/app-state"
  );
  resetAppStateForTests();
  initializeAppState();
  const { resetDesktopMessagingStoreForTests } = await import(
    "../messaging/desktop-messaging-store"
  );
  resetDesktopMessagingStoreForTests();
}

beforeEach(async () => {
  const { initializeDesktopFederationRuntime } = await import(
    "../federation/federation-runtime"
  );
  initializeDesktopFederationRuntime();
  await prepareRuntimeStore();
});

afterEach(async () => {
  vi.useRealTimers();
  const { resetAppStateForTests } = await import("../state/app-state");
  resetAppStateForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

async function runScenario(ops: readonly Op[]): Promise<Oracle> {
  const oracle: Oracle = {
    budgetBlockedUntil: 0,
    providerBlocks: [],
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
          // here; later `advance` ops release it.
          pending.push(listener(helpCommand()).catch(() => {}));
          await vi.advanceTimersByTimeAsync(0);
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
          oracle.providerBlocks.push({
            generation: adapter.generation,
            until: Date.now() + op.retryAfterMs,
          });
        }
      } else if (op.kind === "restart-adapters") {
        debounce = debounce === 0 ? 250 : 0;
        await runtime.applyConfig(telegramConfig(debounce));
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
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
