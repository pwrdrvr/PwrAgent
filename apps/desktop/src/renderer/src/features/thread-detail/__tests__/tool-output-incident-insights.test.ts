import type { ThreadToolInvocationRecord } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildCategoryComposition,
  buildTurnCostStrip,
  capMeterWidth,
  formatCapShare,
  formatCompactTokens,
  formatInvocationIdentity,
  invocationStatusTone,
  isOverOutputCap,
  sortIncidentCases,
  summarizeIncidents,
} from "../tool-output-incident-insights";

describe("summarizeIncidents", () => {
  it("reports flagged output as a share of all accounted output", () => {
    const summary = summarizeIncidents([
      invocation({ estimatedOutputTokens: 3_000, noisy: true, outputChars: 12_000 }),
      invocation({ estimatedOutputTokens: 1_000, noisy: true, outputChars: 4_000 }),
      /* Small and unmarked: below the size test, so not a case either way. */
      invocation({ estimatedOutputTokens: 1_000, noisy: false, outputChars: 500 }),
    ]);

    expect(summary.caseCount).toBe(2);
    expect(summary.incidentTokens).toBe(4_000);
    expect(summary.totalTokens).toBe(5_000);
    expect(summary.share).toBeCloseTo(0.8);
    expect(summary.worstChars).toBe(12_000);
  });

  it("reports a zero share rather than dividing by zero on an empty thread", () => {
    expect(summarizeIncidents([]).share).toBe(0);
  });
});

describe("buildTurnCostStrip", () => {
  it("counts every call in a turn, not only the flagged ones", () => {
    /* The round-trip driver: a turn of quiet calls still replays the whole
       accumulated context once per call, so a strip built from flagged rows
       alone would under-report the turn that costs the most. */
    const strip = buildTurnCostStrip([
      invocation({ noisy: true, observedAt: 10, turnId: "turn-a" }),
      invocation({ noisy: false, observedAt: 20, turnId: "turn-a" }),
      invocation({ noisy: false, observedAt: 30, turnId: "turn-a" }),
    ]);

    expect(strip.rows).toHaveLength(1);
    expect(strip.rows[0]?.callCount).toBe(3);
  });

  it("keeps a high-round-trip turn when ranking drops rows", () => {
    /* Ranking on output alone would cut the polling turn — the pathology the
       tick rail exists to show — and then call it lower-cost. */
    const polling = Array.from({ length: 40 }, (_, index) =>
      invocation({
        estimatedOutputTokens: 50,
        observedAt: 1_000 + index,
        turnId: "turn-polling",
      }));
    const verbose = Array.from({ length: 3 }, (_, index) =>
      invocation({
        estimatedOutputTokens: 5_000,
        observedAt: 10_000 + index * 1_000,
        turnId: `turn-verbose-${index}`,
      }));
    const strip = buildTurnCostStrip([...polling, ...verbose], { limit: 2 });

    expect(strip.ordering).toBe("cost");
    expect(strip.rows.map((row) => row.key)).toContain("turn-polling");
  });

  it("labels every turn, including the ones the row limit dropped", () => {
    const strip = buildTurnCostStrip(
      [
        invocation({ estimatedOutputTokens: 900, observedAt: 10, turnId: "turn-a" }),
        invocation({ estimatedOutputTokens: 800, observedAt: 20, turnId: "turn-b" }),
        invocation({ estimatedOutputTokens: 1, observedAt: 30, turnId: "turn-c" }),
      ],
      { limit: 2 },
    );

    expect(strip.rows.map((row) => row.key)).not.toContain("turn-c");
    /* A case in the dropped turn still has to name its turn. */
    expect(strip.labelsByKey.get("turn-c")).toBe("Turn 3");
  });

  it("numbers turns chronologically and keeps the numbering when ranked by cost", () => {
    const strip = buildTurnCostStrip(
      [
        invocation({ estimatedOutputTokens: 100, observedAt: 10, turnId: "turn-a" }),
        invocation({ estimatedOutputTokens: 900, observedAt: 20, turnId: "turn-b" }),
        invocation({ estimatedOutputTokens: 500, observedAt: 30, turnId: "turn-c" }),
      ],
      { limit: 2 },
    );

    expect(strip.ordering).toBe("cost");
    expect(strip.rows.map((row) => row.label)).toEqual(["Turn 2", "Turn 3"]);
    expect(strip.hiddenTurnCount).toBe(1);
    expect(strip.maxTokens).toBe(900);
  });

  it("stays in time order while every turn fits", () => {
    const strip = buildTurnCostStrip([
      invocation({ estimatedOutputTokens: 900, observedAt: 20, turnId: "turn-b" }),
      invocation({ estimatedOutputTokens: 100, observedAt: 10, turnId: "turn-a" }),
    ]);

    expect(strip.ordering).toBe("time");
    expect(strip.rows.map((row) => row.label)).toEqual(["Turn 1", "Turn 2"]);
    expect(strip.hiddenTurnCount).toBe(0);
  });

  it("labels calls with no turn instead of numbering them", () => {
    const strip = buildTurnCostStrip([
      invocation({ observedAt: 10, turnId: undefined }),
    ]);

    expect(strip.rows[0]?.label).toBe("Unassigned");
  });
});

