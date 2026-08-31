// The Star Map window's cross-window IPC surface: opening (or focusing)
// the dedicated map window, and routing its navigation actions back to
// the primary main window. The federation filter is the part worth
// pinning — a remote-viewer window subscribes to the same show-thread
// channel but fronts another instance's threads, so sending it a local
// thread would land nowhere.
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL,
  STAR_MAP_INTAKE_CHANNEL,
  STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL,
  STAR_MAP_OPEN_WINDOW_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
} from "../../shared/ipc";
import { dispatchStarMapIntake } from "../app-server/star-map-intake";
import { stageTurnInputAttachments } from "../app-server/turn-input-attachment-files";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { registerStarMapIpcHandlers } from "../ipc/star-map";
import { isFederationWindowWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";
import { requestShowThread } from "../window-show-thread";
import { showStarMapWindow } from "../star-map-window";

const { handlers, fromWebContentsMock } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
  fromWebContentsMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
      ) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../app-server/desktop-overlay-store", () => ({
  getDesktopOverlayStore: vi.fn(),
}));
vi.mock("../app-server/star-map-intake", () => ({
  dispatchStarMapIntake: vi.fn(),
}));
vi.mock("../app-server/turn-input-attachment-files", () => ({
  MAX_TURN_INPUT_ATTACHMENT_BYTES: 128 * 1024 * 1024,
  stageTurnInputAttachments: vi.fn(),
}));
vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: vi.fn(),
}));
vi.mock("../window", () => ({
  isFederationWindowWebContents: vi.fn(),
}));
vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(),
}));
vi.mock("../window-show-thread", () => ({
  requestShowThread: vi.fn(),
}));
vi.mock("../star-map-window", () => ({
  showStarMapWindow: vi.fn(),
}));

function handlerFor(channel: string) {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler;
}

