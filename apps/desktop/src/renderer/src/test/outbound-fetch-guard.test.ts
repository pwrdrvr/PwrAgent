// The renderer half of the guard in `../../../test-setup/outbound-fetch-guard.ts`.
//
// The main-process self-test (`src/main/__tests__/outbound-fetch-guard.test.ts`)
// covers everything that does not depend on a document origin. This file covers
// the one thing it cannot: under jsdom a relative URL is a same-origin request
// against `localhost`, not an unparseable one, and the guard measures egress
// rather than same-origin.
import { afterEach, describe, expect, it } from "vitest";

const ATTEMPTS = Symbol.for("pwragent.outboundFetchGuard.attempts");

type Attempt = { method: string; url: string };

afterEach(() => {
  drainAttempts();
});

describe("outbound fetch guard under jsdom", () => {
  it("does not count a same-origin relative URL as egress", async () => {
    // The request still fails — undici will not resolve a relative URL against
    // jsdom's location — but it fails past the guard rather than at it.
    await swallow(() => fetch("/api/threads"));

    expect(drainAttempts()).toEqual([]);
  });

  it("still blocks a remote host reached from the renderer", async () => {
    await swallow(() => fetch("https://api.github.com/repos/pwrdrvr/PwrAgent"));

    expect(drainAttempts()).toEqual([
      { method: "GET", url: "https://api.github.com/repos/pwrdrvr/PwrAgent" },
    ]);
  });
});

async function swallow(request: () => Promise<unknown>): Promise<void> {
  try {
    await request();
  } catch {
    // The callers this guard protects all degrade inside their own catch.
  }
}

/** Consumes the guard's record so its own `afterEach` sees a clean slate. */
function drainAttempts(): Attempt[] {
  const recorded = (globalThis as Record<symbol, unknown>)[ATTEMPTS] as
    | Attempt[]
    | undefined;
  return recorded?.splice(0) ?? [];
}
