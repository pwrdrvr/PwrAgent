import { beforeEach, describe, expect, it, vi } from "vitest";

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
    applyWindowSecurityHardening: vi.fn(),
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
  applyWindowSecurityHardening: mocks.applyWindowSecurityHardening,
  getPreloadPath: () => "/preload.js",
  getRendererEntry: () => ({ kind: "file", value: "/renderer.html" }),
}));
vi.mock("../window-channels", () => ({
  WINDOW_KIND_SUB_AGENT_TRANSCRIPT: "sub-agent-transcript",
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

describe("sub-agent transcript window", () => {
  beforeEach(() => {
    mocks.BrowserWindow.mockClear();
    mocks.windows.length = 0;
    mocks.applyWindowSecurityHardening.mockClear();
    mocks.registerWindowChannels.mockClear();
  });

  it("routes a peer child to its owner without colliding with a local child id", async () => {
    const { showSubAgentTranscriptWindow } = await import(
      "../subagent-transcript-window"
    );
    showSubAgentTranscriptWindow({
      backend: "codex",
      threadId: "child-1",
      title: "Local child",
    });
    showSubAgentTranscriptWindow({
      backend: "codex",
      federationTarget: { instanceId: "peer-instance", scope: "remote" },
      threadId: "child-1",
      title: "Peer child",
    });

    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(2);
    expect(mocks.windows[0]?.loadFile).toHaveBeenCalledWith(
      "/renderer.html",
      { hash: "sub-agent/codex/child-1/Local%20child" },
    );
    expect(mocks.windows[1]?.loadFile).toHaveBeenCalledWith(
      "/renderer.html",
      { hash: "sub-agent/codex/child-1/Peer%20child/peer-instance" },
    );
  });
});
