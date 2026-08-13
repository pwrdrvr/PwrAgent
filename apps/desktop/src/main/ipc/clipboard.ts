import { clipboard, ipcMain } from "electron";
import {
  CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
} from "../../shared/ipc";

export type E2eClipboardSnapshot = {
  html?: string;
  text: string;
};

declare global {
  var __PWRAGENT_E2E_CLIPBOARD__: E2eClipboardSnapshot | undefined;
}

function shouldKeepE2eClipboardWriteInMemory(
  snapshot: E2eClipboardSnapshot,
): boolean {
  if (process.env.PWRAGENT_E2E !== "1") {
    return false;
  }
  globalThis.__PWRAGENT_E2E_CLIPBOARD__ = snapshot;
  // Local Electron E2E shares the operator's OS clipboard, so keep writes in
  // memory. CI runs on an isolated machine and may exercise the native bridge.
  const isCi = process.env.CI === "1" || process.env.CI === "true";
  return !isCi;
}

function writeText(text: string): void {
  if (shouldKeepE2eClipboardWriteInMemory({ text })) {
    return;
  }
  clipboard.writeText(text);
}

function writeRichText(payload: E2eClipboardSnapshot & { html: string }): void {
  if (shouldKeepE2eClipboardWriteInMemory(payload)) {
    return;
  }
  clipboard.write({ text: payload.text, html: payload.html });
}

export function registerClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
  ipcMain.handle(
    CLIPBOARD_WRITE_TEXT_CHANNEL,
    async (_event, text: unknown): Promise<void> => {
      if (typeof text !== "string") {
        throw new Error("clipboard:write-text requires a string payload");
      }
      writeText(text);
    },
  );
  ipcMain.handle(
    CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
    async (_event, payload: unknown): Promise<void> => {
      const richText = payload as { text?: unknown; html?: unknown } | undefined;
      if (
        typeof richText?.text !== "string"
        || typeof richText?.html !== "string"
      ) {
        throw new Error(
          "clipboard:write-rich-text requires { text, html } string payload",
        );
      }
      writeRichText({ text: richText.text, html: richText.html });
    },
  );
}

export function disposeClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
}
