import { BrowserWindow, Notification } from "electron";
import type {
  MessagingApprovalDecision,
  MessagingApprovalIntent,
} from "@pwragent/messaging-interface";
import { getMainLogger } from "../log";

const notificationLog = getMainLogger("pwragent:notifications");
const NATIVE_NOTIFICATION_BODY_MAX_LENGTH = 220;

type NativeNotificationAction = {
  text: string;
  run: () => void;
};

/**
 * Native attention/terminal notifications for unattended turns.
 *
 * Permission is intentionally NOT introspected here. Electron does not expose
 * a programmatic API for the OS-level notification grant on macOS/Windows
 * (see electron/electron#45570, closed "not planned"), and the renderer-side
 * Web Notification `permission` value is unreliable on macOS in both
 * directions (electron/electron#11221). So we emit unconditionally; the OS
 * silently drops if the user has denied notifications for this bundle, and
 * we surface that possibility in the Settings help copy instead of a
 * runtime banner that would lie roughly half the time.
 */
export class DesktopNotificationService {
  private readonly attentionKeys = new Set<string>();
  private readonly attentionNotifications = new Map<string, Set<Notification>>();
  private readonly liveNotifications = new Set<Notification>();

  clearAttentionKey(key: string): void {
    this.attentionKeys.delete(key);
    const notifications = this.attentionNotifications.get(key);
    if (!notifications) {
      return;
    }
    this.attentionNotifications.delete(key);
    for (const notification of notifications) {
      this.liveNotifications.delete(notification);
      try {
        notification.close();
      } catch (error) {
        notificationLog.warn("failed to close native notification", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  notifyAttention(params: {
    enabled: boolean;
    key: string;
    title: string;
    body: string;
  }): void {
    if (!params.enabled || this.attentionKeys.has(params.key)) {
      return;
    }
    if (!this.isAppInactive()) {
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    this.attentionKeys.add(params.key);
    this.show({
      attentionKey: params.key,
      title: params.title,
      body: params.body,
    });
  }

  notifyApproval(params: {
    enabled: boolean;
    key: string;
    intent: MessagingApprovalIntent;
    onDecision?: (decision: MessagingApprovalDecision) => void;
    onShow?: () => void;
  }): void {
    if (!params.enabled || this.attentionKeys.has(params.key)) {
      return;
    }
    if (!this.isAppInactive()) {
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }

    const nativeActions = nativeApprovalActions(params.intent, {
      onDecision: params.onDecision,
      onShow: params.onShow,
    });
    this.attentionKeys.add(params.key);
    this.show({
      attentionKey: params.key,
      title: "PwrAgent approval needed",
      body: nativeApprovalBody(params.intent),
      actions: nativeActions,
      onClick: params.onShow,
    });
  }

  notifyTerminal(params: {
    key?: string;
    enabled: boolean;
    title: string;
    body: string;
    onShow?: () => void;
  }): void {
    if (!params.enabled || (params.key && this.attentionKeys.has(params.key))) {
      return;
    }
    if (!this.isAppInactive()) {
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    if (params.key) {
      this.attentionKeys.add(params.key);
    }
    this.show({
      attentionKey: params.key,
      title: params.title,
      body: params.body,
      onClick: params.onShow,
    });
  }

  private supportsActionButtons(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
  }

  private isAppInactive(): boolean {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    if (windows.length === 0) {
      return true;
    }
    return windows.every((window) => window.isMinimized() || !window.isFocused());
  }

  private show(params: {
    attentionKey?: string;
    actions?: NativeNotificationAction[];
    onClick?: () => void;
    title: string;
    body: string;
  }): void {
    try {
      const actions =
        params.actions && params.actions.length > 0 && this.supportsActionButtons()
          ? params.actions
          : undefined;
      const notification = new Notification({
        title: params.title,
        body: params.body,
        ...(actions
          ? {
              actions: actions.map((action) => ({
                type: "button" as const,
                text: action.text,
              })),
            }
          : {}),
      });
      this.liveNotifications.add(notification);
      if (params.attentionKey) {
        let notifications = this.attentionNotifications.get(params.attentionKey);
        if (!notifications) {
          notifications = new Set<Notification>();
          this.attentionNotifications.set(params.attentionKey, notifications);
        }
        notifications.add(notification);
      }
      const cleanup = () => {
        this.liveNotifications.delete(notification);
        if (params.attentionKey) {
          const notifications = this.attentionNotifications.get(params.attentionKey);
          notifications?.delete(notification);
          if (notifications?.size === 0) {
            this.attentionNotifications.delete(params.attentionKey);
          }
        }
      };
      let handledAction = false;
      notification.on("click", () => {
        if (handledAction) {
          return;
        }
        cleanup();
        params.onClick?.();
      });
      notification.on("close", cleanup);
      if (actions) {
        let handled = false;
        notification.on("action", (event, deprecatedActionIndex) => {
          cleanup();
          if (handled) {
            return;
          }
          const actionIndex = notificationActionIndex(event, deprecatedActionIndex);
          const action = actions[actionIndex];
          if (!action) {
            return;
          }
          handled = true;
          handledAction = true;
          action.run();
        });
      }
      notification.show();
    } catch (error) {
      notificationLog.warn("failed to display native notification", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function nativeApprovalActions(
  intent: MessagingApprovalIntent,
  callbacks: {
    onDecision?: (decision: MessagingApprovalDecision) => void;
    onShow?: () => void;
  },
): NativeNotificationAction[] | undefined {
  const actions: NativeNotificationAction[] = [];
  const accept = intent.decisions.find((action) => action.decision === "accept");
  if (accept && callbacks.onDecision && nativeApprovalCanApproveInline(intent)) {
    actions.push({
      text: "Approve",
      run: () => callbacks.onDecision?.(accept.decision),
    });
  }
  return actions.length > 0 ? actions : undefined;
}

function nativeApprovalCanApproveInline(intent: MessagingApprovalIntent): boolean {
  return (
    nativeApprovalBodyLines(intent).length > 0 &&
    nativeApprovalBodyFullText(intent).length <= NATIVE_NOTIFICATION_BODY_MAX_LENGTH
  );
}

function nativeApprovalBody(intent: MessagingApprovalIntent): string {
  const next = nativeApprovalBodyFullText(intent);
  if (next.length <= NATIVE_NOTIFICATION_BODY_MAX_LENGTH) {
    return next;
  }
  return `${next.slice(0, NATIVE_NOTIFICATION_BODY_MAX_LENGTH - 3)}...`;
}

function nativeApprovalBodyFullText(intent: MessagingApprovalIntent): string {
  const body = nativeApprovalBodyLines(intent)
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
  return body ? `${intent.title}: ${body}` : intent.title;
}

function nativeApprovalBodyLines(intent: MessagingApprovalIntent): string[] {
  return intent.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Reply with "))
    .filter((line) => line !== "```shell" && line !== "```")
    .filter((line) => line !== "Approve this action?");
}

function notificationActionIndex(
  event: unknown,
  deprecatedActionIndex: unknown,
): number {
  const details = event as { actionIndex?: unknown } | undefined;
  if (typeof details?.actionIndex === "number") {
    return details.actionIndex;
  }
  return typeof deprecatedActionIndex === "number" ? deprecatedActionIndex : -1;
}

let service: DesktopNotificationService | undefined;

export function getDesktopNotificationService(): DesktopNotificationService {
  if (!service) {
    service = new DesktopNotificationService();
  }
  return service;
}
