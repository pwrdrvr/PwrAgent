import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingDeliveryResult,
  MessagingInboundEvent,
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

// Rule: at most one adapter per platform may be connected to the provider at
// a time. Many providers allow one connection per bot (Telegram polling,
// Slack Socket Mode, a Discord gateway), and a second one makes them drop
// each other in a loop.
//
// The runtime gives up on a start after a deadline, but the start keeps
// running. The fake adapter here is the worst case: it ignores a `stop()`
// that arrives while its start is pending, so it may be connected from the
// moment `start()` is called until a `stop()` that comes after its start has
// settled. A start that never settles stays possibly connected for good.
//
// The oracle: whenever the runtime calls `start()` on an adapter, no other
// adapter for the platform may still be possibly connected.

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

const START_DEADLINE_MS = 1_000;
// Captured before any test fakes timers: a case that hangs fails on this
// real-time limit with its input, instead of timing out the whole property.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const CASE_LIMIT_MS = 10_000;

async function withinRealTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(
          () => reject(new Error(`case did not finish within ${CASE_LIMIT_MS} ms`)),
          CASE_LIMIT_MS,
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}
// A start that never settles.
const NEVER = -1;

type Op =
  | { kind: "advance"; ms: number }
  | { kind: "restart-adapters" }
  | { kind: "stop-start" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 3_000 }).map((ms) => ({ kind: "advance" as const, ms })) },
  { weight: 2, arbitrary: fc.constant({ kind: "restart-adapters" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "stop-start" as const }) },
);

// How long each new adapter's start takes, in creation order. Past the end
// of the list, starts are instant.
const startDurationArb = fc.constantFrom(0, 300, 1_500, 4_000, NEVER);

type FakeAdapter = DesktopMessagingAdapter & {
  generation: number;
  startCalled: boolean;
  startSettled: boolean;
  stoppedAfterStart: boolean;
};

type Oracle = {
  adapters: FakeAdapter[];
  starts: number;
  violations: string[];
};

function possiblyConnected(adapter: FakeAdapter): boolean {
  return adapter.startCalled && !adapter.stoppedAfterStart;
}

function createFakeAdapter(
  oracle: Oracle,
  generation: number,
  startMs: number,
): FakeAdapter {
  const adapter: FakeAdapter = {
    authorizedActorIds: ["user-1"],
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    channel: "telegram",
    generation,
    startCalled: false,
    startSettled: false,
    stoppedAfterStart: false,
    deliver: async (): Promise<MessagingDeliveryResult> => ({
      channel: "telegram",
      deliveredAt: Date.now(),
      outcome: "presented",
      surface: { channel: "telegram", id: "telegram:surface" },
    }),
    start: async (_listener: (event: MessagingInboundEvent) => Promise<void>) => {
      const others = oracle.adapters.filter(
        (other) => other !== adapter && possiblyConnected(other),
      );
      if (others.length > 0) {
        oracle.violations.push(
          `adapter ${generation} started while ${others.map((other) => other.generation).join(", ")} may still be connected`,
        );
      }
      adapter.startCalled = true;
      oracle.starts += 1;
      if (startMs === NEVER) {
        await new Promise<never>(() => {});
      }
      if (startMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, startMs));
      }
      adapter.startSettled = true;
    },
    stop: async () => {
      if (adapter.startSettled) {
        adapter.stoppedAfterStart = true;
      }
    },
  };
  return adapter;
}

beforeEach(async () => {
  await initializeFederationForMessagingTests();
  await prepareMessagingRuntimeStore("pwragent-single-connection-");
});

afterEach(cleanupMessagingRuntimeStores);

