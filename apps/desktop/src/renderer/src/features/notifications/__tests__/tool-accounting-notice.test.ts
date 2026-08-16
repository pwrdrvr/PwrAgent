import type {
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { resolveToolIncidentVisibility } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { buildToolAccountingNotice } from "../tool-accounting-notice";
import {
  buildThreadIncidentSummary,
  formatIncidentMicros,
} from "../thread-incident-summary";

describe("buildThreadIncidentSummary", () => {
  it("folds a thread's flagged calls into one incident", () => {
    const summary = buildThreadIncidentSummary({
      accounting: accounting([
        invocation({ observedAt: 100, outputChars: 8_000, turnId: "turn-1" }),
        invocation({ observedAt: 200, outputChars: 9_000, turnId: "turn-1" }),
        invocation({ observedAt: 300, outputChars: 6_000, turnId: "turn-2" }),
      ]),
      backend: "codex",
      threadId: "thread-1",
    });

    expect(summary?.flaggedInvocationCount).toBe(3);
    expect(summary?.turnsWithWarnings).toBe(2);
    expect(summary?.firstWarningAt).toBe(100);
    expect(summary?.severity).toBe("warning");
  });

  it("counts calls that hit the output cap and escalates to critical", () => {
    const summary = buildThreadIncidentSummary({
      accounting: accounting([
        invocation({ observedAt: 100, outputChars: 8_000 }),
        invocation({ observedAt: 200, outputChars: 40_000 }),
      ]),
      backend: "codex",
      threadId: "thread-1",
    });

    expect(summary?.overCapCount).toBe(1);
    expect(summary?.severity).toBe("critical");
  });

  it("keeps the persisted cost baseline when it predates the snapshot", () => {
    /* A restart drops older accounting rows out of the live snapshot; the
       cost window must not silently move up to the newest warning. */
    const summary = buildThreadIncidentSummary({
      accounting: accounting([invocation({ observedAt: 5_000 })]),
      backend: "codex",
      firstWarningAt: 1_000,
      threadId: "thread-1",
    });

    expect(summary?.firstWarningAt).toBe(1_000);
  });

  it("prices replayed output from the thread's own cache-served rows", () => {
    /* Two calls in one turn: the first is replayed by the second. */
    const summary = buildThreadIncidentSummary({
      accounting: accounting([
        invocation({
          estimatedOutputTokens: 1_000,
          observedAt: 100,
          turnId: "turn-1",
        }),
        invocation({
          estimatedOutputTokens: 500,
          observedAt: 200,
          turnId: "turn-1",
        }),
      ]),
      backend: "codex",
      threadId: "thread-1",
      usageLines: [
        /* 2,000,000 micros for 2,000,000 cached tokens → 1 micro per token. */
        usageLine({
          cachedInputCostMicros: 2_000_000,
          cachedInputTokens: 2_000_000,
          createdAt: 150,
          totalCostMicros: 3_000_000,
        }),
      ],
    });

    expect(summary?.replayedTokens).toBe(1_000);
    expect(summary?.estimatedReplayWasteMicros).toBe(1_000);
    expect(summary?.spentSinceFirstWarningMicros).toBe(3_000_000);
  });

  it("omits money when nothing cache-served has been billed", () => {
    const summary = buildThreadIncidentSummary({
      accounting: accounting([invocation({})]),
      backend: "codex",
      threadId: "thread-1",
      usageLines: [
        usageLine({ cachedInputCostMicros: 0, cachedInputTokens: 0 }),
      ],
    });

    expect(summary?.estimatedReplayWasteMicros).toBeUndefined();
  });

  it("reports no incident for a thread with nothing flagged", () => {
    expect(buildThreadIncidentSummary({
      /* Unmarked AND small: the size test has to miss it too. */
      accounting: accounting([invocation({ noisy: false, outputChars: 500 })]),
      backend: "codex",
      threadId: "thread-1",
    })).toBeUndefined();
  });
});

describe("resolveToolIncidentVisibility", () => {
  it("suppresses a warning the operator muted", () => {
    expect(resolveToolIncidentVisibility({
      severity: "warning",
      state: { mutedSeverity: "warning" },
    })).toBe("suppress");
  });

  it("lets a cap hit through a muted warning", () => {
    /* Muting "output is getting large" must not also silence "output hit the
       cap and was truncated" — that is the escalation the mute is scoped to
       leave alone. */
    expect(resolveToolIncidentVisibility({
      severity: "critical",
      state: { mutedSeverity: "warning" },
    })).toBe("show");
  });

  it("suppresses everything once a critical incident is muted", () => {
    expect(resolveToolIncidentVisibility({
      severity: "critical",
      state: { mutedSeverity: "critical" },
    })).toBe("suppress");
  });

  it("re-shows an escalation past a dismissal", () => {
    expect(resolveToolIncidentVisibility({
      severity: "critical",
      state: { dismissedSeverity: "warning" },
    })).toBe("show");
    expect(resolveToolIncidentVisibility({
      severity: "warning",
      state: { dismissedSeverity: "warning" },
    })).toBe("suppress");
  });
});

describe("buildToolAccountingNotice", () => {
  it("carries one notice id per thread, not per turn", () => {
    const notice = buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      showCost: false,
      summary: summaryFor(),
    });

    expect(notice.id).toBe("tool-accounting:codex:thread-1");
    expect(notice.message).toContain("3 tool calls flagged across 2 turns");
  });

  it("offers a mute for a warning but not for a cap hit", () => {
    const warning = buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      onMute: vi.fn(),
      showCost: false,
      summary: summaryFor(),
    });
    expect(warning.actions?.map((action) => action.label))
      .toContain("Don't warn again");

    const critical = buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      onMute: vi.fn(),
      showCost: false,
      summary: { ...summaryFor(), overCapCount: 2, severity: "critical" },
    });
    expect(critical.actions?.map((action) => action.label))
      .not.toContain("Don't warn again");
    expect(critical.title).toBe("Tool output hit the cap");
  });

  it("shows money only when pricing display is enabled", () => {
    const summary = {
      ...summaryFor(),
      currency: "USD",
      estimatedReplayWasteMicros: 1_850_000,
      spentSinceFirstWarningMicros: 4_120_000,
    };
    expect(buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      showCost: true,
      summary,
    }).message).toContain("$4.12 spent since the first warning, of which about $1.85");
    expect(buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      showCost: false,
      summary,
    }).message).not.toContain("$4.12");
  });
});

