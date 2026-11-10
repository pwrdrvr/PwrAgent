import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getRestartGateStatus: vi.fn(),
  onRestartGateStatusChanged: vi.fn(),
  releaseRestartGate: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => registry,
}));

vi.mock("../shell/window-channels", () => ({
  subscribersForChannel: vi.fn(),
}));

vi.mock("../shell/window", () => ({
  isFederationWindowWebContents: vi.fn(),
}));

import { ipcMain, type WebContents } from "electron";
import {
  RESTART_GATE_RELEASE_CHANNEL,
  RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL,
  RESTART_GATE_STATUS_CHANNEL,
} from "../../shared/ipc";
import type { RestartGateStatus } from "../../shared/restart-gate";
import { subscribersForChannel } from "../shell/window-channels";
import { isFederationWindowWebContents } from "../shell/window";
import { disposeRestartGateIpcHandlers, registerRestartGateIpcHandlers } from "../shell/ipc/restart-gate";

type Handler = (event: { sender: WebContents }) => unknown;

function handlerFor(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as unknown as Handler;
}

describe("restart gate IPC", () => {
  const local = { id: 1, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
  const peer = { id: 2 } as unknown as WebContents;
  const unsubscribe = vi.fn();
  let push: ((status: RestartGateStatus) => void) | undefined;

  beforeEach(() => {
    disposeRestartGateIpcHandlers();
    vi.clearAllMocks();
    registry.getRestartGateStatus.mockReturnValue({ phase: "resuming", waiting: 2 });
    registry.releaseRestartGate.mockReturnValue({ phase: "open" });
    registry.onRestartGateStatusChanged.mockImplementation((listener: (status: RestartGateStatus) => void) => {
      push = listener;
      return unsubscribe;
    });
    vi.mocked(isFederationWindowWebContents).mockImplementation((sender) => sender === peer);
    vi.mocked(subscribersForChannel).mockReturnValue([local]);
    registerRestartGateIpcHandlers();
  });

  it("answers and releases for this machine's windows, and pushes each change to them", () => {
    expect(handlerFor(RESTART_GATE_STATUS_CHANNEL)({ sender: local })).toEqual({ phase: "resuming", waiting: 2 });
    expect(handlerFor(RESTART_GATE_RELEASE_CHANNEL)({ sender: local })).toEqual({ phase: "open" });
    expect(registry.releaseRestartGate).toHaveBeenCalledTimes(1);

    push?.({ phase: "open" });
    expect(subscribersForChannel).toHaveBeenCalledWith(RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL);
    expect(local.send).toHaveBeenCalledWith(RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL, { phase: "open" });
  });

  it("shows a peer's window an open gate and refuses its release", () => {
    expect(handlerFor(RESTART_GATE_STATUS_CHANNEL)({ sender: peer })).toEqual({ phase: "open" });
    expect(() => handlerFor(RESTART_GATE_RELEASE_CHANNEL)({ sender: peer })).toThrow("cannot release");
    expect(registry.releaseRestartGate).not.toHaveBeenCalled();
  });

  it("stops pushing on dispose", () => {
    disposeRestartGateIpcHandlers();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(RESTART_GATE_STATUS_CHANNEL);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(RESTART_GATE_RELEASE_CHANNEL);
  });
});
