import { describe, expect, it, vi } from "vitest";
import type { ThreadToolInvocationAlert } from "@pwragent/shared";
import {
  buildToolAccountingNotice,
  resolveDismissedToolIncident,
  toolAccountingNoticeId,
} from "../tool-accounting-notice";

describe("buildToolAccountingNotice", () => {
  it("makes the explorer the primary action for an aggregated incident", () => {
    const onDismiss = vi.fn();
    const onExamine = vi.fn();
    const notice = buildToolAccountingNotice({
      alert: buildAlert({ kind: "noisy-polling" }),
      onDismiss,
      onExamine,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "tool-accounting:codex:thread-1:turn-1:noisy-polling",
      title: "Repeated queued checks",
      tone: "warning",
    });
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Examine 5 cases",
      "Dismiss",
    ]);
    notice.actions?.[0]?.onClick();
    notice.actions?.[1]?.onClick();
    expect(onExamine).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("upserts large outputs under one critical thread incident", () => {
    const notice = buildToolAccountingNotice({
      alert: buildAlert({ kind: "large-output", severity: "critical" }),
      onDismiss: vi.fn(),
      onExamine: vi.fn(),
    });

    expect(notice).toMatchObject({
      id: "tool-accounting:codex:thread-1:turn-1:large-output",
      title: "Large tool output",
      tone: "error",
    });
    expect(notice.actions?.[0]?.label).toBe("Examine 5 cases");
  });

  it("suppresses rewrites after dismissal until a critical escalation", () => {
    expect(resolveDismissedToolIncident({
      dismissedSeverity: "warning",
      incomingSeverity: "warning",
    })).toBe("suppress");
    expect(resolveDismissedToolIncident({
      dismissedSeverity: "warning",
      incomingSeverity: "critical",
    })).toBe("escalate");
    expect(resolveDismissedToolIncident({
      dismissedSeverity: "critical",
      incomingSeverity: "critical",
    })).toBe("suppress");
  });

  it("uses a new toast identity for a new turn", () => {
    expect(toolAccountingNoticeId(buildAlert({ turnId: "turn-1" })))
      .not.toBe(toolAccountingNoticeId(buildAlert({ turnId: "turn-2" })));
  });
});

function buildAlert(
  overrides: Partial<ThreadToolInvocationAlert>,
): ThreadToolInvocationAlert {
  return {
    alertId: "alert-1",
    backend: "codex",
    createdAt: 1,
    estimatedOutputTokens: 1_000,
    firstObservedAt: 1,
    invocationCount: 5,
    kind: "noisy-polling",
    lastObservedAt: 2,
    message: "The turn keeps waking up.",
    severity: "warning",
    suggestedPrompt: "Use a monitor.",
    threadId: "thread-1",
    turnId: "turn-1",
    toolName: "wait",
    totalOutputChars: 0,
    updatedAt: 2,
    ...overrides,
  };
}
