import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingApprovalIntent } from "@pwragent/messaging-interface";
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
      details: { actionIndex?: number; preventDefault?: () => void },
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
        details: { actionIndex?: number; preventDefault?: () => void },
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
      const event = { actionIndex, preventDefault: vi.fn() };
      this.actionHandler?.(event, actionIndex, -1);
    }

    emitClick(): void {
      this.clickHandler?.();
    }

    emitClose(): void {
      this.closeHandler?.();
    }

    close(): void {
      this.emitClose();
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

function approvalIntent(params?: {
  body?: string;
  decisions?: MessagingApprovalIntent["decisions"];
}): MessagingApprovalIntent {
  return {
    id: "approval-intent-1",
    kind: "approval",
    createdAt: 1000,
    title: "Command Approval",
    body:
      params?.body ??
      [
        "Run command?",
        "Command:",
        "```shell",
        "npm view eslint",
        "```",
        "Reply with \"1\", \"2\", \"yes\", \"yes for this session\", \"no\", or use a button.",
      ].join("\n"),
    fallbackText: "Reply yes, yes for this session, no, cancel, or a choice number.",
    decisions:
      params?.decisions ??
      [
        {
          id: "approval:accept",
          label: "Approve Once",
          decision: "accept",
          style: "primary",
          fallbackText: "1",
        },
        {
          id: "approval:decline",
          label: "Decline",
          decision: "decline",
          style: "danger",
          fallbackText: "no",
        },
      ],
  };
}

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

  it("does not emit attention notifications while a window is focused", () => {
    const service = new DesktopNotificationService();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false },
    ]);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-focused",
      title: "Approval needed",
      body: "Please approve",
    });

    expect(shownNotifications).toEqual([]);
  });

  it("does not emit approval notifications while a window is focused", () => {
    const service = new DesktopNotificationService();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => true, isMinimized: () => false },
    ]);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-focused-approval",
      intent: approvalIntent(),
      onDecision: vi.fn(),
    });

    expect(shownNotifications).toEqual([]);
  });

  it("renders terminal notifications as body-click notifications until explicit cleanup", () => {
    const service = new DesktopNotificationService();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    const serviceWithLiveNotifications = service as unknown as {
      attentionKeys: Set<string>;
      liveNotifications: Set<unknown>;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(true);

    service.notifyTerminal({
      enabled: true,
      key: "codex:thread-1:turn-terminal",
      title: "PwrAgent turn completed",
      body: "PwrAgent > npm view eslint · turn completed.",
      onShow,
    });

    expect(shownNotifications[0]?.actions).toBeUndefined();
    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(1);
    expect(
      serviceWithLiveNotifications.attentionKeys.has(
        "codex:thread-1:turn-terminal",
      ),
    ).toBe(true);

    shownNotifications[0]?.instance.emitClick();

    expect(onShow).toHaveBeenCalledTimes(1);
    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(0);
    expect(
      serviceWithLiveNotifications.attentionKeys.has(
        "codex:thread-1:turn-terminal",
      ),
    ).toBe(true);

    service.notifyTerminal({
      enabled: true,
      key: "codex:thread-1:turn-terminal",
      title: "PwrAgent turn completed",
      body: "PwrAgent > npm view eslint · turn completed again.",
      onShow,
    });
    expect(shownNotifications).toHaveLength(1);

    service.clearAttentionKey("codex:thread-1:turn-terminal");
    expect(
      serviceWithLiveNotifications.attentionKeys.has(
        "codex:thread-1:turn-terminal",
      ),
    ).toBe(false);
  });

  it("renders approval intents with a native approve action and opens the thread on click", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(true);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-2",
      intent: approvalIntent(),
      onDecision,
      onShow,
    });

    expect(shownNotifications[0]?.actions).toEqual([
      { type: "button", text: "Approve" },
    ]);
    expect(shownNotifications[0]?.title).toBe("PwrAgent approval needed");
    expect(shownNotifications[0]?.body).toContain("Command Approval");
    expect(shownNotifications[0]?.body).toContain("npm view eslint");
    expect(shownNotifications[0]?.body).not.toContain("```shell");
    expect(shownNotifications[0]?.body).not.toContain("Reply with");

    shownNotifications[0]?.instance.emitClick();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-2b",
      intent: approvalIntent(),
      onDecision,
      onShow,
    });
    shownNotifications[1]?.instance.emitAction(0);
    shownNotifications[1]?.instance.emitClick();

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenLastCalledWith("accept");
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("keeps the native approve action when a fallback prompt includes command details", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(true);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-fallback-command",
      intent: approvalIntent({
        body: [
          "Approve this action?",
          "Command:",
          "```shell",
          "npm view eslint",
          "```",
          "Reply with \"1\", \"2\", \"yes\", \"yes for this session\", \"no\", or use a button.",
        ].join("\n\n"),
      }),
      onDecision,
    });

    expect(shownNotifications[0]?.actions).toEqual([
      { type: "button", text: "Approve" },
    ]);
    expect(shownNotifications[0]?.body).toContain("npm view eslint");
    expect(shownNotifications[0]?.body).not.toContain("Approve this action?");
  });

  it("hides approve when approval details are truncated", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(true);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-long-command",
      intent: approvalIntent({
        body: [
          "Run command?",
          "Command:",
          "```shell",
          `npm run deploy -- --target production ${"x".repeat(260)} --dangerous-flag`,
          "```",
          "Reply with \"1\", \"2\", \"yes\", \"yes for this session\", \"no\", or use a button.",
        ].join("\n"),
      }),
      onDecision,
      onShow,
    });

    expect(shownNotifications[0]?.body).toMatch(/\.\.\.$/);
    expect(shownNotifications[0]?.body).not.toContain("--dangerous-flag");
    expect(shownNotifications[0]?.actions).toBeUndefined();

    shownNotifications[0]?.instance.emitAction(0);
    expect(onDecision).not.toHaveBeenCalled();
    expect(onDecision).not.toHaveBeenCalledWith("accept");
  });

  it("retains live notifications until the native notification resolves", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    const serviceWithLiveNotifications = service as unknown as {
      liveNotifications: Set<unknown>;
    };
    vi.spyOn(serviceWithActionButtons, "supportsActionButtons").mockReturnValue(true);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-live",
      intent: approvalIntent(),
      onDecision,
    });

    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(1);

    shownNotifications[0]?.instance.emitAction(0);
    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(0);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-click",
      intent: approvalIntent(),
      onDecision,
    });

    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(1);
    shownNotifications[1]?.instance.emitClick();
    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(0);
  });

  it("closes a live attention notification when its key is cleared", () => {
    const service = new DesktopNotificationService();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithLiveNotifications = service as unknown as {
      liveNotifications: Set<unknown>;
    };

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-clear",
      title: "Approval needed",
      body: "Please approve",
    });

    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(1);

    service.clearAttentionKey("codex:thread-1:req-clear");

    expect(serviceWithLiveNotifications.liveNotifications.size).toBe(0);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-clear",
      title: "Approval needed",
      body: "Please approve again",
    });

    expect(shownNotifications.at(-1)?.body).toBe("Please approve again");
  });

  it("focuses the relevant thread when clicking an attention notification", () => {
    const service = new DesktopNotificationService();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);

    service.notifyAttention({
      enabled: true,
      key: "codex:thread-1:req-input",
      title: "Input needed",
      body: "A turn needs your input.",
      onShow,
    });

    shownNotifications[0]?.instance.emitClick();

    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("falls back to a passive approval notification when action buttons are unsupported", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(false);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-3",
      intent: approvalIntent(),
      onDecision,
    });

    expect(shownNotifications[0]?.actions).toBeUndefined();
    shownNotifications[0]?.instance.emitAction(0);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps approval notifications passive when the intent lacks details", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);
    const serviceWithActionButtons = service as unknown as {
      supportsActionButtons: () => boolean;
    };
    vi.spyOn(
      serviceWithActionButtons,
      "supportsActionButtons",
    ).mockReturnValue(true);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-generic",
      intent: approvalIntent({
        body: [
          "Approve this action?",
          "Reply with \"1\", \"2\", \"yes\", \"yes for this session\", \"no\", or use a button.",
        ].join("\n\n"),
      }),
      onDecision,
      onShow,
    });

    expect(shownNotifications[0]?.actions).toBeUndefined();
    shownNotifications[0]?.instance.emitClick();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();

    shownNotifications[0]?.instance.emitAction(0);
    expect(onDecision).not.toHaveBeenCalled();
    expect(onDecision).not.toHaveBeenCalledWith("accept");
  });

  it("focuses the approval thread when clicking the notification body", () => {
    const service = new DesktopNotificationService();
    const onDecision = vi.fn();
    const onShow = vi.fn();
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false },
    ]);

    service.notifyApproval({
      enabled: true,
      key: "codex:thread-1:req-click-show",
      intent: approvalIntent(),
      onDecision,
      onShow,
    });

    shownNotifications[0]?.instance.emitClick();

    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();
  });
});
