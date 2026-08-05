import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  INTEGRATED_TERMINAL_CLOSE_CHANNEL,
  INTEGRATED_TERMINAL_CREATE_CHANNEL,
  INTEGRATED_TERMINAL_LIST_CHANNEL,
  INTEGRATED_TERMINAL_WRITE_CHANNEL,
} from "../../shared/ipc";

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (...args: unknown[]) => unknown | Promise<unknown>
  >();
  return {
    handlers,
    localCreateOrAttach: vi.fn(async () => ({
      sessionId: "local-session",
      threadKey: "codex:local-thread",
      cwd: "/local",
      shell: "/bin/zsh",
    })),
    localWrite: vi.fn(),
    federationWindowIds: new Set<number>(),
    federationTargets: new Map<number, { scope: "remote"; instanceId: string }>(),
    remotePtyOpen: vi.fn(async () => ({
      sessionId: "remote-session",
      cwd: "/owner/worktree",
      shell: "/bin/zsh",
    })),
    remotePtyInput: vi.fn(async () => undefined),
    remotePtyClose: vi.fn(async () => undefined),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        mocks.handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      mocks.handlers.delete(channel);
    }),
  },
}));

vi.mock("../terminal/integrated-terminal-service", () => ({
  IntegratedTerminalService: class {
    createOrAttach = mocks.localCreateOrAttach;
    write = mocks.localWrite;
    resize = vi.fn();
    close = vi.fn();
    listSessions = vi.fn(() => []);
    setPanelHidden = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("../window", () => ({
  isFederationWindowWebContents: (webContents: { id: number } | undefined) =>
    webContents ? mocks.federationWindowIds.has(webContents.id) : false,
  federationWindowTargetForWebContents: (
    webContents: { id: number } | undefined,
  ) => (webContents ? mocks.federationTargets.get(webContents.id) : undefined),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: () => [],
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => ({
    remotePty: () => ({
      open: mocks.remotePtyOpen,
      input: mocks.remotePtyInput,
      resize: vi.fn(async () => undefined),
      ack: vi.fn(async () => undefined),
      close: mocks.remotePtyClose,
    }),
    onRemotePtyEvent: () => () => undefined,
  }),
}));

import {
  disposeIntegratedTerminalIpcHandlers,
  registerIntegratedTerminalIpcHandlers,
} from "../ipc/integrated-terminal";

function fakeWebContents(id: number): WebContents {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn(),
  } as unknown as WebContents;
}

async function invoke(channel: string, sender: WebContents, request?: unknown) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return await handler({ sender }, request);
}

describe("integrated terminal IPC federation branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.federationWindowIds.clear();
    mocks.federationTargets.clear();
    disposeIntegratedTerminalIpcHandlers();
    registerIntegratedTerminalIpcHandlers();
  });

  it("routes a local window's create to the local PTY service", async () => {
    const sender = fakeWebContents(1);
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:local-thread",
      cols: 80,
      rows: 24,
    });
    expect(mocks.localCreateOrAttach).toHaveBeenCalledTimes(1);
    expect(mocks.remotePtyOpen).not.toHaveBeenCalled();
  });

  it("routes a federation window's create to the remote session, never a local spawn", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });

    const response = (await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 120,
      rows: 32,
    })) as { sessionId: string; cwd: string };

    expect(mocks.remotePtyOpen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-thread",
      cols: 120,
      rows: 32,
    });
    expect(response.sessionId).toBe("remote-session");
    expect(response.cwd).toBe("/owner/worktree");
    expect(mocks.localCreateOrAttach).not.toHaveBeenCalled();
  });

  it("throws for a federation window with no remote target instead of spawning locally", async () => {
    const sender = fakeWebContents(9);
    mocks.federationWindowIds.add(9);
    // Deliberately no target registered for id 9.

    await expect(
      invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
        threadKey: "codex:remote-thread",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/no federation target/);
    expect(mocks.localCreateOrAttach).not.toHaveBeenCalled();
    expect(mocks.remotePtyOpen).not.toHaveBeenCalled();
  });

  it("keeps a federation window's writes off the local service", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });

    await invoke(INTEGRATED_TERMINAL_WRITE_CHANNEL, sender, {
      sessionId: "remote-session",
      data: "echo hi\r",
    });
    expect(mocks.localWrite).not.toHaveBeenCalled();
    expect(mocks.remotePtyInput).toHaveBeenCalledWith({
      sessionId: "remote-session",
      dataBase64: Buffer.from("echo hi\r", "utf8").toString("base64"),
    });
  });

  it("lists only the federation window's own remote sessions", async () => {
    const remoteSender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, remoteSender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });

    const remoteList = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      remoteSender,
    )) as { sessionId: string }[];
    expect(remoteList.map((session) => session.sessionId)).toEqual([
      "remote-session",
    ]);

    const otherRemoteSender = fakeWebContents(8);
    mocks.federationWindowIds.add(8);
    mocks.federationTargets.set(8, { scope: "remote", instanceId: "peer-b" });
    const otherList = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      otherRemoteSender,
    )) as unknown[];
    expect(otherList).toEqual([]);
  });

  it("closes the remote session when the federation window closes the pane", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });

    await invoke(INTEGRATED_TERMINAL_CLOSE_CHANNEL, sender, {
      sessionId: "remote-session",
    });
    expect(mocks.remotePtyClose).toHaveBeenCalledWith({
      sessionId: "remote-session",
    });
  });
});
