import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  foldObservedContextReplay,
  type ObservedContextReplayCursor,
  type ObservedContextReplayTally,
} from "../app-server/backend-registry";

// Replays the committed synthetic protocol capture through the pure
// accumulator, mirroring how the registry maintains a per-thread cumulative
// cursor and a per-turn tally. See the fixture README for provenance.
type TokenUsageEvent = {
  threadId: string;
  turnId: string;
  tokenUsage: unknown;
};

function loadTokenUsageEvents(): TokenUsageEvent[] {
  const fixturePath = fileURLToPath(
    new URL(
      "./fixtures/context-replay/synthetic-codex-replay-capture.jsonl",
      import.meta.url,
    ),
  );
  const events: TokenUsageEvent[] = [];
  for (const line of readFileSync(fixturePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const envelope = JSON.parse(trimmed) as { method?: string; raw: string };
    if (envelope.method !== "thread/tokenUsage/updated") {
      continue;
    }
    const params = (JSON.parse(envelope.raw) as { params: TokenUsageEvent })
      .params;
    events.push(params);
  }
  return events;
}

function accumulate(events: TokenUsageEvent[]): Map<string, ObservedContextReplayTally> {
  const cursors = new Map<string, ObservedContextReplayCursor>(); // per thread
  const tallies = new Map<string, ObservedContextReplayTally>(); // per turn
  for (const event of events) {
    const { cursor, tally } = foldObservedContextReplay({
      cursor: cursors.get(event.threadId),
      tally: tallies.get(event.turnId),
      tokenUsage: event.tokenUsage,
    });
    if (cursor) {
      cursors.set(event.threadId, cursor);
    }
    if (tally) {
      tallies.set(event.turnId, tally);
    }
  }
  return tallies;
}

describe("foldObservedContextReplay", () => {
  it("counts cold/hot replays per turn from the synthetic capture", () => {
    const events = loadTokenUsageEvents();
    // Fixture: Turn A has 6 requests (2 cold + 4 hot) plus one duplicate
    // emission; Turn B has 1 hot request.
    expect(events.length).toBe(8);

    const tallies = accumulate(events);
    const byTurn = [...tallies.entries()].map(([turnId, tally]) => ({
      turnId,
      ...tally,
    }));
    const turnA = byTurn.find((t) => t.turnId.includes("turnA"));
    const turnB = byTurn.find((t) => t.turnId.includes("turnB"));

    expect(turnA).toMatchObject({
      coldReplayCount: 2,
      hotReplayCount: 4,
      // req1: no prior context -> replayed = full input, minus its 6,400 cached.
      // req5: replayed = prior context 172,995 (req4 input+output), minus its
      // 8,200 cache-served tokens.
      coldReplayUncachedTokens: 153_600 + (172_995 - 8_200),
      hotReplayCachedTokens: 159_800 + 164_900 + 169_100 + 178_400,
    });
    expect(turnB).toMatchObject({
      coldReplayCount: 0,
      hotReplayCount: 1,
      hotReplayCachedTokens: 159_104,
    });
  });

  it("does not double-count a duplicate re-emission (non-increasing total)", () => {
    // Feed the same update twice: the second must be a no-op.
    const tokenUsage = {
      total: { inputTokens: 200_000, cachedInputTokens: 8_000 },
      last: { inputTokens: 160_000, cachedInputTokens: 8_000 },
      modelContextWindow: 258_400,
    };
    const first = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage,
    });
    expect(first.tally).toMatchObject({ coldReplayCount: 1, hotReplayCount: 0 });

    const second = foldObservedContextReplay({
      cursor: first.cursor,
      tally: first.tally,
      tokenUsage,
    });
    expect(second.tally).toMatchObject({ coldReplayCount: 1, hotReplayCount: 0 });
    expect(second.cursor).toEqual(first.cursor);
  });

  it("never counts a forked thread's inherited baseline", () => {
    // First observed update on a fork: `total` already holds ~19M inherited
    // input; only the single observed request (last) counts.
    const { tally } = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 19_121_016, cachedInputTokens: 17_792_768 },
        last: { inputTokens: 159_821, cachedInputTokens: 159_104 },
      },
    });
    expect(tally).toMatchObject({
      coldReplayCount: 0,
      hotReplayCount: 1,
      hotReplayCachedTokens: 159_104,
    });
  });

  it("skips sub-threshold requests (new prompt, not a context replay)", () => {
    const { tally, cursor } = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 1_200, cachedInputTokens: 0 },
        last: { inputTokens: 1_200, cachedInputTokens: 0 },
      },
    });
    expect(tally).toBeUndefined();
    // Cursor still advances so the next real request is measured against it.
    expect(cursor).toEqual({
      cumulativeInputTokens: 1_200,
      lastContextTokens: 1_200,
    });
  });

  it("caps cold attribution at the prior context size, excluding fresh input", () => {
    // Mirrors a real observed thread: a 53,646-token turn completes, then the
    // next turn's first request submits 73,766 tokens on a cold cache — 71,334
    // uncached, but only ~54.1k of that is the replayed prior context; the rest
    // is fresh prompt/injected content that would be paid for regardless.
    const first = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 53_646, cachedInputTokens: 2_432 },
        last: {
          inputTokens: 53_646,
          cachedInputTokens: 2_432,
          outputTokens: 487,
        },
      },
    });
    expect(first.cursor).toEqual({
      cumulativeInputTokens: 53_646,
      lastContextTokens: 54_133,
    });

    const second = foldObservedContextReplay({
      cursor: first.cursor,
      tally: undefined, // new turn — fresh tally
      tokenUsage: {
        total: { inputTokens: 127_412, cachedInputTokens: 4_864 },
        last: { inputTokens: 73_766, cachedInputTokens: 2_432 },
      },
    });
    expect(second.tally).toMatchObject({
      coldReplayCount: 1,
      // Replayed portion = prior context 54,133; its 2,432 cache-served tokens
      // are subtracted — only the cache-missed replay overhead counts.
      coldReplayUncachedTokens: 54_133 - 2_432,
    });
  });

  it("does not flip a cache-hit request to cold on a large fresh payload", () => {
    // A tool loop reads big files: the request resubmits a fully-cached 100k
    // context PLUS ~60k of fresh command output. The fresh tokens dilute the
    // cache fraction of the whole input below 90%, but the REPLAYED portion was
    // cache-served — this is a hot replay plus fresh content, not a cold one.
    const first = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 100_000, cachedInputTokens: 95_000 },
        last: {
          inputTokens: 100_000,
          cachedInputTokens: 95_000,
          outputTokens: 500,
        },
      },
    });
    expect(first.tally).toMatchObject({ hotReplayCount: 1, coldReplayCount: 0 });

    const second = foldObservedContextReplay({
      cursor: first.cursor,
      tally: first.tally,
      tokenUsage: {
        total: { inputTokens: 260_000, cachedInputTokens: 195_000 },
        last: { inputTokens: 160_000, cachedInputTokens: 100_000 },
      },
    });
    // cached (100,000) vs whole input (160,000) is only 62.5% — but vs the
    // replayed portion (prior context 100,500) it is ~99.5%: hot.
    expect(second.tally).toMatchObject({
      coldReplayCount: 0,
      hotReplayCount: 2,
      hotReplayCachedTokens: 195_000,
    });
  });

  it("does not count a mostly-fresh request whose replayed context is tiny", () => {
    // A thread starts with a small 5k context; the next request carries 55k of
    // fresh payload. The whole input clears the 32k floor, but the replayed
    // portion (5k) does not — it is not a context replay.
    const first = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 5_000, cachedInputTokens: 0 },
        last: { inputTokens: 5_000, cachedInputTokens: 0 },
      },
    });
    expect(first.tally).toBeUndefined();

    const second = foldObservedContextReplay({
      cursor: first.cursor,
      tally: first.tally,
      tokenUsage: {
        total: { inputTokens: 65_000, cachedInputTokens: 4_800 },
        last: { inputTokens: 60_000, cachedInputTokens: 4_800 },
      },
    });
    expect(second.tally).toBeUndefined();
    // Cursor still advances: the fresh content becomes the next context.
    expect(second.cursor).toEqual({
      cumulativeInputTokens: 65_000,
      lastContextTokens: 60_000,
    });
  });

  it("classifies a both-eligible request as hot only — never both", () => {
    // One request over a 50k context: 60k uncached (>= context size, so it
    // LOOKS cold-eligible) AND 50k cached (= the full context, so it IS a
    // cache hit). A single request is exactly one replay; cached takes
    // precedence and the uncached remainder is fresh input, attributed
    // nowhere. toEqual (not toMatchObject) locks the cold bucket at zero.
    const { tally } = foldObservedContextReplay({
      cursor: { cumulativeInputTokens: 50_000, lastContextTokens: 50_000 },
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 160_000, cachedInputTokens: 50_000 },
        last: { inputTokens: 110_000, cachedInputTokens: 50_000 },
      },
    });
    expect(tally).toEqual({
      coldReplayCount: 0,
      coldReplayUncachedTokens: 0,
      hotReplayCachedTokens: 50_000,
      hotReplayCount: 1,
    });
  });

  it("classifies a genuine cache miss as cold only — never both", () => {
    // Same shape but the cache genuinely missed most of the 50k context (20k
    // cached): one cold replay attributed at the cache-MISSED portion of the
    // replayed context (50k − 20k), and nothing in the hot bucket despite the
    // partial cache hit — the 20k that was served sits inside the replayed
    // window and is not uncached overhead.
    const { tally } = foldObservedContextReplay({
      cursor: { cumulativeInputTokens: 50_000, lastContextTokens: 50_000 },
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 160_000, cachedInputTokens: 20_000 },
        last: { inputTokens: 110_000, cachedInputTokens: 20_000 },
      },
    });
    expect(tally).toEqual({
      coldReplayCount: 1,
      coldReplayUncachedTokens: 30_000,
      hotReplayCachedTokens: 0,
      hotReplayCount: 0,
    });
  });

  it("classifies a request cached at exactly the 90% threshold as hot", () => {
    // Locks the >= boundary of OBSERVED_HOT_CACHE_FRACTION: cached is exactly
    // 0.9 × replayed (90,000 of a 100,000 prior context).
    const { tally } = foldObservedContextReplay({
      cursor: { cumulativeInputTokens: 100_000, lastContextTokens: 100_000 },
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 230_000, cachedInputTokens: 90_000 },
        last: { inputTokens: 130_000, cachedInputTokens: 90_000 },
      },
    });
    expect(tally).toEqual({
      coldReplayCount: 0,
      coldReplayUncachedTokens: 0,
      hotReplayCachedTokens: 90_000,
      hotReplayCount: 1,
    });
  });

  it("refreshes the context snapshot from a duplicate that books late output", () => {
    // Some cadences emit usage when the request's input is booked (output 0)
    // and re-emit the same cumulative total once output lands. The duplicate
    // must not count, but its output belongs in the context snapshot so the
    // NEXT request's replayed portion is not underestimated.
    const first = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 40_000, cachedInputTokens: 0 },
        last: { inputTokens: 40_000, cachedInputTokens: 0, outputTokens: 0 },
      },
    });
    expect(first.cursor).toEqual({
      cumulativeInputTokens: 40_000,
      lastContextTokens: 40_000,
    });

    const second = foldObservedContextReplay({
      cursor: first.cursor,
      tally: first.tally,
      tokenUsage: {
        total: { inputTokens: 40_000, cachedInputTokens: 0 },
        last: { inputTokens: 40_000, cachedInputTokens: 0, outputTokens: 8_000 },
      },
    });
    // Not counted again, but the snapshot now includes the 8k output.
    expect(second.tally).toEqual(first.tally);
    expect(second.cursor).toEqual({
      cumulativeInputTokens: 40_000,
      lastContextTokens: 48_000,
    });

    const third = foldObservedContextReplay({
      cursor: second.cursor,
      tally: second.tally,
      tokenUsage: {
        total: { inputTokens: 90_000, cachedInputTokens: 45_000 },
        last: { inputTokens: 50_000, cachedInputTokens: 45_000 },
      },
    });
    // replayed = min(50,000, 48,000) = 48,000; cached 45,000 >= 0.9 × 48,000
    // (43,200) -> hot. Without the refresh, replayed would be 40,000 and the
    // request would still be hot here, but a floor/threshold case would skew.
    expect(third.tally).toMatchObject({
      hotReplayCount: 1,
      hotReplayCachedTokens: 45_000,
    });
  });

  it("falls back to the whole input when the prior context snapshot is zero", () => {
    // A zero lastContextTokens (contradictory prior data) must not zero out
    // replay counting via the floor — it behaves like an unknown prior.
    const { tally } = foldObservedContextReplay({
      cursor: { cumulativeInputTokens: 10_000, lastContextTokens: 0 },
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 63_646, cachedInputTokens: 2_432 },
        last: { inputTokens: 53_646, cachedInputTokens: 2_432 },
      },
    });
    expect(tally).toMatchObject({
      coldReplayCount: 1,
      coldReplayUncachedTokens: 51_214,
    });
  });

  it("attributes the full uncached amount when no prior context is known", () => {
    // First observed request after app start: no prior snapshot, so cold
    // attribution falls back to the request's full uncached amount.
    const { tally } = foldObservedContextReplay({
      cursor: undefined,
      tally: undefined,
      tokenUsage: {
        total: { inputTokens: 53_646, cachedInputTokens: 2_432 },
        last: { inputTokens: 53_646, cachedInputTokens: 2_432 },
      },
    });
    expect(tally).toMatchObject({
      coldReplayCount: 1,
      coldReplayUncachedTokens: 51_214,
    });
  });
});
