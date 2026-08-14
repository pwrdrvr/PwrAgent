import { describe, expect, it, vi } from "vitest";
import type { ThreadToolInvocationAlert } from "@pwragent/shared";
import { buildToolAccountingNotice } from "../tool-accounting-notice";

describe("buildToolAccountingNotice", () => {
  it("builds one sticky monitor action for repeated queued checks", () => {
    const onDismiss = vi.fn();
    const onSteer = vi.fn();
    const notice = buildToolAccountingNotice({
      alert: buildAlert({ kind: "noisy-polling" }),
      onDismiss,
      onSteer,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "tool-accounting:codex:thread-1:noisy-polling",
      title: "Repeated queued checks",
      tone: "warning",
    });
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Use monitor job",
      "Dismiss",
    ]);
    notice.actions?.[0]?.onClick();
    notice.actions?.[1]?.onClick();
    expect(onSteer).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("upserts large outputs under one critical thread incident", () => {
    const notice = buildToolAccountingNotice({
      alert: buildAlert({ kind: "large-output", severity: "critical" }),
      onDismiss: vi.fn(),
      onSteer: vi.fn(),
    });

    expect(notice).toMatchObject({
      id: "tool-accounting:codex:thread-1:large-output",
      title: "Large tool output",
      tone: "error",
    });
    expect(notice.actions?.[0]?.label).toBe("Steer safer output");
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
    toolName: "wait",
    totalOutputChars: 0,
    updatedAt: 2,
    ...overrides,
  };
}
