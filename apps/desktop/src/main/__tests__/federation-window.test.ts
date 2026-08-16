import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WINDOW_OPEN_NEW_THREAD_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
} from "../../shared/ipc";

const createMainWindow = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({
  clearRendererEventSubscriptions: vi.fn(),
  setRemoteWindowEventSubscription: vi.fn(),
}));

vi.mock("../window", () => ({ createMainWindow }));
vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => runtime,
}));

type WindowEvent = "closed" | "ready-to-show";

function createWindow(id: number) {
  const listeners = new Map<WindowEvent, Array<() => void>>();
  let destroyed = false;
  let minimized = false;
  let visible = false;
  const window = {
    id,
    focus: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    isVisible: vi.fn(() => visible),
    once: vi.fn((event: WindowEvent, listener: () => void) => {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
    }),
    restore: vi.fn(() => {
      minimized = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    webContents: {
      id: id + 100,
      send: vi.fn(),
    },
    emit(event: WindowEvent) {
      const registered = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of registered) {
        listener();
      }
      if (event === "closed") {
        destroyed = true;
      }
    },
    setMinimized(value: boolean) {
      minimized = value;
    },
  };
  return window;
}

const peer = {
  target: { scope: "remote" as const, instanceId: "pwr_studio" },
  label: "Studio Mac",
  capabilities: ["remote_window", "thread_navigation"] as const,
};

describe("federation window", () => {
  beforeEach(() => {
    vi.resetModules();
    createMainWindow.mockReset();
    runtime.clearRendererEventSubscriptions.mockReset();
    runtime.setRemoteWindowEventSubscription.mockReset();
  });

  it("reuses one instance-wide viewer when the same peer is opened twice", async () => {
    const window = createWindow(7);
    createMainWindow.mockReturnValue(window);
    const { createFederationWindow } = await import("../federation/federation-window");
    const initialThread = {
      backend: "codex" as const,
      threadId: "thread-opened-during-load",
    };

    const first = createFederationWindow({ peer });
    const second = createFederationWindow({ peer, initialThread });

    expect(second).toBe(first);
    expect(createMainWindow).toHaveBeenCalledTimes(1);
    expect(runtime.setRemoteWindowEventSubscription).toHaveBeenCalledTimes(1);

    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
      initialThread,
    );
  });

  it("navigates a reused viewer instead of creating another window", async () => {
    const window = createWindow(8);
    createMainWindow.mockReturnValue(window);
    const { createFederationWindow } = await import("../federation/federation-window");
    createFederationWindow({ peer });
    window.emit("ready-to-show");
    window.webContents.send.mockClear();
    window.setMinimized(true);

    const initialThread = {
      backend: "codex" as const,
      messageId: "assistant-message-7",
      threadId: "thread-7",
    };
    const reused = createFederationWindow({ peer, initialThread });

    expect(reused).toBe(window);
    expect(createMainWindow).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_SHOW_THREAD_CHANNEL,
      initialThread,
    );
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalledOnce();
  });

  it("opens the launchpad in a reused viewer", async () => {
    const window = createWindow(9);
    createMainWindow.mockReturnValue(window);
    const { createFederationWindow } = await import("../federation/federation-window");
    createFederationWindow({ peer });
    window.emit("ready-to-show");
    window.webContents.send.mockClear();

    createFederationWindow({ peer, initialLaunchpad: true });

    expect(createMainWindow).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_OPEN_NEW_THREAD_CHANNEL,
    );
  });

  it("allows a fresh viewer after the existing one closes", async () => {
    const firstWindow = createWindow(10);
    const secondWindow = createWindow(11);
    createMainWindow
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow);
    const { createFederationWindow } = await import("../federation/federation-window");
    createFederationWindow({ peer });

    firstWindow.emit("closed");
    const reopened = createFederationWindow({ peer });

    expect(reopened).toBe(secondWindow);
    expect(createMainWindow).toHaveBeenCalledTimes(2);
    expect(runtime.clearRendererEventSubscriptions).toHaveBeenCalledWith(
      firstWindow.webContents.id,
      "remote-window",
    );
  });

  it("keeps separate viewers for separate federation instances", async () => {
    const firstWindow = createWindow(12);
    const secondWindow = createWindow(13);
    createMainWindow
      .mockReturnValueOnce(firstWindow)
      .mockReturnValueOnce(secondWindow);
    const { createFederationWindow } = await import("../federation/federation-window");

    const first = createFederationWindow({ peer });
    const second = createFederationWindow({
      peer: {
        ...peer,
        target: { scope: "remote", instanceId: "pwr_laptop" },
      },
    });

    expect(first).toBe(firstWindow);
    expect(second).toBe(secondWindow);
    expect(createMainWindow).toHaveBeenCalledTimes(2);
  });
});
