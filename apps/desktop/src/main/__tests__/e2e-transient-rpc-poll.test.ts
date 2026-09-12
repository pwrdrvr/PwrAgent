import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tolerateTransientRpcFailure } from "../../../e2e/fixtures/transient-rpc-poll";

const e2eDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e",
);

/**
 * The error that motivated the helper, verbatim from
 * "macOS Desktop E2E (lane 3 of 4)" in run 34654211530.
 */
const TRANSIENT_RPC_ERROR =
  "electronApplication.evaluate: Resulting promise was garbage collected";

/**
 * Playwright's poll driver, reduced to the one detail that matters:
 * `invokePollMatcher` awaits the callback OUTSIDE the try/catch that decides
 * whether to keep polling. Reproduced rather than imported because
 * `expect.poll` needs a Playwright test runner, and this is precisely the
 * behavior the helper exists to work with — a test that polled some friendlier
 * way would prove nothing.
 */
async function pollLikePlaywright<T>(params: {
  attempts: number;
  read: () => Promise<T>;
  satisfied: (value: T) => boolean;
}): Promise<void> {
  let lastAssertionError: unknown;
  for (let attempt = 0; attempt < params.attempts; attempt += 1) {
    const value = await params.read();
    try {
      if (!params.satisfied(value)) {
        throw new Error(`expected a satisfied value, received ${String(value)}`);
      }
      return;
    } catch (error) {
      // Keep polling, exactly as Playwright does for a failed assertion, and
      // keep the error — a timed-out poll reports the last one.
      lastAssertionError = error;
    }
  }

  throw lastAssertionError ?? new Error("expected a satisfied value");
}

/** One transient round-trip failure, then the answer the poll waits for. */
function oneFlakyRoundTrip(): () => Promise<boolean> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error(TRANSIENT_RPC_ERROR);
    }
    return true;
  };
}

