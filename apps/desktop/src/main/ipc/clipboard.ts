import { clipboard, ipcMain } from "electron";
import {
  CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
} from "../../shared/ipc";

export function registerClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
  ipcMain.handle(
    CLIPBOARD_WRITE_TEXT_CHANNEL,
    async (_event, text: unknown): Promise<void> => {
      if (typeof text !== "string") {
        throw new Error("clipboard:write-text requires a string payload");
      }
      clipboard.writeText(text);
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
      clipboard.write({ text: richText.text, html: richText.html });
    },
  );
}

export function disposeClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
}
