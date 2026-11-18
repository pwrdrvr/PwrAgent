import fc from "fast-check";
import { expect, it } from "vitest";
import { estimateCodexCreditsForLine } from "@pwragent/shared";
import type { LiveThreadRequestUsage } from "../app-server/backend-registry-types";
import { buildLiveThreadUsageLine, foldLiveThreadRequestUsage } from "../app-server/thread-usage-math";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const cutover = Date.parse("2027-03-01T00:00:00-08:00");

function priceTurn(before: number, after: number, beforeOutput: number, afterOutput: number) {
  let current: LiveThreadRequestUsage | undefined;
  for (const [observedAt, input, output, cumulativeOutput] of [
    [before, 1, beforeOutput, beforeOutput],
    [after, 1, beforeOutput, beforeOutput], // A redelivery retains the first observation's price.
    [after, 2, afterOutput, beforeOutput + afterOutput],
  ] as const) {
    const event = {
      current, observedAt,
      tokenUsage: {
        last: { inputTokens: 1, outputTokens: output },
        total: { inputTokens: input, outputTokens: cumulativeOutput },
      },
    };
    current = foldLiveThreadRequestUsage(event);
  }
  return buildLiveThreadUsageLine({
    backend: "codex", createdAt: after, model: "gpt-6.2-sol", serviceTier: "ultrafast",
    requestTokenUsages: current?.requests,
    threadId: "thread", turnId: "turn", tokenUsage: { inputTokens: 2, outputTokens: beforeOutput + afterOutput },
  })!;
}

// Published GPT-6.2 Sol output rates per million are $30/$60 and 750/1500 credits.
// Input contributes 150/300 microcredits for each of the two one-token prompts.
it("prices every measured request at its own interval even after redelivery", () => {
  fc.assert(fc.property(
    fc.tuple(fc.integer({ min: 1, max: 1000 }), fc.nat(1000)),
    fc.tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 })),
    ([before, after], [beforeOutput, afterOutput]) => {
      const line = priceTurn(cutover - before, cutover + after, beforeOutput, afterOutput);
      expect(line.pricingBasis).toBe("request-components");
      expect(line.outputCostMicros).toBe(beforeOutput * 30 + afterOutput * 60);
      expect(estimateCodexCreditsForLine({ ...line, createdAt: cutover - before })?.totalCreditMicros)
        .toBe(beforeOutput * 750 + afterOutput * 1500 + 450);
    },
  ));
});

it("charges $9 for two 100,000-token outputs straddling midnight Pacific", () => {
  const line = priceTurn(cutover - 1, cutover, 100_000, 100_000);
  expect(line.outputCostMicros).toBe(9_000_000);
  expect(line.pricingCatalogVersion).toBeUndefined();
  expect(line.pricingRateId).toBeUndefined();
  expect(estimateCodexCreditsForLine({ ...line, createdAt: cutover - 1 })?.totalCreditMicros)
    .toBe(225_000_450);
});

it("retains request rates and paid credits when SQLite keeps the first row timestamp", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    const usage = { backend: "codex", model: "gpt-6.2-sol", serviceTier: "ultrafast", threadId: "thread", turnId: "turn" } as const;
    await store.upsertThreadUsageLine({ line: buildLiveThreadUsageLine({
      ...usage, createdAt: cutover - 1, tokenUsage: { inputTokens: 1, outputTokens: 100_000 },
    })! });
    await store.upsertThreadUsageLine({ line: priceTurn(cutover - 1, cutover, 100_000, 100_000) });
    // A rebuild after the in-memory request fold is gone still has the same measured totals.
    await store.upsertThreadUsageLine({ line: buildLiveThreadUsageLine({
      ...usage, createdAt: cutover + 1, tokenUsage: { inputTokens: 2, outputTokens: 200_000 },
    })! });
    const { lines: [line] } = await store.readThreadPricing({ backend: "codex", threadId: "thread" });
    expect(line).toMatchObject({
      createdAt: cutover - 1,
      outputCostMicros: 9_000_000,
      pricingBasis: "request-components",
      requestPricing: {
        apiRateIds: [
          "openai:2026-11-17:gpt-6.2-sol:ultrafast:input-lte-272k",
          "openai:2027-03-01:gpt-6.2-sol:ultrafast:input-lte-272k",
        ],
        codexCredits: {
          rateIds: ["openai:2026-11-17:codex-credits:gpt-6.2-sol:ultrafast", "openai:2027-03-01:codex-credits:gpt-6.2-sol:ultrafast"],
          totalCreditMicros: 225_000_450,
        },
      },
    });
    expect(estimateCodexCreditsForLine(line!)?.totalCreditMicros).toBe(225_000_450);
  } finally {
    db.close();
  }
});
