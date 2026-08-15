import type { ThreadToolInvocationRecord } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildCategoryComposition,
  buildTurnCostStrip,
  capMeterWidth,
  formatCapShare,
  formatCompactTokens,
  countRepeatedCommands,
  formatCategoryLabel,
  formatInvocationIdentity,
  formatMicrosCurrency,
  formatTurnWhen,
  invocationStatusTone,
  refineToolCategory,
  isOverOutputCap,
  sortIncidentCases,
  summarizeIncidents,
  unwrapShellCommand,
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

/* Commands whose verbs agree with the category, so a fixture that declares a
   category is not silently re-categorized by the verb scan. */
const COMMAND_FOR_CATEGORY: Partial<Record<string, string>> = {
  "build-test": "vitest run",
  "file-io": "cat notes.md",
  git: "git status",
  mcp: "mcp__server__call",
  "package-manager": "pnpm install",
  polling: "sleep 5",
  search: "rg pattern",
  shell: "./deploy.sh",
  "sub-agent": "task_monitor",
  unknown: "opaque_tool",
};

function invocation(
  overrides: Partial<ThreadToolInvocationRecord> = {},
): ThreadToolInvocationRecord {
  const category = overrides.category ?? "shell";
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
    normalizedCommand: COMMAND_FOR_CATEGORY[category] ?? "./deploy.sh",
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

describe("formatTurnWhen", () => {
  const now = new Date("2026-08-15T14:00:00Z").getTime();

  it("counts minutes, then hours and minutes, for the last day", () => {
    expect(formatTurnWhen(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatTurnWhen(now - (3 * 3_600_000 + 20 * 60_000), now))
      .toBe("3h 20m ago");
    expect(formatTurnWhen(now - 5 * 3_600_000, now)).toBe("5h ago");
  });

  it("names the weekday inside a week and dates anything older", () => {
    /* A bare clock time is ambiguous the moment a thread spans days, and
       these threads run for days — two rows reading "2:00 PM" can be three
       days apart. */
    const threeDaysAgo = formatTurnWhen(now - 3 * 86_400_000, now);
    expect(threeDaysAgo).toMatch(/^[A-Za-z]{3} /);
    const older = formatTurnWhen(now - 30 * 86_400_000, now);
    expect(older).toMatch(/^\d+\/\d+ /);
  });
});

describe("countRepeatedCommands", () => {
  it("reports commands the thread ran more than once", () => {
    const repeats = countRepeatedCommands([
      invocation({ normalizedCommand: "sed -n '1,420p' runbook.md" }),
      invocation({ normalizedCommand: "sed -n '1,420p' runbook.md" }),
      invocation({ normalizedCommand: "sed -n '1,420p' runbook.md" }),
      invocation({ normalizedCommand: "cat README.md" }),
    ]);

    expect(repeats.get("sed -n '1,420p' runbook.md")).toBe(3);
    expect(repeats.has("cat README.md")).toBe(false);
  });
});

describe("refineToolCategory", () => {
  it("separates agent instructions and skill files from bulk file reads", () => {
    /* `file-io` was 80% of one thread's output. Knowing it was the same
       instruction files, re-read, is the part that suggests a fix. */
    expect(refineToolCategory({
      category: "file-io",
      normalizedCommand: "cat AGENTS.md",
      toolName: "commandExecution",
    })).toBe("agent-instructions");
    expect(refineToolCategory({
      category: "file-io",
      normalizedCommand: "sed -n '1,400p' .agents/skills/manage-macos/SKILL.md",
      toolName: "commandExecution",
    })).toBe("skill-files");
    expect(refineToolCategory({
      category: "file-io",
      normalizedCommand: "cat src/index.ts",
      toolName: "commandExecution",
    })).toBe("file-io");
  });

  it("leaves non-file categories alone", () => {
    expect(refineToolCategory({
      category: "git",
      normalizedCommand: "git diff AGENTS.md",
      toolName: "commandExecution",
    })).toBe("git");
  });
});

describe("buildCategoryComposition tail", () => {
  it("names a single folded category instead of calling it Other", () => {
    const composition = buildCategoryComposition([
      invocation({ category: "file-io", estimatedOutputTokens: 500 }),
      invocation({ category: "git", estimatedOutputTokens: 400 }),
      invocation({ category: "search", estimatedOutputTokens: 300 }),
      invocation({ category: "shell", estimatedOutputTokens: 200 }),
      invocation({ category: "mcp", estimatedOutputTokens: 100 }),
    ]);

    expect(composition.at(-1)?.label).toBe("MCP");
  });
});

describe("composition members", () => {
  it("carries the folded categories so Other can filter", () => {
    /* "Other" was rendered as a disabled remainder — 10% of a real thread's
       output with no way to reach it. */
    const composition = buildCategoryComposition([
      invocation({ category: "file-io", estimatedOutputTokens: 900 }),
      invocation({ category: "git", estimatedOutputTokens: 800 }),
      invocation({ category: "shell", estimatedOutputTokens: 700 }),
      invocation({ category: "build-test", estimatedOutputTokens: 600 }),
      invocation({ category: "mcp", estimatedOutputTokens: 500 }),
      invocation({ category: "polling", estimatedOutputTokens: 400 }),
    ]);

    const other = composition.at(-1);
    expect(other?.category).toBe("other");
    expect(other?.label).toBe("Other (2)");
    expect(other?.members.sort()).toEqual(["mcp", "polling"]);
  });

  it("gives a named entry itself as its only member", () => {
    const composition = buildCategoryComposition([
      invocation({ category: "git", estimatedOutputTokens: 100 }),
    ]);
    expect(composition[0]?.members).toEqual(["git"]);
  });
});

describe("compound command categorization", () => {
  it("unwraps a shell wrapper and reads every verb, not the first token", () => {
    /* Real row from a 236-turn thread. Persisted as `shell`/`build-test`:
       the first token is /bin/bash, and " test" matched a path. Note the
       missing separators — redactCommandText collapses the script's newlines
       at persist time, so the sub-commands run together. */
    expect(refineToolCategory({
      category: "build-test",
      normalizedCommand:
        "/bin/bash -c 'git diff --check git diff --stat git status --short "
        + "--branch git diff -- tests/test-macos-images.sh'",
      toolName: "commandExecution",
    })).toBe("git");
  });

  it("leaves a category the persisted classifier got right", () => {
    /* `pnpm test` is Tests & builds; the verb scan would call it a package
       manager. It only runs when the persisted value is untrustworthy. */
    expect(refineToolCategory({
      category: "build-test",
      normalizedCommand: "pnpm test",
      toolName: "commandExecution",
    })).toBe("build-test");
  });

  it("still separates when the verbs disagree", () => {
    expect(refineToolCategory({
      category: "shell",
      normalizedCommand: "find . -name '*.ts' | xargs cat",
      toolName: "commandExecution",
    })).toBe("shell");
  });

  it("does not treat a git diff of a skill file as a skill read", () => {
    expect(refineToolCategory({
      category: "shell",
      normalizedCommand: "git diff -- .agents/skills/build/SKILL.md",
      toolName: "commandExecution",
    })).toBe("git");
  });

  it("unwraps the wrapper for reads too", () => {
    expect(unwrapShellCommand("/bin/bash -c 'cat AGENTS.md'"))
      .toBe("cat AGENTS.md");
    expect(refineToolCategory({
      category: "shell",
      normalizedCommand: "/bin/bash -c 'cat AGENTS.md'",
      toolName: "commandExecution",
    })).toBe("agent-instructions");
  });
});

describe("mcp subcategories", () => {
  it("splits MCP by server from the persisted server/tool identity", () => {
    /* Context7's `query-docs` was filed under Other: the old classifier
       inferred MCP from an "mcp" substring in the tool name, which
       `list_mcp_resources` happened to carry and `query-docs` did not. */
    expect(refineToolCategory({
      category: "mcp",
      normalizedCommand: "context7/query-docs",
      toolName: "query-docs",
    })).toBe("mcp:context7");
    expect(formatCategoryLabel("mcp:context7")).toBe("MCP · context7");
  });

  it("keeps a bare MCP call without a recorded server in the plain bucket", () => {
    expect(refineToolCategory({
      category: "mcp",
      normalizedCommand: "query-docs",
      toolName: "query-docs",
    })).toBe("mcp");
  });
});

describe("turn cost", () => {
  it("joins billed cost onto turns by turn id", () => {
    const strip = buildTurnCostStrip(
      [
        invocation({ observedAt: 10, turnId: "turn-a" }),
        invocation({ observedAt: 20, turnId: "turn-b" }),
      ],
      {
        usageLines: [
          { createdAt: 1, currency: "USD", totalCostMicros: 1_500_000, turnId: "turn-a" },
          { createdAt: 2, currency: "USD", totalCostMicros: 900_000, turnId: "turn-a" },
        ] as never,
      },
    );

    expect(strip.rows.find((row) => row.key === "turn-a")?.costMicros)
      .toBe(2_400_000);
    /* A turn the ledger has not priced reports nothing rather than zero. */
    expect(strip.rows.find((row) => row.key === "turn-b")?.costMicros)
      .toBeUndefined();
  });

  it("formats money in the ledger's units", () => {
    expect(formatMicrosCurrency(2_400_000, "USD")).toBe("$2.4");
    expect(formatMicrosCurrency(358_000_000, "USD")).toBe("$358");
    expect(formatMicrosCurrency(2_400_000, "credits")).toBe("2.4 cr");
  });
});

describe("turn strip scope and ranking", () => {
  it("defaults to turns with flagged calls and reports both populations", () => {
    const strip = buildTurnCostStrip([
      invocation({ observedAt: 10, outputChars: 20_000, turnId: "turn-loud" }),
      invocation({ noisy: false, observedAt: 20, outputChars: 200, turnId: "turn-quiet" }),
    ]);

    expect(strip.scope).toBe("flagged");
    expect(strip.rows.map((row) => row.key)).toEqual(["turn-loud"]);
    expect(strip.flaggedTurnCount).toBe(1);
    expect(strip.totalTurnCount).toBe(2);
  });

  it("exposes the unscoped chronological timeline alongside the ranked rows", () => {
    /* The spark chart is the "when": all turns, time order, no scope — a long
       poll only reads as a pattern when adjacency survives. */
    const strip = buildTurnCostStrip([
      invocation({ noisy: false, observedAt: 20, outputChars: 200, turnId: "turn-quiet" }),
      invocation({ observedAt: 10, outputChars: 20_000, turnId: "turn-loud" }),
    ]);

    expect(strip.rows.map((row) => row.key)).toEqual(["turn-loud"]);
    expect(strip.timeline.map((row) => row.key))
      .toEqual(["turn-loud", "turn-quiet"]);
  });

  it("keeps ordinals identical across scopes", () => {
    /* "Turn 2" must name the same turn whichever scope is active, or the
       label stops matching the case list. */
    const rows = [
      invocation({ noisy: false, observedAt: 10, outputChars: 200, turnId: "turn-quiet" }),
      invocation({ observedAt: 20, outputChars: 20_000, turnId: "turn-loud" }),
    ];
    const flaggedScope = buildTurnCostStrip(rows);
    const allScope = buildTurnCostStrip(rows, { scope: "all" });

    expect(flaggedScope.rows[0]?.label).toBe("Turn 2");
    expect(allScope.rows.map((row) => row.label)).toEqual(["Turn 1", "Turn 2"]);
  });

  it("ranks by billed cost when the ledger has priced the turns", () => {
    /* "Costliest" next to a visible price column has to mean dollars — the
       token/trip blend ranked turns in an order no column explained. */
    const strip = buildTurnCostStrip(
      [
        invocation({ estimatedOutputTokens: 9_000, observedAt: 10, turnId: "turn-tokens" }),
        invocation({ estimatedOutputTokens: 1_000, observedAt: 20, turnId: "turn-dollars" }),
        invocation({ estimatedOutputTokens: 500, observedAt: 30, turnId: "turn-cheap" }),
      ],
      {
        limit: 2,
        usageLines: [
          { createdAt: 1, currency: "USD", totalCostMicros: 900_000, turnId: "turn-tokens" },
          { createdAt: 2, currency: "USD", totalCostMicros: 5_000_000, turnId: "turn-dollars" },
          { createdAt: 3, currency: "USD", totalCostMicros: 100_000, turnId: "turn-cheap" },
        ] as never,
      },
    );

    expect(strip.rankedBy).toBe("billed");
    expect(strip.rows.map((row) => row.key))
      .toEqual(["turn-dollars", "turn-tokens"]);
  });

  it("falls back to the blend when nothing is priced", () => {
    const strip = buildTurnCostStrip(
      [
        invocation({ estimatedOutputTokens: 9_000, observedAt: 10, turnId: "turn-a" }),
        invocation({ estimatedOutputTokens: 1_000, observedAt: 20, turnId: "turn-b" }),
        invocation({ estimatedOutputTokens: 500, observedAt: 30, turnId: "turn-c" }),
      ],
      { limit: 2 },
    );

    expect(strip.rankedBy).toBe("estimate");
    expect(strip.rows[0]?.key).toBe("turn-a");
  });
});
