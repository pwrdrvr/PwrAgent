import { BrowserWindow, Notification } from "electron";
import { getMainLogger } from "../log";

const notificationLog = getMainLogger("pwragent:notifications");
const APPROVE_ACTION_INDEX = 0;

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
  private readonly liveNotifications = new Set<Notification>();

  clearAttentionKey(key: string): void {
    this.attentionKeys.delete(key);
  }

  notifyAttention(params: {
    enabled: boolean;
    key: string;
    title: string;
    body: string;
    onApprove?: () => void;
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
      title: params.title,
      body: params.body,
      onApprove: params.onApprove,
    });
  }

  notifyTerminal(params: {
    enabled: boolean;
    title: string;
    body: string;
  }): void {
    if (!params.enabled) {
      return;
    }
    if (!this.isAppInactive()) {
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    this.show({
      title: params.title,
      body: params.body,
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
    title: string;
    body: string;
    onApprove?: () => void;
  }): void {
    try {
      const notification = new Notification({
        title: params.title,
        body: params.body,
        ...(params.onApprove && this.supportsActionButtons()
          ? {
              actions: [{ type: "button", text: "Approve" }],
            }
          : {}),
      });
      this.liveNotifications.add(notification);
      const cleanup = () => {
        this.liveNotifications.delete(notification);
      };
      notification.on("click", cleanup);
      notification.on("close", cleanup);
      if (params.onApprove && this.supportsActionButtons()) {
        let handled = false;
        notification.on("action", (_event, actionIndex) => {
          cleanup();
          if (handled || actionIndex !== APPROVE_ACTION_INDEX) {
            return;
          }
          handled = true;
          params.onApprove?.();
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

let service: DesktopNotificationService | undefined;

export function getDesktopNotificationService(): DesktopNotificationService {
  if (!service) {
    service = new DesktopNotificationService();
  }
  return service;
}
