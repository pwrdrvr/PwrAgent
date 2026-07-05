import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOW_SHOW_THREAD_CHANNEL } from "../../shared/ipc";
import { requestShowThread } from "../window-show-thread";
import { subscribersForChannel } from "../window-channels";

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

describe("requestShowThread", () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset();
    fromWebContentsMock.mockReset();
    vi.mocked(subscribersForChannel).mockReset();
  });

  it("sends to the focused subscribed main window", () => {
    const request = { backend: "codex" as const, threadId: "thread-1" };
    const send = vi.fn();
    const focusedWebContents = { send } as unknown as WebContents;
    const focusedWindow = {
      focus: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      webContents: focusedWebContents,
    };

    getFocusedWindowMock.mockReturnValue(focusedWindow);
    vi.mocked(subscribersForChannel).mockReturnValue([
      focusedWindow.webContents,
    ]);

    requestShowThread(request);

    expect(subscribersForChannel).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
    );
    expect(focusedWindow.show).toHaveBeenCalledOnce();
    expect(focusedWindow.focus).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(WINDOW_SHOW_THREAD_CHANNEL, request);
  });

  it("restores a minimized fallback subscriber", () => {
    const request = { backend: "codex" as const, threadId: "thread-2" };
    const fallbackSend = vi.fn();
    const fallbackContents = { send: fallbackSend } as unknown as WebContents;
    const fallbackWindow = {
      focus: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
    };

    getFocusedWindowMock.mockReturnValue(null);
    vi.mocked(subscribersForChannel).mockReturnValue([fallbackContents]);
    fromWebContentsMock.mockReturnValue(fallbackWindow);

    requestShowThread(request);

    expect(fallbackWindow.restore).toHaveBeenCalledOnce();
    expect(fallbackWindow.show).toHaveBeenCalledOnce();
    expect(fallbackWindow.focus).toHaveBeenCalledOnce();
    expect(fallbackSend).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
      request,
    );
  });

  it("no-ops when no window is subscribed", () => {
    getFocusedWindowMock.mockReturnValue(null);
    vi.mocked(subscribersForChannel).mockReturnValue([]);

    expect(() =>
      requestShowThread({ backend: "codex", threadId: "thread-3" }),
    ).not.toThrow();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
  });
});
