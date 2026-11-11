// Model test of the durable GitHub release-list cache
// (`github-release-cache.ts`) at its own seam, below the auto-updater.
// `auto-updater.request-budget.property.test.ts` drives the updater end to
// end with successes and rate limits; this file adds what that session never
// generates: failed and thrown requests, manual checks that fail, and a clock
// that jumps backwards, all against the real on-disk state file.
//
// The rules, checked on the log of HTTP requests after every command:
//
//   G1  A call answered without a request (cached body or deferral) leaves
//       the state file byte-for-byte unchanged. Reading the cache never
//       resets a failure count, a budget slot or a retry time.
//   G2  At most 6 automatic requests in any hour of elapsed time.
//   G3  No request at all, manual or automatic, before a rate limit resets.
//   G4  After a failure, the next automatic request waits out the failure
//       backoff: 5, 10, 20, 40, then 60 minutes for consecutive failures,
//       manual or automatic. Only a successful response starts it over.
//   G5  After a success, the next automatic request waits a full hour.
//   G6  No automatic request in the first 10 minutes of a fresh root.
//
// Wall-clock gates are checked against elapsed time: a clock that jumps
// backwards may delay a request, never admit one early.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  RELEASE_AUTOMATIC_HOURLY_BUDGET,
  RELEASE_AUTOMATIC_TTL_MS,
  RELEASE_FIRST_CHECK_DELAY_MS,
  fetchGitHubReleaseMetadata,
} from "../github-release-cache";

const MINUTE = 60_000;
// Every release check on the machine spends from one budget: the updater,
// managed runtimes and Grok each read their own release list.
const URLS = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => `https://api.github.com/repos/pwrdrvr/project-${index}/releases`);

type Outcome = "ok" | "notModified" | "serverError" | "rateLimited" | "throws";
type Command =
  | { kind: "check"; manual: boolean; outcome: Outcome; url: number }
  | { kind: "advance"; ms: number }
  | { kind: "clockBack"; ms: number };

const outcomeArbitrary = fc.constantFrom<Outcome>("ok", "notModified", "serverError", "rateLimited", "throws");
const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ manual: fc.integer({ min: 0, max: 3 }).map((roll) => roll === 0), outcome: outcomeArbitrary, url: fc.integer({ min: 0, max: URLS.length - 1 }) })
      .map(({ manual, outcome, url }) => ({ kind: "check" as const, manual, outcome, url })),
  },
  {
    weight: 5,
    arbitrary: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 3 * MINUTE }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 70 * MINUTE }) },
    ).map((ms) => ({ kind: "advance" as const, ms })),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 90 * MINUTE }).map((ms) => ({ kind: "clockBack" as const, ms })) },
);
// A sweep is every caller asking at once, the case the shared budget is for.
const sweepArbitrary: fc.Arbitrary<Command[]> = outcomeArbitrary.map((outcome) =>
  URLS.map((_, url) => ({ kind: "check" as const, manual: false, outcome, url })));
const sessionArbitrary: fc.Arbitrary<Command[]> = fc.array(
  fc.oneof({ weight: 6, arbitrary: commandArbitrary.map((command) => [command]) }, { weight: 1, arbitrary: sweepArbitrary }),
  { maxLength: 40, size: "max" },
).map((groups) => groups.flat());

type Request = {
  url: number;
  elapsedMs: number;
  manual: boolean;
  outcome: Outcome;
  // This URL's failures since its last success, including this one.
  failureStreak: number;
  rateLimitResetWallMs?: number;
  wallMs: number;
};

function failureBackoffMs(streak: number): number {
  return Math.min(RELEASE_AUTOMATIC_TTL_MS, 5 * MINUTE * 2 ** (Math.min(streak, 5) - 1));
}

