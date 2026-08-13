import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const writeMock = vi.fn();
const writeTextMock = vi.fn();

vi.mock("electron", () => ({
  clipboard: {
    write: writeMock,
    writeText: writeTextMock,
  },
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
  const originalE2e = process.env.PWRAGENT_E2E;

  beforeEach(() => {
    handlers.clear();
    writeMock.mockReset();
    writeTextMock.mockReset();
    delete globalThis.__PWRAGENT_E2E_CLIPBOARD__;
    delete process.env.PWRAGENT_E2E;
  });

  afterEach(() => {
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
    expect(writeMock).toHaveBeenCalledWith({
      html: "<strong>rich text</strong>",
      text: "rich text",
    });
  });

  it("keeps clipboard writes in memory during E2E", async () => {
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
});
