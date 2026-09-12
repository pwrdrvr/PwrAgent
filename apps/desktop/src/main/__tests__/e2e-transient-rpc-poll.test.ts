import { readFileSync } from "node:fs";
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

  it("keeps the cause when the poll rejected with something other than an Error", () => {
    const tolerated = tolerateTransientRpcFailure(async () => {
      throw TRANSIENT_RPC_ERROR;
    });

    return expect(tolerated.read())
      .resolves.toBeUndefined()
      .then(() => {
        let thrown: unknown;
        try {
          tolerated.rethrowWithLastFailure("poll gave up");
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("poll gave up");
        expect((thrown as Error).message).toContain(TRANSIENT_RPC_ERROR);
        expect((thrown as Error).cause).toBe(TRANSIENT_RPC_ERROR);
      });
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
describe("desktop E2E fixture polls", () => {
  for (const fixture of ["fixtures/electron-app.ts", "fixtures/star-map-window.ts"]) {
    it(`routes every poll in ${fixture} through the RPC tolerance`, () => {
      const code = readFixtureCode(fixture);
      const polls = code.match(/\.poll\(/g) ?? [];
      const rethrows = code.match(/rethrowWithLastFailure/g) ?? [];

      expect(polls.length).toBeGreaterThan(0);
      expect(rethrows.length).toBe(polls.length);
      expect(code).toContain("tolerateTransientRpcFailure(");
    });
  }
});

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
