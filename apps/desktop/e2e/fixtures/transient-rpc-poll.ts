// Handling for a Playwright <-> Electron round trip that fails for reasons
// unrelated to the state being read, split out so the retry and the reporting
// are unit-testable without launching Electron.
//
// Two shapes, because they need opposite things. `tolerateTransientRpcFailure`
// keeps an `expect.poll` polling through one failed round trip.
// `retryTransientRpcCall` re-issues a ONE-SHOT call that has no poll to
// retry it.

/**
 * Wrap a poll callback so ONE failed round trip retries instead of ending
 * the poll.
 *
 * `expect.poll` retries a failed ASSERTION, not a throwing callback. In
 * Playwright 1.62.1 `invokePollMatcher` awaits the callback OUTSIDE the
 * try/catch that decides whether to keep polling:
 *
 *     const value = await actual();            // <- not guarded
 *     try {
 *       await callMatcherAsStep(...);
 *       return { continuePolling: false, result: void 0 };
 *     } catch (error) {
 *       return { continuePolling: true, result: error };
 *     }
 *
 * So a rejection from the callback propagates straight out and the poll
 * ends on its first tick, with its whole deadline unspent.
 *
 * Every caller here polls across the RPC boundary, where a round trip can
 * fail for reasons that say nothing about the state being polled.
 * `electronApplication.evaluate: Resulting promise was garbage collected`
 * did that to `waitForRendererReady` on 2026-09-11 (run 34654211530,
 * "macOS Desktop E2E (lane 3 of 4)"). Because that poll is on the launch
 * path and the pre-flight canary turns a launch failure into "zero tests
 * ran", one flaky round trip cost the whole shard: lanes 1, 2 and 4 passed
 * the same commit — lane 4 on the SAME runner, starting the second lane 3
 * ended — and lane 3 passed on retry.
 *
 * Retaining the failure is the other half of this. Swallowing the rejection
 * silently would leave a genuinely dead app reporting "expected true,
 * received undefined" at the poll deadline with no mention of the RPC, so
 * `rethrowWithLastFailure` puts the last caught error back into the
 * message. A read that succeeds clears it, so a poll that times out against
 * an app that answered every time is never blamed on a stale blip.
 *
 * ONE CONSTRAINT on the matcher, because a failed read reports as
 * `undefined`: the matcher must be one `undefined` cannot satisfy. Every
 * caller today is `toBe(true)`, `toBe("function")`, or `toMatchObject`, all
 * of which treat `undefined` as "keep polling". Under `not.toBe(...)`,
 * `toBeFalsy()`, or `toBeUndefined()` the tolerance would turn an RPC that
 * never answered into a poll that PASSES on its first tick — a barrier that
 * resolves without ever having read the app. Use `assertAnswered` after such
 * a poll, or do not wrap it.
 */
