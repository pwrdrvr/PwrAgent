import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotificationService } from "../notifications/desktop-notification-service";

const {
  shownNotifications,
  getAllWindows,
  MockNotification,
} = vi.hoisted(() => {
  const shown: Array<{ title: string; body: string }> = [];
  const windows = vi.fn(() => [] as Array<{
    isDestroyed: () => boolean;
    isFocused: () => boolean;
    isMinimized: () => boolean;
  }>);

  class NotificationMock {
    static isSupported = vi.fn(() => true);

    constructor(private readonly payload: { title: string; body: string }) {}

    show(): void {
      shown.push(this.payload);
    }
  }

  return {
    shownNotifications: shown,
    getAllWindows: windows,
    MockNotification: NotificationMock,
  };
});

vi.mock("electron", () => ({
  Notification: MockNotification,
  BrowserWindow: {
    getAllWindows,
  },
}));

describe("DesktopNotificationService", () => {
  beforeEach(() => {
    shownNotifications.length = 0;
    MockNotification.isSupported.mockReturnValue(true);
    getAllWindows.mockReturnValue([]);
  });

  it("emits attention notifications only once per key", () => {
    const service = new DesktopNotificationService();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-1",
      title: "Approval needed",
      body: "Please approve",
    });
    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-1",
      title: "Approval needed",
      body: "Please approve",
    });

    expect(shownNotifications).toEqual([
      { title: "Approval needed", body: "Please approve" },
    ]);
  });

  it("does not emit notifications while app is focused", () => {
    const service = new DesktopNotificationService();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false },
    ]);

    service.notifyTerminal({
      enabled: true,
      title: "Turn completed",
      body: "Done",
    });

    expect(shownNotifications).toEqual([]);
  });
});