function summaryFor() {
  return {
    backend: "codex",
    coversWholeThread: true,
    flaggedInvocationCount: 3,
    overCapCount: 0,
    pollingInvocationCount: 0,
    replayedTokens: 2_400,
    severity: "warning" as const,
    threadId: "thread-1",
    turnsWithWarnings: 2,
  };
}

function accounting(
  invocations: ThreadToolInvocationRecord[],
): ThreadToolAccounting {
  return { alerts: [], invocations, summaries: [] };
}

function invocation(
  overrides: Partial<ThreadToolInvocationRecord>,
): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    category: "shell",
    debugLines: 0,
    errorLines: 0,
    estimatedOutputTokens: 2_000,
    infoLines: 0,
    invocationId: `invocation-${overrides.observedAt ?? 0}`,
    itemId: "item-1",
    noisy: true,
    observedAt: 1_000,
    outputChars: 8_000,
    outputLines: 20,
    outputTruncated: false,
    status: "completed",
    threadId: "thread-1",
    toolName: "commandExecution",
    turnId: "turn-1",
    updatedAt: 1_000,
    warningLines: 0,
    ...overrides,
  };
}

function usageLine(
  overrides: Partial<ThreadUsageLineRecord>,
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt: 1_000,
    currency: "USD",
    inputTokens: 0,
    outputTokens: 0,
    threadId: "thread-1",
    totalCostMicros: 0,
    ...overrides,
  } as ThreadUsageLineRecord;
}

describe("snapshot coverage", () => {
  it("says so when the fold only saw recent activity", () => {
    /* The live notification carries a 200-row page, so a long thread's counts
       are recent activity — the card must not present them as totals. */
    const capped = Array.from({ length: 200 }, (_, index) =>
      invocation({ invocationId: `capped-${index}`, observedAt: 1_000 + index }));
    const summary = buildThreadIncidentSummary({
      accounting: accounting(capped),
      backend: "codex",
      threadId: "thread-1",
    });

    expect(summary?.coversWholeThread).toBe(false);
    expect(buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      showCost: false,
      summary: summary!,
    }).message).toContain("in recent activity");
  });

  it("presents a short thread's counts as the whole thread", () => {
    const summary = buildThreadIncidentSummary({
      accounting: accounting([invocation({})]),
      backend: "codex",
      threadId: "thread-1",
    });

    expect(summary?.coversWholeThread).toBe(true);
    expect(buildToolAccountingNotice({
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
      showCost: false,
      summary: summary!,
    }).message).not.toContain("in recent activity");
  });

  it("formats credits the same way the turn strip does", () => {
    expect(formatIncidentMicros(2_400_000, "credits")).toBe("2.40 cr");
  });
});

describe("replay counting at scale", () => {
  it("counts later trips identically however many calls share a timestamp", () => {
    /* A full-history analyze pass stamps a turn's calls in bulk, so ties are
       the common case, not the edge case. */
    const tied = Array.from({ length: 5 }, (_, index) =>
      invocation({
        estimatedOutputTokens: 100,
        invocationId: `tied-${index}`,
        observedAt: 1_000,
        turnId: "turn-1",
      }));
    const summary = buildThreadIncidentSummary({
      accounting: accounting(tied),
      backend: "codex",
      threadId: "thread-1",
    });

    /* 4 + 3 + 2 + 1 + 0 later trips, each carrying 100 tokens. */
    expect(summary?.replayedTokens).toBe(1_000);
  });

  it("stays linear on a thread far past the notification cap", () => {
    const many = Array.from({ length: 4_000 }, (_, index) =>
      invocation({
        estimatedOutputTokens: 10,
        invocationId: `call-${index}`,
        observedAt: 1_000 + index,
        turnId: `turn-${index % 20}`,
      }));
    const started = performance.now();
    const summary = buildThreadIncidentSummary({
      accounting: accounting(many),
      backend: "codex",
      threadId: "thread-1",
    });
    const elapsed = performance.now() - started;

    expect(summary?.flaggedInvocationCount).toBe(4_000);
    /* The quadratic form took seconds here; a generous ceiling still catches
       a regression back to it. */
    expect(elapsed).toBeLessThan(1_000);
  });
});
