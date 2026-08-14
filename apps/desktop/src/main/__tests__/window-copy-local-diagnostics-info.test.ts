import { beforeEach, describe, expect, it, vi } from "vitest";

const getFocusedWindow = vi.hoisted(() => vi.fn());
const subscribersForChannel = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow },
}));

vi.mock("../window-channels", () => ({ subscribersForChannel }));

describe("requestCopyLocalDiagnosticsInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the request to the focused main-window subscriber", async () => {
    const focusedWebContents = { send: vi.fn() };
    getFocusedWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: focusedWebContents,
    });
    subscribersForChannel.mockReturnValue([focusedWebContents]);

    const { requestCopyLocalDiagnosticsInfo } = await import(
      "../window-copy-local-diagnostics-info"
    );
    requestCopyLocalDiagnosticsInfo();

    expect(focusedWebContents.send).toHaveBeenCalledWith(
      "window:copy-local-diagnostics-info",
    );
  });

  it("falls back to an available main-window subscriber", async () => {
    const fallback = { send: vi.fn() };
    getFocusedWindow.mockReturnValue(undefined);
    subscribersForChannel.mockReturnValue([fallback]);

    const { requestCopyLocalDiagnosticsInfo } = await import(
      "../window-copy-local-diagnostics-info"
    );
    requestCopyLocalDiagnosticsInfo();

    expect(fallback.send).toHaveBeenCalledWith(
      "window:copy-local-diagnostics-info",
    );
  });
});
