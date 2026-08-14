import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const writeTextMock = vi.fn();

vi.mock("electron", () => ({
  clipboard: {
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
  const originalCi = process.env.CI;
  const originalE2e = process.env.PWRAGENT_E2E;

  beforeEach(() => {
    handlers.clear();
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

  it("writes to the system clipboard outside E2E", async () => {
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const { CLIPBOARD_WRITE_TEXT_CHANNEL } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();

    await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");

    expect(writeTextMock).toHaveBeenCalledWith("plain text");
  });

  it("keeps local E2E writes off the system clipboard", async () => {
    process.env.PWRAGENT_E2E = "1";
    const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
    const { CLIPBOARD_WRITE_TEXT_CHANNEL } = await import("../../shared/ipc");
    registerClipboardIpcHandlers();

    await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");

    expect(globalThis.__PWRAGENT_E2E_CLIPBOARD__).toEqual({ text: "plain text" });
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it.each(["1", "true"])(
    "records clipboard writes while exercising the system clipboard with CI=%s",
    async (CI) => {
      process.env.CI = CI;
      process.env.PWRAGENT_E2E = "1";
      const { registerClipboardIpcHandlers } = await import("../ipc/clipboard");
      const { CLIPBOARD_WRITE_TEXT_CHANNEL } = await import("../../shared/ipc");
      registerClipboardIpcHandlers();

      await handlers.get(CLIPBOARD_WRITE_TEXT_CHANNEL)?.({}, "plain text");

      expect(globalThis.__PWRAGENT_E2E_CLIPBOARD__).toEqual({ text: "plain text" });
      expect(writeTextMock).toHaveBeenCalledWith("plain text");
    },
  );
});