export function tolerateTransientRpcFailure<T>(read: () => Promise<T>): {
  assertAnswered: () => void;
  read: () => Promise<T | undefined>;
  rethrowWithLastFailure: (pollError: unknown) => never;
} {
  // Boxed rather than a bare `unknown`, so a callback that rejects with
  // `undefined` still counts as a failure.
  let lastFailure: { error: unknown } | undefined;
  return {
    /**
     * Call after a poll RESOLVED, when the matcher is one `undefined` could
     * satisfy: a retained failure then means the poll passed on an attempt
     * that never reached the app.
     */
    assertAnswered: () => {
      if (!lastFailure) {
        return;
      }

      throw new Error(
        [
          "A poll resolved on an attempt whose call failed, so the value the",
          "matcher accepted was the absence of an answer rather than app",
          "state. Give this poll a matcher that `undefined` cannot satisfy.",
          `  ${describePollFailure(lastFailure.error)}`,
        ].join("\n"),
        { cause: lastFailure.error },
      );
    },
    read: async () => {
      try {
        const value = await read();
        lastFailure = undefined;
        return value;
      } catch (error) {
        lastFailure = { error };
        return undefined;
      }
    },
    rethrowWithLastFailure: (pollError) => {
      if (!lastFailure) {
        throw pollError;
      }

      const explanation = [
        "",
        "The last poll attempt produced no value because the call itself",
        "threw — either a failed Playwright <-> Electron round trip or a throw",
        "from inside the callback. The error below says which:",
        `  ${describePollFailure(lastFailure.error)}`,
      ].join("\n");
      if (pollError instanceof Error) {
        // Appended in place: Playwright's own assertion error carries the
        // matcher result and a stack its reporter formats, and rewrapping
        // would trade both for a plain `Error`. `filterStackTrace` rebuilds
        // the serialized stack from the live `message`, so the explanation
        // reaches the reporter even though `ExpectError` froze its `stack`
        // at construction.
        pollError.message += `\n${explanation}`;
        // The message carries the failure's text; `cause` carries its FRAMES,
        // which is what a non-RPC throw from inside the callback needs. The
        // reporter prints it as `[cause]:`, so this echoes one line rather
        // than replacing the appended text — the canary reads `message`.
        if (pollError.cause === undefined) {
          pollError.cause = lastFailure.error;
        }
        throw pollError;
      }

      throw new Error(
        `${describePollFailure(pollError)}\n${explanation}`,
        { cause: lastFailure.error },
      );
    },
  };
}

function describePollFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The CDP failure, as Playwright rewrites it.
 *
 * `crExecutionContext.rewriteError` turns CDP's "Promise was collected" into
 * this, so the text is Playwright's, not ours.
 *
 * Only `retryTransientRpcCall` narrows to it, because re-running a callback
 * is a decision about that callback. `tolerateTransientRpcFailure`
 * deliberately does NOT: a poll retries anyway, so it tolerates any failure
 * and hands the retained one to `rethrowWithLastFailure`. Gating the
 * tolerance on this message would restore the bug it was written for, where
 * a non-RPC throw from inside the callback ends the poll on its first tick.
 */
const TRANSIENT_RPC_MESSAGE = "Resulting promise was garbage collected";

/** Long enough to leave the collection behind, short enough to not read as a wait. */
const TRANSIENT_RPC_RETRY_DELAY_MS = 50;

export function isTransientRpcFailure(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes(TRANSIENT_RPC_MESSAGE);
}

/**
 * Re-issue a one-shot round trip that failed in transit.
 *
 * `tolerateTransientRpcFailure` cannot help here: it answers `undefined` and
 * lets the poll go round again, so applying it to a call with a side effect
 * would report success while the side effect never happened.
 *
 * THE PRECONDITION IS IDEMPOTENCE, and it is on the caller. Playwright raises
 * this error from `rewriteError` when CDP reports "Promise was collected",
 * which means V8 had already created a promise for the callback — so the
 * callback may well have RUN and only its result was lost. A retry can
 * therefore run the body twice. Wrap a pure read, or a write that lands on
 * the same state twice (`ipcMain.removeHandler` before `ipcMain.handle` is
 * the pattern here). Do not wrap something that appends, increments, or
 * sends an event a second observer would count.
 *
 * Anything that is not this exact failure propagates on the first throw, so a
 * real error from inside the callback is never retried and never delayed.
 */
export async function retryTransientRpcCall<T>(
  call: () => Promise<T>,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? TRANSIENT_RPC_RETRY_DELAY_MS;
  // Rejected rather than clamped: a budget below one means the caller asked
  // for a call that never happens, and silently making it happen anyway
  // would hide that. Without this the loop body never runs and the function
  // rejects with `undefined` — no message, no stack, and the side effect the
  // caller was waiting on never issued.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `retryTransientRpcCall needs at least one attempt, got ${attempts}`,
    );
  }

  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransientRpcFailure(error)) {
        throw error;
      }
      lastFailure = error;
      // V8 collected the pending promise, which it does under memory
      // pressure — so the next microtask is the worst moment to ask again.
      // Nothing waits on the passing path, where the first call answers.
      if (attempt < attempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastFailure;
}
