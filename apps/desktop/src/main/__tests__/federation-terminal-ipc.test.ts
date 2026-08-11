import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  INTEGRATED_TERMINAL_CLOSE_CHANNEL,
  INTEGRATED_TERMINAL_CREATE_CHANNEL,
  INTEGRATED_TERMINAL_LIST_CHANNEL,
  INTEGRATED_TERMINAL_REVEAL_CHANNEL,
  INTEGRATED_TERMINAL_SESSIONS_CHANNEL,
  INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL,
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
    localClose: vi.fn(),
    localSetPanelHidden: vi.fn(),
    localRevealSession: vi.fn(() => false),
    federationWindowIds: new Set<number>(),
    federationTargets: new Map<number, { scope: "remote"; instanceId: string }>(),
    connectedPeers: [
      {
        target: { scope: "remote" as const, instanceId: "peer-a" },
        label: "Peer Mac",
        capabilities: ["remote_pty"] as string[],
      },
    ],
    localQuitSnapshot: {
      count: 0,
      sessionIds: [] as string[],
      threads: [] as Array<{ threadKey: string }>,
    },
    channelSubscribers: [] as Array<{ id: number; send: (...args: unknown[]) => void }>,
    localSessionsChanged: undefined as
      | ((sessions: unknown[]) => void)
      | undefined,
    remotePtyOpen: vi.fn(async () => ({
      sessionId: "remote-session",
      cwd: "/owner/worktree",
      shell: "/bin/zsh",
    })),
    remotePtyInput: vi.fn(async () => undefined),
    remotePtyAck: vi.fn(async () => undefined),
    remotePtyClose: vi.fn(async () => undefined),
    remotePtyEventListener: undefined as
      | ((event: {
          kind: string;
          peerId: string;
          params: Record<string, unknown>;
        }) => void)
      | undefined,
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
    constructor(options: { onSessionsChanged: (sessions: unknown[]) => void }) {
      mocks.localSessionsChanged = options.onSessionsChanged;
    }
    createOrAttach = mocks.localCreateOrAttach;
    write = mocks.localWrite;
    resize = vi.fn();
    close = mocks.localClose;
    listSessions = vi.fn(() => []);
    setPanelHidden = mocks.localSetPanelHidden;
    revealSession = mocks.localRevealSession;
    getQuitSnapshot = () => mocks.localQuitSnapshot;
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
  subscribersForChannel: () => mocks.channelSubscribers,
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => ({
    remotePty: () => ({
      open: mocks.remotePtyOpen,
      input: mocks.remotePtyInput,
      resize: vi.fn(async () => undefined),
      ack: mocks.remotePtyAck,
      close: mocks.remotePtyClose,
    }),
    connectedPeerTargets: () => mocks.connectedPeers,
    celestialIconFor: (instanceId: string) =>
      instanceId === "peer-a" ? ("moon" as const) : undefined,
    onRemotePtyEvent: (
      listener: (event: {
        kind: string;
        peerId: string;
        params: Record<string, unknown>;
      }) => void,
    ) => {
      mocks.remotePtyEventListener = listener;
      return () => undefined;
    },
  }),
}));