async function runSession(commands: Command[]): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "pwragent-release-cache-property-"));
  const stateFile = path.join(directory, "state.json");
  let elapsed = 0;
  let wall = Date.parse("2026-11-01T00:00:00.000Z");
  let nextOutcome: Outcome = "ok";
  const failureStreaks = new Map<number, number>();
  let firstCallElapsed: number | undefined;
  const requests: Request[] = [];
  const readState = () => {
    try {
      return readFileSync(stateFile, "utf8");
    } catch {
      return undefined;
    }
  };
  const fakeFetch = (async () => {
    const outcome = nextOutcome;
    if (outcome === "throws") throw new TypeError("fetch failed");
    if (outcome === "ok") return new Response("[]", { status: 200, headers: { etag: 'W/"releases"' } });
    if (outcome === "notModified") return new Response(null, { status: 304 });
    if (outcome === "serverError") return new Response("<html>bad gateway</html>", { status: 502 });
    const resetSeconds = Math.ceil((wall + 15 * MINUTE) / 1_000);
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) },
    });
  }) as typeof fetch;

  try {
    for (const command of commands) {
      if (command.kind === "advance") {
        elapsed += command.ms;
        wall += command.ms;
        continue;
      }
      if (command.kind === "clockBack") {
        wall -= command.ms;
        continue;
      }
      nextOutcome = command.outcome;
      firstCallElapsed ??= elapsed;
      const before = readState();
      const count = requests.length;
      let sent = false;
      const trackingFetch = (async (...args: Parameters<typeof fetch>) => {
        sent = true;
        return await fakeFetch(...args);
      }) as typeof fetch;
      let response: Response | undefined;
      try {
        response = await fetchGitHubReleaseMetadata(URLS[command.url]!, {}, {
          directory,
          fetch: trackingFetch,
          manual: command.manual,
          now: () => wall,
        });
      } catch {
        // Deferred or failed; the request log says which.
      }
      if (!sent) {
        // A missing file on the very first call is created, not changed.
        if (before !== undefined) {
          expect(readState(), "G1: a call that sent nothing rewrote the state").toBe(before);
        }
        continue;
      }
      // A 304 without a cached body is not a success either.
      const success = command.outcome === "ok"
        || (command.outcome === "notModified" && response?.status === 200);
      const failureStreak = success ? 0 : (failureStreaks.get(command.url) ?? 0) + 1;
      failureStreaks.set(command.url, failureStreak);
      requests.push({
        url: command.url,
        elapsedMs: elapsed,
        manual: command.manual,
        outcome: command.outcome,
        failureStreak,
        wallMs: wall,
        ...(command.outcome === "rateLimited"
          ? { rateLimitResetWallMs: Math.ceil((wall + 15 * MINUTE) / 1_000) * 1_000 }
          : {}),
      });
      checkRequest(requests, count, firstCallElapsed);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkRequest(requests: Request[], index: number, firstCallElapsed: number): void {
  const request = requests[index]!;
  const earlier = requests.slice(0, index);
  const limited = earlier.find((prior) =>
    prior.rateLimitResetWallMs !== undefined && request.wallMs < prior.rateLimitResetWallMs);
  expect(limited, "G3: request before the rate limit reset").toBeUndefined();
  if (request.manual) return;
  expect(request.elapsedMs - firstCallElapsed, "G6: automatic request inside the first-check delay")
    .toBeGreaterThanOrEqual(RELEASE_FIRST_CHECK_DELAY_MS);
  const lastHour = earlier.filter((prior) =>
    !prior.manual && prior.elapsedMs > request.elapsedMs - RELEASE_AUTOMATIC_TTL_MS);
  expect(lastHour.length + 1, "G2: hourly automatic budget").toBeLessThanOrEqual(RELEASE_AUTOMATIC_HOURLY_BUDGET);
  const previous = earlier.filter((prior) => prior.url === request.url).at(-1);
  if (!previous) return;
  const gap = request.elapsedMs - previous.elapsedMs;
  if (previous.failureStreak > 0) {
    expect(gap, `G4: automatic retry ${gap}ms after failure ${previous.failureStreak}`)
      .toBeGreaterThanOrEqual(failureBackoffMs(previous.failureStreak));
  } else {
    expect(gap, `G5: automatic request ${gap}ms after a success`)
      .toBeGreaterThanOrEqual(RELEASE_AUTOMATIC_TTL_MS);
  }
}

describe("GitHub release cache request budget", () => {
  it("holds the budget, backoff and rate limit, and reads never write", async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, runSession),
      { numRuns: 200 },
    );
  }, 120_000);

  it("spends one hourly budget across every release list", async () => {
    // The first call creates the root; automatic checks wait out its delay.
    await runSession([
      { kind: "check", manual: true, outcome: "ok", url: 7 },
      { kind: "advance", ms: RELEASE_FIRST_CHECK_DELAY_MS },
      ...URLS.map((_, url) => ({ kind: "check" as const, manual: false, outcome: "ok" as const, url })),
    ]);
  });

  it("still counts a slot spent before the clock moved back", async () => {
    await runSession([
      { kind: "check", manual: true, outcome: "ok", url: 7 },
      { kind: "advance", ms: RELEASE_FIRST_CHECK_DELAY_MS + MINUTE },
      { kind: "check", manual: false, outcome: "ok", url: 0 },
      { kind: "clockBack", ms: 1 },
      ...URLS.map((_, url) => ({ kind: "check" as const, manual: false, outcome: "ok" as const, url })),
    ]);
  });

  it("doubles the wait after each consecutive failure", async () => {
    await runSession([
      { kind: "check", manual: true, outcome: "ok", url: 1 },
      { kind: "advance", ms: RELEASE_FIRST_CHECK_DELAY_MS },
      { kind: "check", manual: false, outcome: "serverError", url: 0 },
      { kind: "advance", ms: 5 * MINUTE },
      { kind: "check", manual: false, outcome: "throws", url: 0 },
      { kind: "advance", ms: 5 * MINUTE },
      { kind: "check", manual: false, outcome: "ok", url: 0 },
    ]);
  });

  it("keeps a failure's backoff when a cached read answers in the meantime", async () => {
    await runSession([
      { kind: "check", manual: true, outcome: "ok", url: 1 },
      { kind: "advance", ms: RELEASE_FIRST_CHECK_DELAY_MS },
      { kind: "check", manual: false, outcome: "ok", url: 0 },
      { kind: "advance", ms: RELEASE_AUTOMATIC_TTL_MS },
      { kind: "check", manual: false, outcome: "serverError", url: 0 },
      { kind: "check", manual: false, outcome: "ok", url: 0 },
      { kind: "advance", ms: 4 * MINUTE },
      { kind: "check", manual: false, outcome: "ok", url: 0 },
    ]);
  });
});
