import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_MENTION_SOURCES_CHANGED_EVENT_CHANNEL } from "../../shared/ipc";

const mocks = vi.hoisted(() => {
  const windows: Array<{
    isDestroyed: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    webContents: { id: number };
  }> = [];
  const BrowserWindow = vi.fn(function BrowserWindowMock(
    this: unknown,
    _options: unknown,
  ) {
    const window = {
      isDestroyed: vi.fn(() => false),
      loadFile: vi.fn(async () => undefined),
      on: vi.fn(),
      webContents: { id: windows.length + 1 },
    };
    windows.push(window);
    return window;
  });
  return {
    BrowserWindow,
    registerWindowChannels: vi.fn(),
    windows,
  };
});

vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: vi.fn() }),
}));
vi.mock("../window", () => ({
  applyWindowSecurityHardening: vi.fn(),
  getPreloadPath: () => "/preload.js",
  getRendererEntry: () => ({ kind: "file", value: "/renderer.html" }),
}));
vi.mock("../window-channels", () => ({
  WINDOW_KIND_STAR_MAP: "star-map",
  registerWindowChannels: mocks.registerWindowChannels,
}));
vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
  themedWindowAdditionalArguments: () => ["--appearance=dark"],
}));
vi.mock("../native-appearance", () => ({
  themedWindowBackgroundColor: () => "#000000",
}));
vi.mock("../auxiliary-window-chrome", () => ({
  auxiliaryWindowChromeOptions: () => ({ frame: true }),
  hideAuxiliaryWindowMenuBar: vi.fn(),
  registerAuxiliaryWindowTitle: vi.fn(),
  showAndFocusAuxiliaryWindow: vi.fn(),
  showAuxiliaryWindowWhenReady: vi.fn(),
}));
vi.mock("../window-placement", () => ({
  placementForSourceDisplay: () => ({ x: 10, y: 20 }),
  positionWindowForSourceDisplay: vi.fn(),
}));
vi.mock("../window-fullscreen-sync", () => ({
  attachWindowFullscreenSync: vi.fn(),
}));

describe("star map window", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.BrowserWindow.mockClear();
    mocks.registerWindowChannels.mockClear();
    mocks.windows.length = 0;
  });

  it("subscribes to mention-source changes from other windows", async () => {
    const { showStarMapWindow } = await import("../star-map-window");

    showStarMapWindow();

    expect(mocks.registerWindowChannels).toHaveBeenCalledWith(
      mocks.windows[0],
      "star-map",
      expect.arrayContaining([
        NAVIGATION_MENTION_SOURCES_CHANGED_EVENT_CHANNEL,
      ]),
    );
  });
});
