import { describe, expect, it, vi } from "vitest";
import { buildAutoAccessUpgradeNotice } from "../auto-access-upgrade-notice";

describe("buildAutoAccessUpgradeNotice", () => {
  it("builds a sticky neutral notice that every way out closes for good", () => {
    const onDismiss = vi.fn();
    const onReviewAccess = vi.fn();
    const notice = buildAutoAccessUpgradeNotice({ onDismiss, onReviewAccess });

    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "auto-access-upgrade",
      title: "New threads start on Auto",
      // Nothing is wrong; the notice reports a changed default.
      tone: "neutral",
    });
    expect(notice.message).toMatch(/Threads you already have keep their access/);
    expect(notice.actions?.map((action) => [action.label, action.tone])).toEqual([
      ["Got it", "secondary"],
      ["Review access", "primary"],
    ]);

    notice.onDismiss?.();
    notice.actions?.[0]?.onClick();
    expect(onDismiss).toHaveBeenCalledTimes(2);
    notice.actions?.[1]?.onClick();
    expect(onReviewAccess).toHaveBeenCalledTimes(1);
  });
});
