import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const writeMock = vi.fn(async (_items: unknown[]) => {});
const writeTextMock = vi.fn(async (_text: string) => {});

class ClipboardItemMock {
  readonly items: Record<string, string>;

  constructor(items: Record<string, string>) {
    this.items = items;
  }
}

vi.mock("electron", () => ({
  clipboard: {
    write: writeMock,
    writeText: writeTextMock,
  },
  ClipboardItem: ClipboardItemMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

describe("clipboard ipc", () => {
  const originalCi = process.env.CI;
  const originalE2e = process.env.PWRAGENT_E2E;

  beforeEach(() => {
    handlers.clear();
    writeMock.mockReset();
    writeTextMock.mockReset();
    delete globalThis.__PWRAGENT_E2E_CLIPBOARD__;
    delete process.env.CI;
    delete process.env.PWRAGENT_E2E;
  });

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    if (originalE2e === undefined) {
      delete process.env.PWRAGENT_E2E;
    } else {
      process.env.PWRAGENT_E2E = originalE2e;
    }
    delete globalThis.__PWRAGENT_E2E_CLIPBOARD__;
  });

  it("writes text and rich text to the system clipboard outside E2E", async () => {
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const {
      CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
      CLIPBOARD_WRITE_TEXT_CHANNEL,
    } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();

    await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");
    await handlers.get(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL)?.({}, {
      html: "<strong>rich text</strong>",
      text: "rich text",
    });

    expect(writeTextMock).toHaveBeenCalledWith("plain text");
    expect(writeMock).toHaveBeenCalledWith([
      new ClipboardItemMock({
        "text/html": "<strong>rich text</strong>",
        "text/plain": "rich text",
      }),
    ]);
  });

  it("rejects the IPC call when the system clipboard write fails", async () => {
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const {
      CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
      CLIPBOARD_WRITE_TEXT_CHANNEL,
    } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();
    writeTextMock.mockRejectedValueOnce(new Error("pasteboard unavailable"));
    writeMock.mockRejectedValueOnce(new Error("pasteboard unavailable"));

    await expect(
      handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text"),
    ).rejects.toThrow("pasteboard unavailable");
    await expect(
      handlers.get(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL)?.({}, {
        html: "<strong>rich text</strong>",
        text: "rich text",
      }),
    ).rejects.toThrow("pasteboard unavailable");
  });

  it("keeps clipboard writes in memory during local E2E", async () => {
    process.env.PWRAGENT_E2E = "1";
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const {
      CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
      CLIPBOARD_WRITE_TEXT_CHANNEL,
    } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();

    await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");
    expect(globalThis.__PWRAGENT_E2E_CLIPBOARD__).toEqual({ text: "plain text" });

    await handlers.get(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL)?.({}, {
      html: "<strong>rich text</strong>",
      text: "rich text",
    });
    expect(globalThis.__PWRAGENT_E2E_CLIPBOARD__).toEqual({
      html: "<strong>rich text</strong>",
      text: "rich text",
    });
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("records clipboard writes in memory while exercising the system clipboard in CI", async () => {
    process.env.CI = "true";
    process.env.PWRAGENT_E2E = "1";
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const {
      CLIPBOARD_WRITE_RICH_TEXT_CHANNEL,
      CLIPBOARD_WRITE_TEXT_CHANNEL,
    } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();

    await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");
    await handlers.get(CLIPBOARD_WRITE_RICH_TEXT_CHANNEL)?.({}, {
      html: "<strong>rich text</strong>",
      text: "rich text",
    });

    expect(globalThis.__PWRAGENT_E2E_CLIPBOARD__).toEqual({
      html: "<strong>rich text</strong>",
      text: "rich text",
    });
    expect(writeTextMock).toHaveBeenCalledWith("plain text");
    expect(writeMock).toHaveBeenCalledWith([
      new ClipboardItemMock({
        "text/html": "<strong>rich text</strong>",
        "text/plain": "rich text",
      }),
    ]);
  });
});