describe("star map window IPC", () => {
  beforeEach(() => {
    handlers.clear();
    fromWebContentsMock.mockReset();
    vi.mocked(isFederationWindowWebContents).mockReset();
    vi.mocked(dispatchStarMapIntake).mockReset();
    vi.mocked(stageTurnInputAttachments).mockReset();
    vi.mocked(stageTurnInputAttachments).mockResolvedValue([]);
    vi.mocked(getDesktopFederationRuntime).mockReset();
    vi.mocked(subscribersForChannel).mockReset();
    vi.mocked(requestShowThread).mockReset();
    vi.mocked(showStarMapWindow).mockReset();
    registerStarMapIpcHandlers();
  });

  it("opens the map window on the invoking window's display", async () => {
    const sender = {} as WebContents;
    const sourceWindow = { id: 7 };
    fromWebContentsMock.mockReturnValue(sourceWindow);

    await handlerFor(STAR_MAP_OPEN_WINDOW_CHANNEL)({ sender });

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender);
    expect(showStarMapWindow).toHaveBeenCalledWith({
      sourceWindow,
    });
  });

  it("routes a thread open to the first non-federation main window", async () => {
    const federationContents = { id: 1 } as WebContents;
    const mainContents = { id: 2 } as WebContents;
    vi.mocked(subscribersForChannel).mockReturnValue([
      federationContents,
      mainContents,
    ]);
    vi.mocked(isFederationWindowWebContents).mockImplementation(
      (contents) => contents === federationContents,
    );
    const request = { backend: "codex", threadId: "thread-1" };

    await handlerFor(STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL)({}, request);

    expect(subscribersForChannel).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
    );
    expect(requestShowThread).toHaveBeenCalledWith(request, {
      preferWebContents: mainContents,
    });
  });

  it("drops a thread open when only federation windows subscribe", async () => {
    const federationContents = { id: 1 } as WebContents;
    vi.mocked(subscribersForChannel).mockReturnValue([federationContents]);
    vi.mocked(isFederationWindowWebContents).mockReturnValue(true);

    await handlerFor(STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL)(
      {},
      { backend: "codex", threadId: "thread-1" },
    );

    expect(requestShowThread).not.toHaveBeenCalled();
  });

  it("ignores a malformed thread-open payload", async () => {
    await handlerFor(STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL)(
      {},
      { backend: "codex" },
    );

    expect(subscribersForChannel).not.toHaveBeenCalled();
    expect(requestShowThread).not.toHaveBeenCalled();
  });

  it("focuses the main window without navigating", async () => {
    const mainContents = { id: 2 } as WebContents;
    vi.mocked(subscribersForChannel).mockReturnValue([mainContents]);
    vi.mocked(isFederationWindowWebContents).mockReturnValue(false);
    const mainWindow = {
      focus: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
    };
    fromWebContentsMock.mockReturnValue(mainWindow);

    await handlerFor(STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL)({});

    expect(mainWindow.restore).toHaveBeenCalledOnce();
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.focus).toHaveBeenCalledOnce();
    expect(requestShowThread).not.toHaveBeenCalled();
  });

  it("no-ops the focus request with no main window", async () => {
    vi.mocked(subscribersForChannel).mockReturnValue([]);

    await expect(
      handlerFor(STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL)({}),
    ).resolves.toBeUndefined();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
  });

  it("stages renderer image bytes before local Star Map intake", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const attachment = {
      type: "localImage" as const,
      name: "screen.png",
      path: "/pwragent/turn-input-attachments/screen.png",
    };
    vi.mocked(stageTurnInputAttachments).mockResolvedValue([attachment]);
    vi.mocked(dispatchStarMapIntake).mockResolvedValue({
      status: "created",
      requestId: "request-1",
      backend: "codex",
      threadId: "thread-1",
    });

    await handlerFor(STAR_MAP_INTAKE_CHANNEL)({}, {
      requestId: "request-1",
      request: "Fix the screenshot issue",
      imageUploads: [{ bytes, mimeType: "image/png", name: "screen.png" }],
    });

    expect(stageTurnInputAttachments).toHaveBeenCalledWith([{
      type: "localImage",
      data: bytes,
      mimeType: "image/png",
      name: "screen.png",
    }]);
    expect(dispatchStarMapIntake).toHaveBeenCalledWith({
      requestId: "request-1",
      request: "Fix the screenshot issue",
      attachments: [attachment],
    });
  });

  it("sends only staged attachment inputs to remote Star Map intake", async () => {
    const bytes = Uint8Array.from([4, 5, 6]);
    const attachment = {
      type: "localImage" as const,
      name: "remote.png",
      path: "/pwragent/turn-input-attachments/remote.png",
    };
    const starMapIntake = vi.fn().mockResolvedValue({
      status: "created",
      requestId: "request-remote",
      backend: "codex",
      threadId: "remote-thread",
    });
    const remoteBackend = vi.fn().mockReturnValue({ starMapIntake });
    vi.mocked(stageTurnInputAttachments).mockResolvedValue([attachment]);
    vi.mocked(getDesktopFederationRuntime).mockReturnValue({
      remoteBackend,
    } as never);
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer-one",
    };

    await handlerFor(STAR_MAP_INTAKE_CHANNEL)({}, {
      requestId: "request-remote",
      request: "Investigate this image",
      federationTarget,
      imageUploads: [{ bytes, mimeType: "image/png", name: "remote.png" }],
    });

    expect(remoteBackend).toHaveBeenCalledWith(federationTarget);
    expect(starMapIntake).toHaveBeenCalledWith({
      requestId: "request-remote",
      request: "Investigate this image",
      attachments: [attachment],
    });
    expect(starMapIntake.mock.calls[0]?.[0]).not.toHaveProperty("imageUploads");
  });

  it("ignores renderer-nominated attachment paths", async () => {
    vi.mocked(dispatchStarMapIntake).mockResolvedValue({
      status: "needs_disambiguation",
      requestId: "request-forged",
      candidates: [],
    });

    await handlerFor(STAR_MAP_INTAKE_CHANNEL)({}, {
      requestId: "request-forged",
      request: "Use this path",
      attachments: [{
        type: "localImage",
        path: "/private/peer-controlled.png",
      }],
    });

    expect(stageTurnInputAttachments).not.toHaveBeenCalled();
    expect(dispatchStarMapIntake).toHaveBeenCalledWith({
      requestId: "request-forged",
      request: "Use this path",
    });
  });

  it("rejects image batches that bypass the renderer cap", async () => {
    const imageUploads = Array.from({ length: 6 }, (_, index) => ({
      bytes: Uint8Array.from([index + 1]),
      mimeType: "image/png",
      name: `screen-${index}.png`,
    }));

    await expect(handlerFor(STAR_MAP_INTAKE_CHANNEL)({}, {
      requestId: "request-too-many",
      request: "Too many images",
      imageUploads,
    })).rejects.toThrow(/at most 5 images/u);
    expect(stageTurnInputAttachments).not.toHaveBeenCalled();
    expect(dispatchStarMapIntake).not.toHaveBeenCalled();
  });
});
