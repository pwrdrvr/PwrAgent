import { describe, expect, it, vi } from "vitest";
import { buildPrAutoDispatchBudgetNotice } from "../pr-auto-dispatch-budget-notice";

describe("buildPrAutoDispatchBudgetNotice", () => {
  it("uses the standard dismissal for the safe leave-disabled outcome", () => {
    const onLeaveDisabled = vi.fn();
    const onResume = vi.fn();
    const notice = buildPrAutoDispatchBudgetNotice({
      onLeaveDisabled,
      onResume,
      status: {
        availableTokens: 0,
        capacity: 30,
        refillPerMinute: 1,
        paused: true,
        pausedAt: 1_000,
      },
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "pr-auto-dispatch-budget-paused:1000",
      title: "Auto-fix PR paused",
      tone: "warning",
    });
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Resume"]);

    notice?.onDismiss?.();
    notice?.actions?.[0]?.onClick();
    expect(onLeaveDisabled).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("removes the notice after the safety stop is no longer active", () => {
    expect(buildPrAutoDispatchBudgetNotice({
      onLeaveDisabled: () => undefined,
      onResume: () => undefined,
      status: {
        availableTokens: 1,
        capacity: 30,
        refillPerMinute: 1,
        paused: false,
      },
    })).toBeUndefined();
  });
});