async function runScenario(
  startDurations: readonly number[],
  ops: readonly Op[],
): Promise<{ oracle: Oracle; runtime: DesktopMessagingRuntime }> {
  const oracle: Oracle = { adapters: [], starts: 0, violations: [] };
  let debounce = 0;
  const { DesktopMessagingRuntime: Runtime } = await import(
    "../messaging/messaging-runtime"
  );
  const runtime: DesktopMessagingRuntime = new Runtime({
    adapterFactory: () => {
      const generation = oracle.adapters.length;
      const adapter = createFakeAdapter(
        oracle,
        generation,
        startDurations[generation] ?? 0,
      );
      oracle.adapters.push(adapter);
      return [adapter];
    },
    adapterStartTimeoutMs: START_DEADLINE_MS,
    backendBridge: createBackendBridge(),
    config: telegramConfig(debounce),
  });
  // A start waits on its deadline, which passes only as the fake clock
  // moves, so lifecycle operations are fired and left running; the runtime
  // queues them, and the `advance` ops move time.
  const pending: Promise<unknown>[] = [runtime.start()];
  await vi.advanceTimersByTimeAsync(0);
  for (const op of ops) {
    if (op.kind === "advance") {
      await vi.advanceTimersByTimeAsync(op.ms);
    } else if (op.kind === "restart-adapters") {
      debounce = debounce === 0 ? 250 : 0;
      pending.push(runtime.applyConfig(telegramConfig(debounce)));
      await vi.advanceTimersByTimeAsync(0);
    } else {
      pending.push(runtime.stop().then(async () => runtime.start()));
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  // Let every queued operation settle (each restart blocked by a start that
  // never settles waits a few seconds), then give slow starts and any start
  // the runtime put off time to run.
  let settled = false;
  void Promise.allSettled(pending).then(() => {
    settled = true;
  });
  for (let step = 0; step < 400 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(500);
  }
  for (let step = 0; step < 20; step += 1) {
    await vi.advanceTimersByTimeAsync(500);
  }
  await Promise.allSettled(pending);
  return { oracle, runtime };
}

async function stopRuntime(runtime: DesktopMessagingRuntime | undefined): Promise<void> {
  if (!runtime) return;
  const stopped = runtime.stop().catch(() => {});
  for (let step = 0; step < 20; step += 1) {
    await vi.advanceTimersByTimeAsync(500);
  }
  await stopped;
}

describe("one provider connection per platform", () => {
  it("connects again after a start that ran past its deadline has been stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // The first start takes 1.5 s against a 1 s deadline; the restart comes
    // while it is still connecting.
    const { oracle, runtime } = await runScenario([1_500], [
      { kind: "advance", ms: 1_100 },
      { kind: "restart-adapters" },
    ]);
    try {
      expect(oracle.violations).toEqual([]);
      expect(oracle.adapters[0]?.stoppedAfterStart).toBe(true);
      expect(oracle.adapters.at(-1)?.startCalled).toBe(true);
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({ platform: "telegram", health: "enabled" }),
      ]);
    } finally {
      await stopRuntime(runtime);
    }
  }, 30_000);

  it("stays disconnected, and says why, while a start that never settles may hold the connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { oracle, runtime } = await runScenario([NEVER], [
      { kind: "advance", ms: 1_100 },
      { kind: "restart-adapters" },
      { kind: "stop-start" },
    ]);
    try {
      expect(oracle.violations).toEqual([]);
      expect(oracle.starts).toBe(1);
      expect(runtime.getPlatformStatuses()).toEqual([
        expect.objectContaining({
          platform: "telegram",
          health: "errored",
          reason: expect.stringContaining("previous connection"),
        }),
      ]);
    } finally {
      await stopRuntime(runtime);
    }
  }, 30_000);

  it("never starts an adapter while another for the platform may still be connected", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(startDurationArb, { maxLength: 8 }),
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        async (startDurations, ops) => {
          vi.useFakeTimers();
          vi.setSystemTime(1_000_000);
          let runtime: DesktopMessagingRuntime | undefined;
          try {
            const result = await withinRealTime(runScenario(startDurations, ops));
            runtime = result.runtime;
            expect(result.oracle.violations).toEqual([]);
          } finally {
            await withinRealTime(stopRuntime(runtime));
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 300_000);
});
