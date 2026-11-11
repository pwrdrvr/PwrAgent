// Property test of the Codex app-server restart gate
// (`packages/owner-core/src/codex-app-server/app-server-restart-policy.ts`).
// fast-check generates sessions of handshakes, unexpected exits, elapsed
// time, backwards clock jumps, status reads and operator restarts, and
// checks every decision the real policy makes against these rules:
//
//   R1  Reads are pure. `remainingDelayMs()` and `isStopped()` are what the
//       status notice and every waiting start call; interleaving them
//       anywhere never changes a later decision.
//   R2  Each delay lies in [ceiling × (1 − jitter), ceiling], and the
//       ceiling never exceeds `maxDelayMs`.
//   R3  The ceiling never drops between consecutive exits unless the server
//       genuinely stayed up for `stableUptimeMs` after a finished handshake.
//       A handshake that dies at once does not start the doubling over.
//   R4  At most `breakerExitCount − 1` restarts in any `breakerWindowMs` of
//       elapsed time between operator resets, and once the breaker opens it
//       stays open until the operator resets it.
//   R5  A clock that jumps backwards never grants an earlier restart: it can
//       only make wall-clock spans shorter than elapsed time, so every rule
//       above is checked against elapsed time.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CodexAppServerRestartPolicy,
  type CodexAppServerRestartDecision,
} from "../codex-app-server/app-server-restart-policy";

const INITIAL_MS = 1_000;
const MAX_MS = 30_000;
const JITTER = 0.2;
const BREAKER_EXITS = 5;
const BREAKER_WINDOW_MS = 10 * 60_000;
const STABLE_MS = 2 * 60_000;

type Command =
  | { kind: "started" }
  | { kind: "exit"; random: number }
  | { kind: "advance"; ms: number }
  | { kind: "clockBack"; ms: number }
  | { kind: "read" }
  | { kind: "reset" };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: "started" as const }) },
  { weight: 4, arbitrary: fc.double({ min: 0, max: 0.999, noNaN: true }).map((random) => ({ kind: "exit" as const, random })) },
  {
    weight: 4,
    arbitrary: fc.oneof(
      fc.integer({ min: 0, max: 5_000 }),
      fc.integer({ min: STABLE_MS - 1_000, max: STABLE_MS + 1_000 }),
      fc.integer({ min: 0, max: BREAKER_WINDOW_MS }),
    ).map((ms) => ({ kind: "advance" as const, ms })),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 20 * 60_000 }).map((ms) => ({ kind: "clockBack" as const, ms })) },
  { weight: 2, arbitrary: fc.constant({ kind: "read" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "reset" as const }) },
);

type Observed = { decision: CodexAppServerRestartDecision; elapsedMs: number; ceiling?: number };

function run(commands: Command[], interleaveReads: boolean) {
  let elapsed = 0;
  let wall = 1_000_000;
  let random = 0;
  const policy = new CodexAppServerRestartPolicy({
    initialDelayMs: INITIAL_MS,
    maxDelayMs: MAX_MS,
    jitterRatio: JITTER,
    breakerExitCount: BREAKER_EXITS,
    breakerWindowMs: BREAKER_WINDOW_MS,
    stableUptimeMs: STABLE_MS,
    now: () => wall,
    random: () => random,
  });
  const decisions: Observed[] = [];
  const reads: Array<{ remaining: number; stopped: boolean }> = [];
  const read = () => reads.push({ remaining: policy.remainingDelayMs(), stopped: policy.isStopped() });
  for (const command of commands) {
    if (command.kind === "started") policy.recordStarted();
    if (command.kind === "exit") {
      random = command.random;
      decisions.push({ decision: policy.recordExit(), elapsedMs: elapsed });
    }
    if (command.kind === "advance") {
      elapsed += command.ms;
      wall += command.ms;
    }
    if (command.kind === "clockBack") wall -= command.ms;
    if (command.kind === "read") read();
    if (command.kind === "reset") policy.reset();
    if (interleaveReads) read();
  }
  return { decisions, reads };
}

