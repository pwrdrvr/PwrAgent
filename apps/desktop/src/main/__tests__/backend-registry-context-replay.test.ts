import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  foldObservedContextReplay,
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
  const cursors = new Map<string, number>(); // per thread
  const tallies = new Map<string, ObservedContextReplayTally>(); // per turn
  for (const event of events) {
    const { cursor, tally } = foldObservedContextReplay({
      cursor: cursors.get(event.threadId),
      tally: tallies.get(event.turnId),
      tokenUsage: event.tokenUsage,
    });
    if (typeof cursor === "number") {
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
      coldReplayUncachedTokens: 153_600 + 169_300,
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
    expect(second.cursor).toBe(first.cursor);
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
    expect(cursor).toBe(1_200);
  });
});
