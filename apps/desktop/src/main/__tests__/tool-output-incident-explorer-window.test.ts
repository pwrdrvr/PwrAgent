import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windows: Array<{
    isDestroyed: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    webContents: {
      id: number;
      isDestroyed: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const BrowserWindow = vi.fn(function BrowserWindowMock(
    this: unknown,
    _options: unknown,
  ) {
    const window = {
      isDestroyed: vi.fn(() => false),
      loadFile: vi.fn(async () => undefined),
      on: vi.fn(),
      webContents: {
        id: windows.length + 1,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    };
    windows.push(window);
    return window;
  });
  return {
    applyWindowSecurityHardening: vi.fn(),
    BrowserWindow,
    registerWindowChannels: vi.fn(),
    showAndFocusAuxiliaryWindow: vi.fn(),
    requestShowThread: vi.fn(),
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
vi.mock("../window-show-thread", () => ({
  requestShowThread: mocks.requestShowThread,
}));

describe("tool-output incident explorer window", () => {
  beforeEach(() => {
    /* The module keeps its open-window and owner maps in module scope, and
       clearing `mocks.windows` restarts web-contents id allocation at 1. Reset
       the module too, or a later test inherits an earlier test's entries under
       ids that have since been handed to a different window. */
    vi.resetModules();
    mocks.BrowserWindow.mockClear();
    mocks.windows.length = 0;
    mocks.applyWindowSecurityHardening.mockClear();
    mocks.registerWindowChannels.mockClear();
    mocks.showAndFocusAuxiliaryWindow.mockClear();
    mocks.requestShowThread.mockClear();
  });

  it("creates one hardened inspection-only window per thread", async () => {
    const { showToolOutputIncidentExplorerWindow } = await import(
      "../tool-output-incident-explorer-window"
    );
    const request = {
      backend: "codex" as const,
      threadId: "thread-1",
      title: "Noisy work",
      projectLabel: "PwrAgent",
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
        hash: "tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent/",
      },
    );
    expect(mocks.showAndFocusAuxiliaryWindow).toHaveBeenCalledOnce();
    expect(mocks.windows[0]?.webContents.send).toHaveBeenCalledWith(
      "tool-output-incident-explorer:refresh",
      request,
    );
  });

  it("names the owning instance in the route only for a peer's thread", async () => {
    /* The lens segment sits between them and is always emitted, so the owner
       keeps a fixed position whether or not a lens was asked for. */
    const { showToolOutputIncidentExplorerWindow } = await import(
      "../tool-output-incident-explorer-window"
    );
    showToolOutputIncidentExplorerWindow({
      backend: "codex" as const,
      federationTarget: { instanceId: "peer-instance", scope: "remote" },
      projectLabel: "PwrAgent",
      threadId: "thread-2",
      title: "Peer work",
    });

    expect(mocks.windows[0]?.loadFile).toHaveBeenCalledWith(
      "/renderer.html",
      {
        hash:
          "tool-output-incidents/codex/thread-2/Peer%20work/PwrAgent//peer-instance",
      },
    );
  });

  it("carries the requested lens into a window it has to create", async () => {
    /* The refresh event only reaches a window that already exists. A first
       click on "Token Miser Savings" creates the window, and the renderer's
       own opening choice reads accounting that has a lookback the durable
       gate records outlive. */
    const { showToolOutputIncidentExplorerWindow } = await import(
      "../tool-output-incident-explorer-window"
    );
    showToolOutputIncidentExplorerWindow({
      backend: "codex" as const,
      lens: "savings",
      projectLabel: "PwrAgent",
      threadId: "thread-3",
      title: "Gated work",
    });

    expect(mocks.windows[0]?.loadFile).toHaveBeenCalledWith(
      "/renderer.html",
      {
        hash:
          "tool-output-incidents/codex/thread-3/Gated%20work/PwrAgent/savings",
      },
    );
  });

  it("routes a thread-chip click back to the explorer's exact owner window", async () => {
    const {
      showThreadFromToolOutputIncidentExplorer,
      showToolOutputIncidentExplorerWindow,
    } = await import("../tool-output-incident-explorer-window");
    const ownerWebContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    const sourceWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: ownerWebContents,
    };
    showToolOutputIncidentExplorerWindow({
      backend: "acp:grok",
      threadId: "thread-owned",
      title: "Owned thread",
    }, { sourceWindow } as never);

    showThreadFromToolOutputIncidentExplorer(
      mocks.windows[0]!.webContents as never,
      { backend: "acp:grok", threadId: "thread-owned" },
    );

    expect(mocks.requestShowThread).toHaveBeenCalledWith(
      { backend: "acp:grok", threadId: "thread-owned" },
      { preferWebContents: ownerWebContents },
    );
    expect(() => showThreadFromToolOutputIncidentExplorer(
      mocks.windows[0]!.webContents as never,
      { backend: "acp:grok", threadId: "another-thread" },
    )).toThrow("can only open its own thread");
  });

  it("retires the owner route after Electron destroys the closed window", async () => {
    const {
      showThreadFromToolOutputIncidentExplorer,
      showToolOutputIncidentExplorerWindow,
    } = await import("../tool-output-incident-explorer-window");
    const sourceWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
    };
    const request = {
      backend: "codex" as const,
      threadId: "thread-destroyed",
      title: "Destroyed window",
    };
    showToolOutputIncidentExplorerWindow(request, { sourceWindow } as never);
    const window = mocks.windows[0]!;
    const sender = window.webContents;
    const closedHandler = window.on.mock.calls.find(
      ([event]) => event === "closed",
    )?.[1] as (() => void) | undefined;
    expect(closedHandler).toBeDefined();

    Object.defineProperty(window, "webContents", {
      configurable: true,
      get: () => {
        throw new Error("Object has been destroyed");
      },
    });

    expect(() => closedHandler?.()).not.toThrow();
    /* Surviving the close is only half of it: the owner entry has to be gone.
       A retained entry would keep routing chip clicks through a window the
       operator already closed. */
    expect(() => showThreadFromToolOutputIncidentExplorer(
      sender as never,
      { backend: "codex", threadId: "thread-destroyed" },
    )).toThrow("no active owner window");
    showToolOutputIncidentExplorerWindow(request);
    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it("retires only its own registrations when a replaced window closes", async () => {
    const {
      showThreadFromToolOutputIncidentExplorer,
      showToolOutputIncidentExplorerWindow,
    } = await import("../tool-output-incident-explorer-window");
    const sourceWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
    };
    const request = {
      backend: "codex" as const,
      threadId: "thread-replaced",
      title: "Replaced window",
    };
    showToolOutputIncidentExplorerWindow(request, { sourceWindow } as never);
    const stale = mocks.windows[0]!;
    stale.isDestroyed.mockReturnValue(true);
    showToolOutputIncidentExplorerWindow(request, { sourceWindow } as never);
    const replacement = mocks.windows[1]!;
    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(2);

    const staleClosedHandler = stale.on.mock.calls.find(
      ([event]) => event === "closed",
    )?.[1] as (() => void) | undefined;
    expect(staleClosedHandler).toBeDefined();
    staleClosedHandler?.();

    /* The late close retires the id the stale window held, never the id its
       replacement now holds, so the thread stays routable. */
    showThreadFromToolOutputIncidentExplorer(
      replacement.webContents as never,
      { backend: "codex", threadId: "thread-replaced" },
    );
    expect(mocks.requestShowThread).toHaveBeenCalledWith(
      { backend: "codex", threadId: "thread-replaced" },
      { preferWebContents: sourceWindow.webContents },
    );
    showToolOutputIncidentExplorerWindow(request, { sourceWindow } as never);
    expect(mocks.BrowserWindow).toHaveBeenCalledTimes(2);
  });
});