describe("CodexAppServerRestartPolicy properties", () => {
  it("R1: status reads never change a later decision", () => {
    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 80, size: "max" }), (commands) => {
        expect(run(commands, true).decisions).toEqual(run(commands, false).decisions);
      }),
      { numRuns: 500 },
    );
  });

  it("R2–R5: delays are bounded, back off monotonically and the breaker holds", () => {
    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 80, size: "max" }), (commands) => {
        // An oracle that knows only elapsed time and which commands ran.
        let elapsed = 0;
        let startedAtElapsed: number | undefined;
        let previousCeiling: number | undefined;
        let restartsSinceReset: number[] = [];
        let breakerOpen = false;
        let random = 0;
        let wall = 1_000_000;
        const policy = new CodexAppServerRestartPolicy({
          initialDelayMs: INITIAL_MS,
          maxDelayMs: MAX_MS,
          jitterRatio: JITTER,
          breakerExitCount: BREAKER_EXITS,
          breakerWindowMs: BREAKER_WINDOW_MS,
          stableUptimeMs: STABLE_MS,
          now: () => wall,
          random: () => random,
        });
        for (const command of commands) {
          if (command.kind === "started") {
            policy.recordStarted();
            startedAtElapsed = elapsed;
          } else if (command.kind === "advance") {
            elapsed += command.ms;
            wall += command.ms;
          } else if (command.kind === "clockBack") {
            wall -= command.ms;
          } else if (command.kind === "read") {
            expect(policy.isStopped(), "R4: breaker state as read").toBe(breakerOpen);
          } else if (command.kind === "reset") {
            policy.reset();
            previousCeiling = undefined;
            restartsSinceReset = [];
            breakerOpen = false;
            startedAtElapsed = undefined;
          } else {
            random = command.random;
            const decision = policy.recordExit();
            const ranStably = startedAtElapsed !== undefined && elapsed - startedAtElapsed >= STABLE_MS;
            startedAtElapsed = undefined;
            // A stable run starts the doubling over even when this exit is
            // the one that opens the breaker.
            if (ranStably) previousCeiling = undefined;
            if (decision.kind === "stopped") {
              breakerOpen = true;
              continue;
            }
            // Smallest power-of-two ceiling the jittered delay can come from.
            const ceiling = Math.min(MAX_MS, INITIAL_MS * 2 ** (decision.attempt - 1));
            expect(decision.delayMs, "R2: delay above its ceiling").toBeLessThanOrEqual(ceiling);
            expect(decision.delayMs, "R2: delay below the jitter floor")
              .toBeGreaterThanOrEqual(Math.floor(ceiling * (1 - JITTER)));
            if (previousCeiling !== undefined) {
              expect(ceiling, `R3/R5: backoff fell from ${previousCeiling} to ${ceiling} after a short run`)
                .toBeGreaterThanOrEqual(previousCeiling);
            }
            previousCeiling = ceiling;
            expect(policy.remainingDelayMs(), "remaining delay exceeds the decision").toBeLessThanOrEqual(decision.delayMs);
            restartsSinceReset.push(elapsed);
            const inWindow = restartsSinceReset.filter((at) => elapsed - at < BREAKER_WINDOW_MS);
            expect(inWindow.length, "R4/R5: restarts inside one breaker window")
              .toBeLessThanOrEqual(BREAKER_EXITS - 1);
          }
          expect(policy.isStopped(), "R4: the breaker closed without an operator reset").toBe(breakerOpen);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("R3: a handshake that dies at once keeps doubling the delay", () => {
    const { decisions } = run([
      { kind: "started" },
      { kind: "exit", random: 0 },
      { kind: "advance", ms: 1_000 },
      { kind: "started" },
      { kind: "advance", ms: 10 },
      { kind: "exit", random: 0 },
    ], false);
    expect(decisions.map((entry) => entry.decision)).toEqual([
      { kind: "restart", attempt: 1, delayMs: 1_000 },
      { kind: "restart", attempt: 2, delayMs: 2_000 },
    ]);
  });
});