import {
  disposeIntegratedTerminalIpcHandlers,
  getIntegratedTerminalQuitSnapshot,
  registerIntegratedTerminalIpcHandlers,
  revealIntegratedTerminal,
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
    mocks.remotePtyEventListener = undefined;
    mocks.connectedPeers = [
      {
        target: { scope: "remote" as const, instanceId: "peer-a" },
        label: "Peer Mac",
        capabilities: ["remote_pty"],
      },
    ];
    mocks.localQuitSnapshot = { count: 0, sessionIds: [], threads: [] };
    mocks.localRevealSession.mockReturnValue(false);
    mocks.channelSubscribers = [];
    mocks.localSessionsChanged = undefined;
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

  it("routes a MAIN window's create remotely when the request names an owning instance", async () => {
    const sender = fakeWebContents(2);

    const response = (await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
      cols: 100,
      rows: 30,
      federationTarget: { scope: "remote", instanceId: "peer-a" },
    })) as {
      sessionId: string;
      cwd: string;
    };

    expect(mocks.remotePtyOpen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "remote-pinned",
      cols: 100,
      rows: 30,
    });
    expect(response.sessionId).toBe("remote-session");
    // The shell runs on the peer — nothing may spawn locally.
    expect(mocks.localCreateOrAttach).not.toHaveBeenCalled();

    // Follow-up traffic routes by session ownership, not window identity.
    await invoke(INTEGRATED_TERMINAL_WRITE_CHANNEL, sender, {
      sessionId: "remote-session",
      data: "ls\n",
    });
    expect(mocks.remotePtyInput).toHaveBeenCalledTimes(1);
    expect(mocks.localWrite).not.toHaveBeenCalled();

    // The merged session list brands the remote session with its owner.
    const sessions = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      sender,
    )) as Array<{
      sessionId: string;
      remote?: { instanceId: string; instanceLabel: string; celestialIcon?: string };
    }>;
    const remoteSession = sessions.find(
      (session) => session.sessionId === "remote-session",
    );
    expect(remoteSession?.remote).toEqual({
      instanceId: "peer-a",
      instanceLabel: "Peer Mac",
      celestialIcon: "moon",
    });
  });

  it("keeps a MAIN window's local writes off the remote bridge", async () => {
    const sender = fakeWebContents(3);
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:local-thread",
      cols: 80,
      rows: 24,
    });
    await invoke(INTEGRATED_TERMINAL_WRITE_CHANNEL, sender, {
      sessionId: "local-session",
      data: "pwd\n",
    });
    expect(mocks.localWrite).toHaveBeenCalledTimes(1);
    expect(mocks.remotePtyInput).not.toHaveBeenCalled();
  });

  it("ignores a renderer-supplied target in a federation window: the window target wins", async () => {
    const sender = fakeWebContents(11);
    mocks.federationWindowIds.add(11);
    mocks.federationTargets.set(11, { scope: "remote", instanceId: "peer-a" });

    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
      // A compromised renderer must not be able to steer the pane at a
      // different peer than the window is branded as.
      federationTarget: { scope: "remote", instanceId: "peer-EVIL" },
    });

    const sessions = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      sender,
    )) as Array<{ remote?: { instanceId: string } }>;
    expect(sessions[0]?.remote?.instanceId).toBe("peer-a");
  });

  it("rejects a main-window target that is malformed, unconnected, or ungranted", async () => {
    const sender = fakeWebContents(4);
    const create = (instanceId: string) =>
      invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
        threadKey: "codex:remote-pinned",
        cols: 80,
        rows: 24,
        federationTarget: { scope: "remote", instanceId },
      });

    // Malformed id never reaches the transport (where an unknown peer could
    // otherwise fall through to the gateway relay as an opaque error).
    await expect(create("x")).rejects.toThrow(/invalid remote terminal/i);
    // Well-formed but not a connected peer.
    await expect(create("peer-unknown")).rejects.toThrow(/not connected/i);
    // Connected, but the owner withheld the capability.
    mocks.connectedPeers = [
      {
        target: { scope: "remote" as const, instanceId: "peer-a" },
        label: "Peer Mac",
        capabilities: [],
      },
    ];
    await expect(create("peer-a")).rejects.toThrow(/remote_pty/i);

    expect(mocks.remotePtyOpen).not.toHaveBeenCalled();
    expect(mocks.localCreateOrAttach).not.toHaveBeenCalled();
  });

  it("routes a main window's close and panel-hidden for a remote pane to the bridge", async () => {
    const sender = fakeWebContents(5);
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
      cols: 80,
      rows: 24,
      federationTarget: { scope: "remote", instanceId: "peer-a" },
    });

    await invoke(INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
      hidden: true,
    });
    expect(mocks.localSetPanelHidden).not.toHaveBeenCalled();
    const hiddenSessions = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      sender,
    )) as Array<{ panelHidden: boolean }>;
    expect(hiddenSessions[0]?.panelHidden).toBe(true);

    await invoke(INTEGRATED_TERMINAL_CLOSE_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
    });
    expect(mocks.remotePtyClose).toHaveBeenCalledTimes(1);
    expect(mocks.localClose).not.toHaveBeenCalled();
  });

  it("broadcasts local and remote sessions together to a main window", async () => {
    const sender = fakeWebContents(8);
    mocks.channelSubscribers = [sender as unknown as { id: number; send: (...args: unknown[]) => void }];
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
      cols: 80,
      rows: 24,
      federationTarget: { scope: "remote", instanceId: "peer-a" },
    });

    // A LOCAL session change must not blank the remote rows: the renderer
    // replaces its whole list per event.
    mocks.localSessionsChanged?.([
      {
        sessionId: "local-session",
        threadKey: "codex:local-thread",
        cwd: "/local",
        shell: "/bin/zsh",
        panelHidden: false,
        createdAt: 1,
      },
    ]);

    const send = sender.send as unknown as {
      mock: { calls: Array<[string, { sessions: Array<{ sessionId: string }> }]> };
    };
    const lastSessionsEvent = [...send.mock.calls]
      .reverse()
      .find(([channel]) => channel === INTEGRATED_TERMINAL_SESSIONS_CHANNEL);
    expect(
      lastSessionsEvent?.[1].sessions.map((session) => session.sessionId),
    ).toEqual(["local-session", "remote-session"]);
  });

  it("counts remote sessions as quit blockers so they are not killed silently", async () => {
    const sender = fakeWebContents(6);
    mocks.localQuitSnapshot = {
      count: 1,
      sessionIds: ["local-session"],
      threads: [{ threadKey: "codex:local-thread" }],
    };
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-pinned",
      cols: 80,
      rows: 24,
      federationTarget: { scope: "remote", instanceId: "peer-a" },
    });

    const snapshot = getIntegratedTerminalQuitSnapshot();
    expect(snapshot.count).toBe(2);
    // The owning peer rides along: the quit dialog cannot name a remote
    // thread by asking the LOCAL thread list about it.
    expect(snapshot.threads).toEqual([
      { threadKey: "codex:local-thread" },
      {
        threadKey: "codex:remote-pinned",
        target: { scope: "remote", instanceId: "peer-a" },
        instanceLabel: "Peer Mac",
      },
    ]);
    expect(snapshot.sessionIds).toContain("remote-session");
  });

  it("reveals a remote terminal in the window that owns it", async () => {
    const federationWindow = fakeWebContents(11);
    mocks.federationWindowIds.add(11);
    mocks.federationTargets.set(11, { scope: "remote", instanceId: "peer-a" });
    const otherWindow = fakeWebContents(12);
    mocks.channelSubscribers = [
      federationWindow as unknown as { id: number; send: (...args: unknown[]) => void },
      otherWindow as unknown as { id: number; send: (...args: unknown[]) => void },
    ];
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, federationWindow, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });
    await invoke(INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL, federationWindow, {
      threadKey: "codex:remote-thread",
      hidden: true,
    });

    const result = revealIntegratedTerminal("codex:remote-thread");

    // Asking only the LOCAL PTY registry reported "no such session" and the
    // quit dialog's terminal row silently did nothing.
    expect(result.revealed).toBe(true);
    expect(result.owner).toBe(federationWindow);
    const revealCalls = (
      federationWindow.send as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter(
      ([channel]) => channel === INTEGRATED_TERMINAL_REVEAL_CHANNEL,
    );
    expect(revealCalls).toHaveLength(1);
    // A window that does not own the session must not open a terminal panel
    // for a thread it may not even have.
    expect(
      (otherWindow.send as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ).toHaveLength(0);
  });

  it("reports nothing to reveal when no window owns the thread", async () => {
    mocks.localRevealSession.mockReturnValue(false);

    expect(revealIntegratedTerminal("codex:vanished").revealed).toBe(false);
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

  it("honors a close issued while the remote open is still in flight", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    let releaseOpen: (() => void) | undefined;
    mocks.remotePtyOpen.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      return {
        sessionId: "remote-session",
        cwd: "/owner/worktree",
        shell: "/bin/zsh",
      };
    });

    const createPromise = invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => {
      expect(releaseOpen).toBeTypeOf("function");
    });
    // The user dismisses the panel before the owner finished spawning.
    await invoke(INTEGRATED_TERMINAL_CLOSE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
    });
    releaseOpen!();

    await expect(createPromise).rejects.toThrow(/closed before it finished/);
    // The just-spawned owner session is released, and nothing was registered
    // that could broadcast the dismissed pane back open.
    await vi.waitFor(() => {
      expect(mocks.remotePtyClose).toHaveBeenCalledWith({
        sessionId: "remote-session",
      });
    });
    const list = (await invoke(
      INTEGRATED_TERMINAL_LIST_CHANNEL,
      sender,
    )) as unknown[];
    expect(list).toEqual([]);
  });

  it("coalesces concurrent creates for one thread into a single remote open", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    let releaseOpen: (() => void) | undefined;
    mocks.remotePtyOpen.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      return {
        sessionId: "remote-session",
        cwd: "/owner/worktree",
        shell: "/bin/zsh",
      };
    });

    const request = { threadKey: "codex:remote-thread", cols: 80, rows: 24 };
    const first = invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, request);
    await vi.waitFor(() => {
      expect(releaseOpen).toBeTypeOf("function");
    });
    const second = invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, request);
    releaseOpen!();

    const [firstResponse, secondResponse] = (await Promise.all([
      first,
      second,
    ])) as { sessionId: string }[];
    expect(firstResponse.sessionId).toBe("remote-session");
    expect(secondResponse.sessionId).toBe("remote-session");
    expect(mocks.remotePtyOpen).toHaveBeenCalledTimes(1);
  });

  it("surfaces a stream sequence gap instead of silently repairing it", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });
    const emit = mocks.remotePtyEventListener!;

    emit({
      kind: "output",
      peerId: "peer-a",
      params: {
        sessionId: "remote-session",
        seq: 1,
        dataBase64: Buffer.from("one").toString("base64"),
      },
    });
    emit({
      kind: "output",
      peerId: "peer-a",
      params: {
        sessionId: "remote-session",
        seq: 3,
        dataBase64: Buffer.from("three").toString("base64"),
      },
    });

    const sends = (sender.send as ReturnType<typeof vi.fn>).mock.calls;
    const errorSend = sends.find(
      ([channel]) => channel === "integrated-terminal:error",
    );
    expect(errorSend?.[1]).toMatchObject({
      sessionId: "remote-session",
      message: expect.stringMatching(/skipped from frame 1 to 3/),
    });
    // The frames that DID arrive still render.
    const outputSends = sends.filter(
      ([channel]) => channel === "integrated-terminal:output",
    );
    expect(outputSends.map(([, payload]) => (payload as { data: string }).data))
      .toEqual(["one", "three"]);
  });

  it("acks consumed output every 256 KiB", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, {
      threadKey: "codex:remote-thread",
      cols: 80,
      rows: 24,
    });
    const emit = mocks.remotePtyEventListener!;

    const chunk = "x".repeat(128 * 1024);
    emit({
      kind: "output",
      peerId: "peer-a",
      params: {
        sessionId: "remote-session",
        seq: 1,
        dataBase64: Buffer.from(chunk).toString("base64"),
      },
    });
    expect(mocks.remotePtyAck).not.toHaveBeenCalled();
    emit({
      kind: "output",
      peerId: "peer-a",
      params: {
        sessionId: "remote-session",
        seq: 2,
        dataBase64: Buffer.from(chunk).toString("base64"),
      },
    });
    expect(mocks.remotePtyAck).toHaveBeenCalledWith({
      sessionId: "remote-session",
      bytes: 256 * 1024,
    });
  });

  it("replays viewer-buffered output when a pane re-attaches", async () => {
    const sender = fakeWebContents(7);
    mocks.federationWindowIds.add(7);
    mocks.federationTargets.set(7, { scope: "remote", instanceId: "peer-a" });
    const request = { threadKey: "codex:remote-thread", cols: 80, rows: 24 };
    await invoke(INTEGRATED_TERMINAL_CREATE_CHANNEL, sender, request);
    mocks.remotePtyEventListener!({
      kind: "output",
      peerId: "peer-a",
      params: {
        sessionId: "remote-session",
        seq: 1,
        dataBase64: Buffer.from("scrollback line").toString("base64"),
      },
    });

    const reattached = (await invoke(
      INTEGRATED_TERMINAL_CREATE_CHANNEL,
      sender,
      request,
    )) as { sessionId: string; buffer?: string };
    expect(reattached.sessionId).toBe("remote-session");
    expect(reattached.buffer).toBe("scrollback line");
    expect(mocks.remotePtyOpen).toHaveBeenCalledTimes(1);
  });
});
