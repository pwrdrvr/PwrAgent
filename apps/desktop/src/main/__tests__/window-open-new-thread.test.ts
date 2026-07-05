import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpenNewThread } from "../window-open-new-thread";
import { subscribersForChannel } from "../window-channels";
import { WINDOW_OPEN_NEW_THREAD_CHANNEL } from "../../shared/ipc";

const { getFocusedWindowMock, fromWebContentsMock } = vi.hoisted(() => ({
  getFocusedWindowMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock,
    fromWebContents: fromWebContentsMock,
  },
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(),
}));

describe("requestOpenNewThread", () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset();
    fromWebContentsMock.mockReset();
    vi.mocked(subscribersForChannel).mockReset();
  });

  it("sends to the focused subscribed main window", () => {
    const send = vi.fn();
    const focusedWebContents = { send } as unknown as WebContents;
    const focusedWindow = {
      isDestroyed: () => false,
      show: vi.fn(),
      webContents: focusedWebContents,
    };

    getFocusedWindowMock.mockReturnValue(focusedWindow);
    vi.mocked(subscribersForChannel).mockReturnValue([
      focusedWindow.webContents,
    ]);

    requestOpenNewThread();

    expect(subscribersForChannel).toHaveBeenCalledWith(
      WINDOW_OPEN_NEW_THREAD_CHANNEL,
    );
    expect(focusedWindow.show).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(WINDOW_OPEN_NEW_THREAD_CHANNEL);
  });

  it("falls back to another subscriber when a secondary window is focused", () => {
    const focusedWebContents = { send: vi.fn() } as unknown as WebContents;
    const focusedWindow = {
      isDestroyed: () => false,
      show: vi.fn(),
      webContents: focusedWebContents,
    };
    const fallbackSend = vi.fn();
    const fallbackContents = { send: fallbackSend } as unknown as WebContents;
    const fallbackWindow = {
      isDestroyed: () => false,
      show: vi.fn(),
    };

    getFocusedWindowMock.mockReturnValue(focusedWindow);
    vi.mocked(subscribersForChannel).mockReturnValue([fallbackContents]);
    fromWebContentsMock.mockReturnValue(fallbackWindow);

    requestOpenNewThread();

    expect(fallbackWindow.show).toHaveBeenCalledOnce();
    expect(fallbackSend).toHaveBeenCalledWith(WINDOW_OPEN_NEW_THREAD_CHANNEL);
  });

  it("no-ops when no window is subscribed", () => {
    getFocusedWindowMock.mockReturnValue(null);
    vi.mocked(subscribersForChannel).mockReturnValue([]);

    expect(() => requestOpenNewThread()).not.toThrow();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
  });
});
