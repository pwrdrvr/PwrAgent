import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpenMainView } from "../window-open-main-view";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";
import { WINDOW_OPEN_MAIN_VIEW_CHANNEL } from "../../shared/ipc";

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

vi.mock("../window", () => ({
  isFederationWindowWebContents: vi.fn(),
}));

function makeWindow(): {
  send: ReturnType<typeof vi.fn>;
  window: { isDestroyed: () => boolean; show: ReturnType<typeof vi.fn>; webContents: WebContents };
} {
  const send = vi.fn();
  return {
    send,
    window: {
      isDestroyed: () => false,
      show: vi.fn(),
      webContents: { send } as unknown as WebContents,
    },
  };
}

describe("requestOpenMainView", () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset();
    fromWebContentsMock.mockReset();
    vi.mocked(subscribersForChannel).mockReset();
    vi.mocked(isFederationWindowWebContents).mockReset();
  });

  it.each(["search", "automations"] as const)(
    "sends %s to the focused local main window",
    (view) => {
      const local = makeWindow();
      getFocusedWindowMock.mockReturnValue(local.window);
      vi.mocked(subscribersForChannel).mockReturnValue([local.window.webContents]);
      vi.mocked(isFederationWindowWebContents).mockReturnValue(false);

      requestOpenMainView(view);

      expect(subscribersForChannel).toHaveBeenCalledWith(WINDOW_OPEN_MAIN_VIEW_CHANNEL);
      expect(local.window.show).toHaveBeenCalledOnce();
      expect(local.send).toHaveBeenCalledWith(WINDOW_OPEN_MAIN_VIEW_CHANNEL, view);
    },
  );

  it("searches in a focused federation window, which has its own search", () => {
    const local = makeWindow();
    const remote = makeWindow();
    getFocusedWindowMock.mockReturnValue(remote.window);
    vi.mocked(subscribersForChannel).mockReturnValue([
      local.window.webContents,
      remote.window.webContents,
    ]);
    vi.mocked(isFederationWindowWebContents).mockImplementation(
      (contents) => contents === remote.window.webContents,
    );

    requestOpenMainView("search");

    expect(remote.send).toHaveBeenCalledWith(WINDOW_OPEN_MAIN_VIEW_CHANNEL, "search");
    expect(local.send).not.toHaveBeenCalled();
  });

  it("opens Automations in a local window even while a federation window is focused", () => {
    const local = makeWindow();
    const remote = makeWindow();
    getFocusedWindowMock.mockReturnValue(remote.window);
    vi.mocked(subscribersForChannel).mockReturnValue([
      remote.window.webContents,
      local.window.webContents,
    ]);
    vi.mocked(isFederationWindowWebContents).mockImplementation(
      (contents) => contents === remote.window.webContents,
    );
    fromWebContentsMock.mockReturnValue(local.window);

    requestOpenMainView("automations");

    expect(remote.send).not.toHaveBeenCalled();
    expect(local.window.show).toHaveBeenCalledOnce();
    expect(local.send).toHaveBeenCalledWith(WINDOW_OPEN_MAIN_VIEW_CHANNEL, "automations");
  });

  it("no-ops when no window is subscribed", () => {
    getFocusedWindowMock.mockReturnValue(null);
    vi.mocked(subscribersForChannel).mockReturnValue([]);

    expect(() => requestOpenMainView("search")).not.toThrow();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
  });
});
