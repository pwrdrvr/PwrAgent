import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>; webContents: { id: number }; on: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>; isAlwaysOnTop: () => boolean; isDestroyed: () => boolean;
  }>,
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { id: state.windows.length + 1 };
    on = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    private topmost = false;
    setAlwaysOnTop = vi.fn((enabled: boolean) => { this.topmost = enabled; });
    isAlwaysOnTop = () => this.topmost;
    isDestroyed = () => false;
    constructor(public options: Record<string, unknown>) { state.windows.push(this); }
  },
}));
vi.mock("../window", () => ({
  applyWindowSecurityHardening: vi.fn(), getPreloadPath: () => "/fixture/preload.js",
  getRendererEntry: () => ({ kind: "file", value: "/fixture/index.html" }),
}));
vi.mock("../window-channels", () => ({ WINDOW_KIND_FEDERATION_ACTIVITY: "federation-activity", registerWindowChannels: vi.fn() }));
vi.mock("../settings/appearance-bootstrap", () => ({ readBootstrapAppearance: () => ({}), themedWindowAdditionalArguments: () => [] }));
vi.mock("../native-appearance", () => ({ themedWindowBackgroundColor: () => "theme-background" }));
vi.mock("../auxiliary-window-chrome", () => ({
  auxiliaryWindowChromeOptions: () => ({ titleBarStyle: "hiddenInset" }),
  hideAuxiliaryWindowMenuBar: vi.fn(), registerAuxiliaryWindowTitle: vi.fn(),
  showAndFocusAuxiliaryWindow: vi.fn(), showAuxiliaryWindowWhenReady: vi.fn(),
}));
vi.mock("../window-placement", () => ({ placementForSourceDisplay: () => ({}), positionWindowForSourceDisplay: vi.fn() }));

beforeEach(() => { state.windows.length = 0; vi.resetModules(); });

describe("Federation Activity native window", () => {
  it("creates one independent secure themed window and focuses it on repeated open", async () => {
    const { showFederationActivityWindow } = await import("../federation-activity-window");
    const { showAndFocusAuxiliaryWindow } = await import("../auxiliary-window-chrome");
    const { registerWindowChannels } = await import("../window-channels");
    showFederationActivityWindow();
    showFederationActivityWindow();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].options).toMatchObject({
      title: "Federation Activity", width: 760, height: 620, show: false,
      backgroundColor: "theme-background", titleBarStyle: "hiddenInset",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(state.windows[0].options).not.toHaveProperty("parent");
    expect(state.windows[0].loadFile).toHaveBeenCalledWith("/fixture/index.html", { hash: "federation-activity" });
    expect(showAndFocusAuxiliaryWindow).toHaveBeenCalledWith(state.windows[0]);
    expect(registerWindowChannels).toHaveBeenCalledWith(state.windows[0], "federation-activity", ["appearance:changed"]);
    const closed = state.windows[0].on.mock.calls.find(([name]) => name === "closed")![1];
    closed();
    showFederationActivityWindow();
    expect(state.windows).toHaveLength(2);
  });

  it("only lets the activity renderer change its own topmost state", async () => {
    const { showFederationActivityWindow, setFederationActivityTopmost } = await import("../federation-activity-window");
    expect(() => setFederationActivityTopmost(1, true)).toThrow("not the caller");
    showFederationActivityWindow();
    expect(() => setFederationActivityTopmost(999, true)).toThrow("not the caller");
    expect(setFederationActivityTopmost(1, true)).toBe(true);
    expect(setFederationActivityTopmost(1, false)).toBe(false);
    expect(state.windows[0].setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
  });
});
