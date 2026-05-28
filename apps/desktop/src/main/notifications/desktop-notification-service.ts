import { BrowserWindow, Notification } from "electron";
import { getMainLogger } from "../log";

const notificationLog = getMainLogger("pwragent:notifications");

export type DesktopNotificationPermissionState =
  | "default"
  | "granted"
  | "denied"
  | "unsupported";

export class DesktopNotificationService {
  private readonly attentionKeys = new Set<string>();

  readPermission(): DesktopNotificationPermissionState {
    if (!Notification.isSupported()) {
      return "unsupported";
    }
    // Electron's main-process Notification API has native support/show only.
    // Permission prompting and denied/readback state are handled by the renderer
    // Web Notification API, which maps to the app's OS notification permission.
    return "granted";
  }

  async requestPermission(): Promise<DesktopNotificationPermissionState> {
    if (!Notification.isSupported()) {
      return "unsupported";
    }
    return "granted";
  }

  clearAttentionKey(key: string): void {
    this.attentionKeys.delete(key);
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
    this.show(params.title, params.body);
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
    this.show(params.title, params.body);
  }

  private isAppInactive(): boolean {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    if (windows.length === 0) {
      return true;
    }
    return windows.every((window) => window.isMinimized() || !window.isFocused());
  }

  private show(title: string, body: string): void {
    try {
      new Notification({
        title,
        body,
      }).show();
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
