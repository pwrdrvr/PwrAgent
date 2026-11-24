import { describe, expect, it, vi } from "vitest";
import { buildAntigravityUpdateNotice } from "../AntigravityUpdateNotice";

describe("Antigravity update notice", () => {
  it("names both versions and offers the update and Settings", () => {
    const onUpdate = vi.fn();
    const onOpenSettings = vi.fn();
    const notice = buildAntigravityUpdateNotice({
      latestVersion: "1.5.16",
      currentVersion: "1.5.15",
      installing: false,
      onUpdate,
      onOpenSettings,
      onDismiss: vi.fn(),
    });
    expect(notice).toMatchObject({
      id: "antigravity-update:1.5.16",
      autoDismiss: false,
      title: "Antigravity update available",
      message: "Antigravity 1.5.16 is available. PwrAgent's install is 1.5.15.",
    });
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Update to 1.5.16",
      "Open Antigravity settings",
    ]);
    notice.actions?.[0]?.onClick();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("drops its buttons while the install runs, so it cannot be started twice", () => {
    const notice = buildAntigravityUpdateNotice({
      latestVersion: "1.5.16",
      currentVersion: "1.5.15",
      installing: true,
      onUpdate: vi.fn(),
      onOpenSettings: vi.fn(),
      onDismiss: vi.fn(),
    });
    expect(notice.actions).toEqual([]);
  });
});