describe("buildCategoryComposition", () => {
  it("ranks by output tokens and folds the tail into one entry", () => {
    const composition = buildCategoryComposition(
      [
        invocation({ category: "shell", estimatedOutputTokens: 600 }),
        invocation({ category: "search", estimatedOutputTokens: 200 }),
        invocation({ category: "git", estimatedOutputTokens: 120 }),
        invocation({ category: "mcp", estimatedOutputTokens: 80 }),
      ],
      { limit: 2 },
    );

    expect(composition.map((entry) => entry.label))
      .toEqual(["Shell", "Search", "Other (2)"]);
    expect(composition[2]?.estimatedOutputTokens).toBe(200);
    expect(composition[0]?.share).toBeCloseTo(0.6);
  });
});

describe("sortIncidentCases", () => {
  it("puts the biggest output first", () => {
    const sorted = sortIncidentCases([
      invocation({ invocationId: "small", outputChars: 4_000 }),
      invocation({ invocationId: "big", outputChars: 17_771 }),
    ], "largest");

    expect(sorted.map((entry) => entry.invocationId)).toEqual(["big", "small"]);
  });

  it("orders by observation time for the by-turn reading", () => {
    const sorted = sortIncidentCases([
      invocation({ invocationId: "late", observedAt: 200 }),
      invocation({ invocationId: "early", observedAt: 100 }),
    ], "turn");

    expect(sorted.map((entry) => entry.invocationId)).toEqual(["early", "late"]);
  });
});

describe("formatInvocationIdentity", () => {
  it("keeps the distinguishing tail of commands that share a long prefix", () => {
    /* Both rows begin with the same 60 characters. A head truncation renders
       them identical, which is the failure this elision exists to fix. */
    const prefix = "set -o pipefail state_dir=local-state/m4-handoff/";
    const first = formatInvocationIdentity(`${prefix}diagnose-listener-boundary`);
    const second = formatInvocationIdentity(`${prefix}verify-helper-teardown`);

    expect(`${first.lead}${first.detail}`)
      .not.toBe(`${second.lead}${second.detail}`);
    /* The tail survives the elision — that is what makes the rows readable
       as two different commands rather than two copies of one. */
    expect(first.detail).toContain("boundary");
    expect(second.detail).toContain("teardown");
    expect(first.lead).toBe("set -o pipefail");
  });

  it("leaves a short command whole", () => {
    const identity = formatInvocationIdentity("pnpm test");
    expect(identity.lead).toBe("pnpm test");
    expect(identity.detail).toBe("");
  });

  it("flattens embedded newlines so a row stays one line", () => {
    const identity = formatInvocationIdentity("printf 'a'\n  tail -n 90 log");
    expect(`${identity.lead} ${identity.detail}`).not.toContain("\n");
  });
});

describe("output cap meters", () => {
  it("measures against the cap the analyzer flags against", () => {
    expect(capMeterWidth(20_000)).toBeCloseTo(0.5);
    expect(isOverOutputCap(39_999)).toBe(false);
    expect(isOverOutputCap(40_000)).toBe(true);
  });

  it("pins rather than overflowing past the cap", () => {
    expect(capMeterWidth(400_000)).toBe(1);
  });
});

describe("invocationStatusTone", () => {
  it("reserves success coloring for a call that actually succeeded", () => {
    expect(invocationStatusTone(invocation({ exitCode: 0, status: "completed" })))
      .toBe("ok");
    /* A non-zero exit is a failure whatever the transport status says. */
    expect(invocationStatusTone(invocation({ exitCode: 1, status: "completed" })))
      .toBe("error");
    expect(invocationStatusTone(invocation({ status: "failed" }))).toBe("error");
    expect(invocationStatusTone(invocation({ status: "cancelled" }))).toBeUndefined();
    expect(invocationStatusTone(invocation({ status: "in_progress" }))).toBeUndefined();
  });
});

describe("formatCapShare", () => {
  it("shortens the cap phrase for case rows", () => {
    expect(formatCapShare(20_000)).toBe("50% of the output cap");
    expect(formatCapShare(20_000, { short: true })).toBe("50% of cap");
  });
});

describe("formatCompactTokens", () => {
  it("keeps small counts exact and abbreviates large ones", () => {
    expect(formatCompactTokens(940)).toBe("940");
    expect(formatCompactTokens(4_443)).toBe("4.4k");
    expect(formatCompactTokens(140_437)).toBe("140k");
  });
});

function invocation(
  overrides: Partial<ThreadToolInvocationRecord> = {},
): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    category: "shell",
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: 1_000,
    infoLines: 0,
    invocationId: "invocation-1",
    itemId: "item-1",
    noisy: true,
    normalizedCommand: "pnpm test",
    observedAt: 1_800_000_000_000,
    outputChars: 4_000,
    outputLines: 20,
    outputTruncated: false,
    status: "completed",
    threadId: "thread-1",
    toolName: "commandExecution",
    turnId: "turn-1",
    updatedAt: 1_800_000_000_000,
    warningLines: 0,
    ...overrides,
  };
}
