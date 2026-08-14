import { clipboard, ipcMain } from "electron";
import { CLIPBOARD_WRITE_TEXT_CHANNEL } from "../../shared/ipc";

export type E2eClipboardSnapshot = {
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
  const isCi = process.env.CI === "1" || process.env.CI === "true";
  return !isCi;
}

function writeText(text: string): void {
  if (shouldKeepE2eClipboardWriteInMemory({ text })) {
    return;
  }
  clipboard.writeText(text);
}

export function registerClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.handle(
    CLIPBOARD_WRITE_TEXT_CHANNEL,
    async (_event, text: unknown): Promise<void> => {
      if (typeof text !== "string") {
        throw new Error("clipboard:write-text requires a string payload");
      }
      writeText(text);
    },
  );
}

export function disposeClipboardIpcHandlers(): void {
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
}
