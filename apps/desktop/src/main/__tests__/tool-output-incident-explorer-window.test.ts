import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windows: Array<{
    isDestroyed: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    webContents: object;
  }> = [];
  const BrowserWindow = vi.fn(function BrowserWindowMock(
    this: unknown,
    _options: unknown,
  ) {
    const window = {
      isDestroyed: vi.fn(() => false),
      loadFile: vi.fn(async () => undefined),
      on: vi.fn(),
      webContents: {},
    };
    windows.push(window);
    return window;
  });
  return {
    applyWindowSecurityHardening: vi.fn(),
    BrowserWindow,
    registerWindowChannels: vi.fn(),
    showAndFocusAuxiliaryWindow: vi.fn(),
    windows,
  };
});

vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: vi.fn() }),
}));
vi.mock("../window", () => ({
  applyWindowSecurityHardening: mocks.applyWindowSecurityHardening,
  getPreloadPath: () => "/preload.js",
  getRendererEntry: () => ({ kind: "file", value: "/renderer.html" }),
}));
vi.mock("../window-channels", () => ({
  WINDOW_KIND_TOOL_OUTPUT_INCIDENT_EXPLORER: "tool-output-incident-explorer",
  registerWindowChannels: mocks.registerWindowChannels,
}));
vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
  themedWindowAdditionalArguments: () => ["--appearance=dark"],
  themedWindowBackgroundColor: () => "#000000",
}));
vi.mock("../auxiliary-window-chrome", () => ({
  auxiliaryWindowChromeOptions: () => ({ frame: true }),
  hideAuxiliaryWindowMenuBar: vi.fn(),
  registerAuxiliaryWindowTitle: vi.fn(),
  showAndFocusAuxiliaryWindow: mocks.showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady: vi.fn(),
}));
vi.mock("../window-placement", () => ({
  placementForSourceDisplay: () => ({ x: 10, y: 20 }),
  positionWindowForSourceDisplay: vi.fn(),
}));

describe("tool-output incident explorer window", () => {
  beforeEach(() => {
    mocks.BrowserWindow.mockClear();
    mocks.windows.length = 0;
    mocks.applyWindowSecurityHardening.mockClear();
    mocks.registerWindowChannels.mockClear();
    mocks.showAndFocusAuxiliaryWindow.mockClear();
  });

  it("creates one hardened inspection-only window per thread", async () => {
    const { showToolOutputIncidentExplorerWindow } = await import(
      "../tool-output-incident-explorer-window"
    );
    const request = {
      backend: "codex" as const,
      threadId: "thread-1",
      title: "Noisy work",
    };
    showToolOutputIncidentExplorerWindow(request);
    showToolOutputIncidentExplorerWindow(request);

    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(1);
    expect(mocks.BrowserWindow.mock.calls[0]?.[0]).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(mocks.applyWindowSecurityHardening).toHaveBeenCalledOnce();
    expect(mocks.registerWindowChannels).toHaveBeenCalledWith(
      mocks.windows[0],
      "tool-output-incident-explorer",
      expect.any(Array),
    );
    expect(mocks.windows[0]?.loadFile).toHaveBeenCalledWith(
      "/renderer.html",
      {
        hash: "tool-output-incidents/codex/thread-1/Noisy%20work",
      },
    );
    expect(mocks.showAndFocusAuxiliaryWindow).toHaveBeenCalledOnce();
  });
});
