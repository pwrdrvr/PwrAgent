import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL } from "../../shared/ipc";
import { requestCopyLocalDiagnosticsInfo } from "../window-copy-local-diagnostics-info";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";

const { getFocusedWindowMock } = vi.hoisted(() => ({
  getFocusedWindowMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock,
  },
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(),
}));

vi.mock("../window", () => ({
  isFederationWindowWebContents: vi.fn(),
}));

describe("requestCopyLocalDiagnosticsInfo", () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset();
    vi.mocked(subscribersForChannel).mockReset();
    vi.mocked(isFederationWindowWebContents).mockReset();
  });

  it("sends the request to a focused federation window", () => {
    const send = vi.fn();
    const focusedWebContents = { send } as unknown as WebContents;
    getFocusedWindowMock.mockReturnValue({
      isDestroyed: () => false,
      webContents: focusedWebContents,
    });
    vi.mocked(subscribersForChannel).mockReturnValue([focusedWebContents]);
    vi.mocked(isFederationWindowWebContents).mockReturnValue(true);

    requestCopyLocalDiagnosticsInfo();

    expect(send).toHaveBeenCalledWith(
      WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL,
    );
  });

  it("prefers a local subscriber when no subscribed window is focused", () => {
    const remoteSend = vi.fn();
    const remoteWebContents = { send: remoteSend } as unknown as WebContents;
    const localSend = vi.fn();
    const localWebContents = { send: localSend } as unknown as WebContents;
    getFocusedWindowMock.mockReturnValue(null);
    vi.mocked(subscribersForChannel).mockReturnValue([
      remoteWebContents,
      localWebContents,
    ]);
    vi.mocked(isFederationWindowWebContents).mockImplementation(
      (webContents) => webContents === remoteWebContents,
    );

    requestCopyLocalDiagnosticsInfo();

    expect(localSend).toHaveBeenCalledWith(
      WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL,
    );
    expect(remoteSend).not.toHaveBeenCalled();
  });
});
