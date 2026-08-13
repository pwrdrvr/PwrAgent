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

function writeText(text: string): void {
  if (process.env.PWRAGENT_E2E === "1") {
    globalThis.__PWRAGENT_E2E_CLIPBOARD__ = { text };
    return;
  }
  clipboard.writeText(text);
}

function writeRichText(payload: E2eClipboardSnapshot & { html: string }): void {
  if (process.env.PWRAGENT_E2E === "1") {
    globalThis.__PWRAGENT_E2E_CLIPBOARD__ = payload;
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
