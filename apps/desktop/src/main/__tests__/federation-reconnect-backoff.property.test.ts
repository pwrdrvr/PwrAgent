// Model test of the federation client's reconnect backoff in the real
// `DesktopFederationRuntime` (`scheduleReconnect`). fast-check generates
// sessions of failed dials, handshakes that succeed and then drop after a
// generated session length, elapsed time and backwards clock jumps, and
// checks every delay the runtime schedules against a model.
//
//   F1  The delay is 1 s doubled per consecutive failed cycle, capped at 60 s:
//       non-decreasing across failures and never above the cap.
//   F2  Only a session that stayed up for 60 s starts the doubling over. A
//       gateway that accepts and drops at once (restart loop, eviction) keeps
//       backing off instead of pinning reconnects at 1 Hz.
//   F3  A clock that jumps backwards never counts as a stable session.
//
// Health and activity reads are not driven here: both need the profile's
// state database. They only read `reconnectTimer` and `connectionAttempt`;
// the backoff counter is written by `scheduleReconnect` and `stop` alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import {
  FEDERATION_RECONNECT_INITIAL_DELAY_MS,
  FEDERATION_RECONNECT_MAX_DELAY_MS,
} from "../federation/federation-reconnect-policy";

vi.mock("../state/app-state", () => ({
  getAppStateDb: () => ({
    getMeta: () => "",
    setMeta: () => undefined,
  }),
  isAppStateInitialized: () => true,
}));

const GATEWAY = "ws://192.168.1.20:47830";
const STABLE_MS = 60_000;

type Harness = {
  stopping: boolean;
  configuredEndpoints: string[];
  reconnectTimer?: ReturnType<typeof setTimeout>;
  lastConnectedAt?: number;
  scheduleReconnect: () => number | undefined;
  markEndpointConnected: (gatewayUrl: string) => void;
};

type Command =
  | { kind: "dialFails" }
  | { kind: "sessionDrops"; lastedMs: number; clockBackMs: number }
  | { kind: "advance"; ms: number }
  | { kind: "clockBack"; ms: number };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ kind: "dialFails" as const }) },
  {
    weight: 3,
    arbitrary: fc.oneof(
      fc.integer({ min: 0, max: 2_000 }),
      fc.integer({ min: STABLE_MS - 1_000, max: STABLE_MS + 1_000 }),
    ).chain((lastedMs) => fc.oneof(
      { weight: 3, arbitrary: fc.constant(0) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: lastedMs + 200_000 }) },
    ).map((clockBackMs) => ({ kind: "sessionDrops" as const, lastedMs, clockBackMs }))),
  },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 120_000 }).map((ms) => ({ kind: "advance" as const, ms })) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 300_000 }).map((ms) => ({ kind: "clockBack" as const, ms })) },
);

function createHarness(): Harness {
  const runtime = new DesktopFederationRuntime() as unknown as Harness;
  runtime.stopping = false;
  runtime.configuredEndpoints = [GATEWAY];
  return runtime;
}

/** What the reconnect timer firing and the next dial failing amount to. */
function failCycle(runtime: Harness): number {
  clearTimeout(runtime.reconnectTimer);
  runtime.reconnectTimer = undefined;
  const delay = runtime.scheduleReconnect();
  if (delay === undefined) throw new Error("scheduleReconnect scheduled nothing");
  return delay;
}

async function runSession(commands: Command[]): Promise<number[]> {
  const runtime = createHarness();
  const delays: number[] = [];
  // The model: consecutive failed cycles since the last stable session.
  let attempt = 0;
  try {
    for (const command of commands) {
      if (command.kind === "advance") {
        vi.setSystemTime(Date.now() + command.ms);
      } else if (command.kind === "clockBack") {
        vi.setSystemTime(Date.now() - command.ms);
      } else if (command.kind === "dialFails") {
        const delay = failCycle(runtime);
        expect(delay, "F1: delay for a failed dial").toBe(
          Math.min(FEDERATION_RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, FEDERATION_RECONNECT_MAX_DELAY_MS),
        );
        attempt += 1;
        delays.push(delay);
      } else {
        // The handshake path: mark the endpoint and stamp the session start,
        // as the client's successful connect does.
        runtime.markEndpointConnected(GATEWAY);
        runtime.lastConnectedAt = Date.now();
        // A clock that jumps back mid-session shortens it on the wall clock.
        vi.setSystemTime(Date.now() + command.lastedMs - command.clockBackMs);
        if (command.lastedMs - command.clockBackMs >= STABLE_MS) attempt = 0;
        const delay = failCycle(runtime);
        expect(delay, `F2: delay after a ${command.lastedMs}ms session`).toBe(
          Math.min(FEDERATION_RECONNECT_INITIAL_DELAY_MS * 2 ** attempt, FEDERATION_RECONNECT_MAX_DELAY_MS),
        );
        attempt += 1;
        delays.push(delay);
      }
    }
  } finally {
    clearTimeout(runtime.reconnectTimer);
  }
  return delays;
}

describe("federation reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("F1–F3: backs off per cycle and resets only after a stable session", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArbitrary, { maxLength: 40, size: "max" }), async (commands) => {
        await runSession(commands);
      }),
      { numRuns: 300 },
    );
  });

  it("F2: a gateway that accepts and drops at once keeps backing off", async () => {
    const delays = await runSession([
      { kind: "dialFails" },
      { kind: "sessionDrops", lastedMs: 10, clockBackMs: 0 },
      { kind: "sessionDrops", lastedMs: 10, clockBackMs: 0 },
      { kind: "sessionDrops", lastedMs: STABLE_MS, clockBackMs: 0 },
    ]);
    expect(delays).toEqual([1_000, 2_000, 4_000, 1_000]);
  });
});
