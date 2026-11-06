import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpenThreadMaintenance } from "../window-open-thread-maintenance";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";
import { WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL } from "../../shared/ipc";

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
  const window = {
    isDestroyed: () => false,
    show: vi.fn(),
    webContents: { send } as unknown as WebContents,
  };
  return { send, window };
}

describe("requestOpenThreadMaintenance", () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset();
    fromWebContentsMock.mockReset();
    vi.mocked(subscribersForChannel).mockReset();
    vi.mocked(isFederationWindowWebContents).mockReset();
  });

  it("opens the dialog in the focused local main window", () => {
    const local = makeWindow();
    getFocusedWindowMock.mockReturnValue(local.window);
    fromWebContentsMock.mockReturnValue(local.window);
    vi.mocked(subscribersForChannel).mockReturnValue([local.window.webContents]);
    vi.mocked(isFederationWindowWebContents).mockReturnValue(false);

    expect(requestOpenThreadMaintenance({ projectKey: "/src/harbor-web" })).toBe(true);

    expect(subscribersForChannel).toHaveBeenCalledWith(WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL);
    expect(local.window.show).toHaveBeenCalledOnce();
    expect(local.send).toHaveBeenCalledWith(WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL, { projectKey: "/src/harbor-web" });
  });

  it("falls back to a local window when a federation window is focused", () => {
    const local = makeWindow();
    const remote = makeWindow();
    getFocusedWindowMock.mockReturnValue(remote.window);
    fromWebContentsMock.mockReturnValue(local.window);
    vi.mocked(subscribersForChannel).mockReturnValue([local.window.webContents, remote.window.webContents]);
    vi.mocked(isFederationWindowWebContents).mockImplementation(
      (contents) => contents === remote.window.webContents,
    );

    expect(requestOpenThreadMaintenance()).toBe(true);

    expect(remote.send).not.toHaveBeenCalled();
    expect(local.send).toHaveBeenCalledWith(WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL, {});
  });

  it("does nothing when no local main window is listening", () => {
    vi.mocked(subscribersForChannel).mockReturnValue([]);

    expect(requestOpenThreadMaintenance()).toBe(false);
  });
});
