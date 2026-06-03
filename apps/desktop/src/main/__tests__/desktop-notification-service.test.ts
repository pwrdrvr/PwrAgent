import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotificationService } from "../notifications/desktop-notification-service";

const {
  shownNotifications,
  getAllWindows,
  MockNotification,
} = vi.hoisted(() => {
  const shown: Array<{
    title: string;
    body: string;
    actions?: Array<{ type: string; text: string }>;
    instance: NotificationMock;
  }> = [];
  const windows = vi.fn(() => [] as Array<{
    isDestroyed: () => boolean;
    isFocused: () => boolean;
    isMinimized: () => boolean;
  }>);

  class NotificationMock {
    static isSupported = vi.fn(() => true);
    private actionHandler?: (
      details: { preventDefault?: () => void },
      actionIndex: number,
      selectionIndex: number,
    ) => void;
    private clickHandler?: () => void;
    private closeHandler?: () => void;

    constructor(
      private readonly payload: {
        title: string;
        body: string;
        actions?: Array<{ type: string; text: string }>;
      },
    ) {}

    on(
      event: "action" | "click" | "close",
      handler: (
        details: { preventDefault?: () => void },
        actionIndex: number,
        selectionIndex: number,
      ) => void,
    ): void {
      if (event === "action") {
        this.actionHandler = handler;
        return;
      }
      if (event === "click") {
        this.clickHandler = () => {
          (handler as unknown as () => void)();
        };
        return;
      }
      if (event === "close") {
        this.closeHandler = () => {
          (handler as unknown as () => void)();
        };
      }
    }

    show(): void {
      shown.push({
        title: this.payload.title,
        body: this.payload.body,
        actions: this.payload.actions,
        instance: this,
      });
    }

    emitAction(actionIndex: number): void {
      this.actionHandler?.({}, actionIndex, -1);
    }

    emitClick(): void {
      this.clickHandler?.();
    }

    emitClose(): void {
      this.closeHandler?.();
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
      {
        title: "Approval needed",
        body: "Please approve",
        actions: undefined,
        instance: shownNotifications[0]?.instance,
      },
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

  it("adds a single approve action and fires it only once on supported platforms", () => {
    const service = new DesktopNotificationService();
    const onApprove = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    vi.spyOn(service as never, "supportsActionButtons").mockReturnValue(true);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-2",
      title: "Approval needed",
      body: "Please approve",
      onApprove,
    });

    expect(shownNotifications[0]?.actions).toEqual([{ type: "button", text: "Approve" }]);

    shownNotifications[0]?.instance.emitAction(0);
    shownNotifications[0]?.instance.emitAction(0);

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("retains live notifications until the native notification resolves", () => {
    const service = new DesktopNotificationService() as never as {
      liveNotifications: Set<unknown>;
      notifyAttention: DesktopNotificationService["notifyAttention"];
    };
    const onApprove = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    vi.spyOn(service as never, "supportsActionButtons").mockReturnValue(true);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-live",
      title: "Approval needed",
      body: "Please approve",
      onApprove,
    });

    expect(service.liveNotifications.size).toBe(1);

    shownNotifications[0]?.instance.emitAction(0);
    expect(service.liveNotifications.size).toBe(0);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-click",
      title: "Approval needed",
      body: "Please approve",
      onApprove,
    });

    expect(service.liveNotifications.size).toBe(1);
    shownNotifications[1]?.instance.emitClick();
    expect(service.liveNotifications.size).toBe(0);
  });

  it("falls back to a passive notification when action buttons are unsupported", () => {
    const service = new DesktopNotificationService();
    const onApprove = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    vi.spyOn(service as never, "supportsActionButtons").mockReturnValue(false);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-3",
      title: "Approval needed",
      body: "Please approve",
      onApprove,
    });

    expect(shownNotifications[0]?.actions).toBeUndefined();
    shownNotifications[0]?.instance.emitAction(0);
    expect(onApprove).not.toHaveBeenCalled();
  });
});
