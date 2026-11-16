import { clipboard, ClipboardItem, ipcMain, webContents } from "electron";
import {
  PASTE_WITHOUT_FORMATTING_CHANNEL,
  PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL,
} from "../../../shared/plain-text-paste";
import {
  CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
  TRANSCRIPT_IMAGE_READ_CHANNEL,
} from "../../../shared/ipc";
import { readTranscriptImageForRenderer } from "../transcript-image-protocol";
import { getMainLogger } from "../../log";

const clipboardLog = getMainLogger("pwragent:clipboard");

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

async function writeText(text: string): Promise<void> {
  if (shouldKeepE2eClipboardWriteInMemory({ text })) {
    return;
  }
  await clipboard.writeText(text);
}

async function writeRichText(
  payload: E2eClipboardSnapshot & { html: string },
): Promise<void> {
  if (shouldKeepE2eClipboardWriteInMemory(payload)) {
    return;
  }
  // One item carrying both flavors: Electron commits the entries of a single
  // write() atomically, so a paste target never sees HTML without its text.
  await clipboard.write([
    new ClipboardItem({ "text/plain": payload.text, "text/html": payload.html }),
  ]);
}

export function registerClipboardIpcHandlers(): void {
  ipcMain.removeAllListeners(PASTE_WITHOUT_FORMATTING_CHANNEL);
  ipcMain.on(PASTE_WITHOUT_FORMATTING_CHANNEL, (event) => {
    if (event.sender === webContents.getFocusedWebContents()) {
      void requestPasteWithoutFormatting();
    }
  });
  ipcMain.removeAllListeners(PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL);
  ipcMain.on(PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL, (event) => {
    if (event.sender === webContents.getFocusedWebContents()) {
      event.sender.pasteAndMatchStyle();
    }
  });
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
  ipcMain.removeHandler(TRANSCRIPT_IMAGE_READ_CHANNEL);
  ipcMain.handle(
    CLIPBOARD_WRITE_TEXT_CHANNEL,
    async (_event, text: unknown): Promise<void> => {
      if (typeof text !== "string") {
        throw new Error("clipboard:write-text requires a string payload");
      }
      await writeText(text);
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
      await writeRichText({ text: richText.text, html: richText.html });
    },
  );
  ipcMain.handle(TRANSCRIPT_IMAGE_READ_CHANNEL, async (_event, url: unknown) => {
    if (typeof url !== "string") throw new Error("Transcript image URL is required");
    return await readTranscriptImageForRenderer(url);
  });
}

export function disposeClipboardIpcHandlers(): void {
  ipcMain.removeAllListeners(PASTE_WITHOUT_FORMATTING_CHANNEL);
  ipcMain.removeAllListeners(PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_TEXT_CHANNEL);
  ipcMain.removeHandler(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL);
  ipcMain.removeHandler(TRANSCRIPT_IMAGE_READ_CHANNEL);
}

export async function requestPasteWithoutFormatting(): Promise<void> {
  const target = webContents.getFocusedWebContents();
  if (!target) return;
  try {
    const text = process.env.PWRAGENT_E2E === "1" && globalThis.__PWRAGENT_E2E_CLIPBOARD__
      ? globalThis.__PWRAGENT_E2E_CLIPBOARD__.text
      : await clipboard.readText();
    if (target.isDestroyed() || target !== webContents.getFocusedWebContents()) return;
    target.send(PASTE_WITHOUT_FORMATTING_CHANNEL, text);
  } catch (error) {
    clipboardLog.warn("Paste Without Formatting failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