describe("tolerateTransientRpcFailure", () => {
  // The defect, pinned first: without the wrapper a poll designed to retry
  // gives up on its first tick. This is what killed an E2E shard, because the
  // poll it happened to hit was on the launch path.
  it("is needed because a rejected callback ends an unwrapped poll", async () => {
    await expect(
      pollLikePlaywright({
        attempts: 5,
        read: oneFlakyRoundTrip(),
        satisfied: Boolean,
      }),
    ).rejects.toThrow(TRANSIENT_RPC_ERROR);
  });

  it("retries the failed round trip and reaches the awaited value", async () => {
    const tolerated = tolerateTransientRpcFailure(oneFlakyRoundTrip());

    await expect(
      pollLikePlaywright({
        attempts: 5,
        read: tolerated.read,
        satisfied: Boolean,
      }),
    ).resolves.toBeUndefined();
  });

  // Swallowing silently is the other way to get this wrong: a genuinely dead
  // app would report "received undefined" at the deadline and never mention
  // the RPC that never answered.
  it("reports the retained call failure when the poll times out anyway", async () => {
    const tolerated = tolerateTransientRpcFailure(async () => {
      throw new Error(TRANSIENT_RPC_ERROR);
    });
    const pollError = await pollLikePlaywright({
      attempts: 3,
      read: tolerated.read,
      satisfied: Boolean,
    }).catch((error: unknown) => error);

    expect(() => tolerated.rethrowWithLastFailure(pollError)).toThrow(
      TRANSIENT_RPC_ERROR,
    );
    // Appended in place, so Playwright's own assertion error — its matcher
    // result and its stack — survives to the reporter.
    expect(pollError).toBeInstanceOf(Error);
    expect((pollError as Error).message).toContain("received undefined");
    expect((pollError as Error).message).toContain(TRANSIENT_RPC_ERROR);
  });

  it("keeps the cause when the poll rejected with something other than an Error", async () => {
    const tolerated = tolerateTransientRpcFailure(async () => {
      throw TRANSIENT_RPC_ERROR;
    });
    await expect(tolerated.read()).resolves.toBeUndefined();

    const thrown = captureThrow(() =>
      tolerated.rethrowWithLastFailure("poll gave up")
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("poll gave up");
    expect((thrown as Error).message).toContain(TRANSIENT_RPC_ERROR);
    expect((thrown as Error).cause).toBe(TRANSIENT_RPC_ERROR);
  });

  // `cause` carries the frames; the appended message carries only the text,
  // and a throw from inside the callback (not the wire) is the case that
  // needs the throw site.
  it("attaches the retained failure as the poll error's cause", async () => {
    const callbackBug = new TypeError("cannot read properties of undefined");
    const tolerated = tolerateTransientRpcFailure(async () => {
      throw callbackBug;
    });
    await tolerated.read();

    const pollError = new Error("expected true, received undefined");
    expect(() => tolerated.rethrowWithLastFailure(pollError)).toThrow(pollError);
    expect(pollError.cause).toBe(callbackBug);
  });

  // The viewport poll asserts with `toMatchObject`, which throws its own
  // non-assertion error on an absent value rather than reporting a diff.
  // Playwright catches that in the same try that handles a failed assertion,
  // so the poll keeps going — the property that whole call site rests on.
  it("keeps polling when the matcher throws on the absent value", async () => {
    const tolerated = tolerateTransientRpcFailure(oneFlakyRoundTrip());

    await expect(
      pollLikePlaywright({
        attempts: 5,
        read: tolerated.read,
        satisfied: (value) => {
          if (value === undefined) {
            // What jest's `toMatchObject` does with `undefined`.
            throw new TypeError("received value must be a non-null object");
          }
          return value;
        },
      }),
    ).resolves.toBeUndefined();
  });

  // A matcher `undefined` DOES satisfy would otherwise let a poll resolve on
  // an attempt that never reached the app.
  it("refuses to call a poll answered when its last call failed", async () => {
    const tolerated = tolerateTransientRpcFailure(async () => {
      throw new Error(TRANSIENT_RPC_ERROR);
    });
    await tolerated.read();

    expect(() => tolerated.assertAnswered()).toThrow(
      "matcher accepted was the absence of an answer",
    );
  });

  it("calls a poll answered once a call has produced a value", async () => {
    const tolerated = tolerateTransientRpcFailure(oneFlakyRoundTrip());
    await tolerated.read();
    await tolerated.read();

    expect(() => tolerated.assertAnswered()).not.toThrow();
  });

  // A poll that timed out against an app that answered every time is a real
  // readiness failure. Blaming it on a blip from twenty attempts ago would
  // send the reader after the wrong thing — the mirror image of the
  // investigation this whole change came out of.
  it("does not blame a stale failure once a call has answered", async () => {
    const tolerated = tolerateTransientRpcFailure(oneFlakyRoundTrip());
    await tolerated.read();
    await tolerated.read();

    const pollError = new Error("expected true, received false");
    expect(() => tolerated.rethrowWithLastFailure(pollError)).toThrow(pollError);
    expect(pollError.message).toBe("expected true, received false");
  });
});

// Every `expect.poll` in these fixtures reads across the RPC boundary, so
// every one of them needs the tolerance. Counting is what catches the case the
// helper cannot: a NEW poll added later without it. If you add a poll here
// whose callback cannot fail over the wire, that is what this failing is
// telling you to justify.
//
// The file list is DISCOVERED rather than written down. A hardcoded pair
// covered the two files that had polls the day this was written and would have
// let the next fixture's poll through unexamined, which is the whole failure
// mode the guard exists for.
describe("desktop E2E fixture polls", () => {
  const fixturesWithPolls = readdirSync(path.join(e2eDir, "fixtures"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({ code: readFixtureCode(`fixtures/${entry}`), entry }))
    .filter(({ code }) => code.includes(".poll("));

  // A rename or a move that leaves the scan empty would otherwise pass as
  // "nothing to check".
  it("finds the fixtures that poll at all", () => {
    expect(fixturesWithPolls.map(({ entry }) => entry).sort()).toEqual([
      "electron-app.ts",
      "star-map-window.ts",
    ]);
  });

  for (const { code, entry } of fixturesWithPolls) {
    it(`routes every poll in ${entry} through the RPC tolerance`, () => {
      const polls = code.match(/\.poll\(/g) ?? [];
      const rethrows = code.match(/rethrowWithLastFailure/g) ?? [];

      expect(polls.length).toBeGreaterThan(0);
      expect(rethrows.length).toBe(polls.length);
      expect(code).toContain("tolerateTransientRpcFailure(");
    });
  }
});

/** The error a function threw, for assertions about more than its message. */
function captureThrow(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to throw");
}

/**
 * Comments in these files legitimately DISCUSS the pattern being counted, so
 * match against code only — the same reason `e2e-canary-report.test.ts`
 * strips before asserting.
 */
function readFixtureCode(relativePath: string): string {
  return readFileSync(path.join(e2eDir, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
