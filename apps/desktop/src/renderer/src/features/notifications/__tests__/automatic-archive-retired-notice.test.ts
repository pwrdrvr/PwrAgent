import { describe, expect, it, vi } from "vitest";
import { buildAutomaticArchiveRetiredNotice } from "../automatic-archive-retired-notice";

describe("buildAutomaticArchiveRetiredNotice", () => {
  it("says threads stay put and names hibernation as the automatic path", () => {
    const notice = buildAutomaticArchiveRetiredNotice({
      hibernationOn: true, onDismiss: vi.fn(), onOpenHibernation: vi.fn(), onOpenThreadMaintenance: vi.fn(),
    });
    expect(notice.title).toBe("PwrAgent no longer archives threads on its own");
    expect(notice.message).toContain("Your threads stay where they are until you archive them.");
    expect(notice.message).toContain("idle checkouts now hibernate");
    expect(notice.autoDismiss).toBe(false);
    expect(notice.actions?.map((action) => action.label)).toEqual(["Thread Maintenance…", "Hibernation Settings"]);
  });

  it("asks a profile with hibernation off to turn it on, and drops the dialog where it cannot open", () => {
    const notice = buildAutomaticArchiveRetiredNotice({ hibernationOn: false, onDismiss: vi.fn(), onOpenHibernation: vi.fn() });
    expect(notice.message).toContain("Turn on hibernation in Settings → Worktrees");
    expect(notice.actions?.map((action) => action.label)).toEqual(["Hibernation Settings"]);
  });

  it("closes for good through every way out", () => {
    const onDismiss = vi.fn();
    const onOpenHibernation = vi.fn();
    const notice = buildAutomaticArchiveRetiredNotice({ hibernationOn: true, onDismiss, onOpenHibernation });
    notice.onDismiss?.();
    notice.actions?.[0]?.onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpenHibernation).toHaveBeenCalledOnce();
  });
});
