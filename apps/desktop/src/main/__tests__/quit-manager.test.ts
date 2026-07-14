import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    quit: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => ({
    getInProgressThreadSnapshotForQuit: () => ({ count: 0, threadIds: [] }),
  })),
}));

vi.mock("../ipc/integrated-terminal", () => ({
  getIntegratedTerminalQuitSnapshot: vi.fn(() => ({
    count: 0,
    sessionIds: [],
    threadKeys: [],
  })),
  revealIntegratedTerminal: vi.fn(() => false),
}));

vi.mock("../window-show-thread", () => ({ requestShowThread: vi.fn() }));

vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: vi.fn(() => ({
    resolveConfirmQuitWithInProgressThreads: () => true,
  })),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe("createQuitManager", () => {
  it("quits immediately when no threads are in progress", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const confirm = vi.fn();
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 0,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: [],
        actionRunCount: 0,
        items: [],
      }),
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(performQuit).toHaveBeenCalledTimes(1);
  });

  it("shows confirmation when threads are in progress", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const warn = vi.fn();
    const confirm = vi.fn(async () => "manual-confirm" as const);
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 2,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: ["acp:grok:thread-2", "codex:thread-1"],
        actionRunCount: 0,
        items: [],
      }),
      log: { warn },
      performQuit,
    });

    await expect(manager.requestQuit({ source: "before-quit" })).resolves.toBe(
      true,
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        countdownSeconds: 10,
        inProgressThreadCount: 2,
        terminalSessionCount: 0,
      }),
    );
    expect(performQuit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "quit requested with active work",
      expect.objectContaining({ count: 2 }),
    );
  });

  it("shows confirmation when integrated terminals are running", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const warn = vi.fn();
    const confirm = vi.fn(async () => "manual-confirm" as const);
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 1,
        terminalThreadKeys: ["codex:thread-terminal"],
        threadIds: [],
        actionRunCount: 0,
        items: [],
      }),
      log: { warn },
      performQuit,
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        countdownSeconds: 10,
        inProgressThreadCount: 0,
        terminalSessionCount: 1,
      }),
    );
    expect(performQuit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "quit requested with active work",
      expect.objectContaining({
        count: 1,
        terminalSessionCount: 1,
        terminalThreadKeys: ["codex:thread-terminal"],
        threadIds: [],
        actionRunCount: 0,
      }),
    );
  });

  it("cancels quit when the operator stays open", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const confirm = vi.fn(async () => "manual-cancel" as const);
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: ["codex:thread-1"],
        actionRunCount: 0,
        items: [],
      }),
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "ipc" })).resolves.toBe(false);

    expect(performQuit).not.toHaveBeenCalled();
  });

  it("runs a later custom quit action after an already-open prompt confirms", async () => {
    const { createQuitManager } = await import("../quit-manager");
    let resolveConfirm!: (value: "manual-confirm") => void;
    const performQuit = vi.fn();
    const installUpdateAndQuit = vi.fn();
    const confirm = vi.fn(
      async () =>
        await new Promise<"manual-confirm">((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: ["codex:thread-1"],
        actionRunCount: 0,
        items: [],
      }),
      log: {},
      performQuit,
    });

    const normalQuit = manager.requestQuit({ source: "menu" });
    const updateQuit = manager.requestQuit({
      performQuit: installUpdateAndQuit,
      source: "update-install",
    });
    resolveConfirm("manual-confirm");

    await expect(normalQuit).resolves.toBe(true);
    await expect(updateQuit).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(performQuit).not.toHaveBeenCalled();
    expect(installUpdateAndQuit).toHaveBeenCalledTimes(1);
  });

  it("quits without prompting when confirmation is disabled", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const confirm = vi.fn();
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => false,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: ["codex:thread-1"],
        actionRunCount: 0,
        items: [],
      }),
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(performQuit).toHaveBeenCalledTimes(1);
  });

  it("resolves thread titles for the dialog's links", async () => {
    const { buildQuitBlockerSnapshot, createQuitManager } = await import(
      "../quit-manager"
    );
    const confirm = vi.fn(async () => "manual-cancel" as const);
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () =>
        buildQuitBlockerSnapshot({
          inProgressThreads: { count: 0, threadIds: [] },
          terminalSessions: { count: 1, threadKeys: ["codex:thread-1"] },
        }),
      resolveThreadTitles: async () =>
        new Map([["codex:thread-1", "Migrate Next Chunk"]]),
      log: {},
      performQuit: vi.fn(),
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            kind: "terminal",
            title: "Migrate Next Chunk",
            threadKey: "codex:thread-1",
          }),
        ],
      }),
    );
  });

  it("still shows the dialog when thread-title resolution fails", async () => {
    const { buildQuitBlockerSnapshot, createQuitManager } = await import(
      "../quit-manager"
    );
    const confirm = vi.fn(async () => "manual-cancel" as const);
    const warn = vi.fn();
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () =>
        buildQuitBlockerSnapshot({
          inProgressThreads: { count: 0, threadIds: [] },
          terminalSessions: { count: 1, threadKeys: ["codex:thread-1"] },
        }),
      resolveThreadTitles: async () => {
        throw new Error("app-server unavailable");
      },
      log: { warn },
      performQuit: vi.fn(),
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(false);

    // Untitled rows still link correctly — they just read as thread ids.
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          {
            kind: "terminal",
            backend: "codex",
            threadId: "thread-1",
            threadKey: "codex:thread-1",
          },
        ],
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "quit blocker title resolution failed",
      expect.objectContaining({ error: "app-server unavailable" }),
    );
  });
});

describe("buildQuitBlockerSnapshot", () => {
  it("turns every kind of running work into a linkable item", async () => {
    const { buildQuitBlockerSnapshot } = await import("../quit-manager");

    const snapshot = buildQuitBlockerSnapshot({
      inProgressThreads: { count: 1, threadIds: ["codex:thread-turn"] },
      terminalSessions: { count: 1, threadKeys: ["acp%3Agrok:thread-term"] },
      actionRuns: [
        {
          runId: "run-1",
          backend: "codex",
          threadId: "thread-action",
          actionName: "Dev server",
          command: "pnpm dev",
          startedAt: 10,
          pid: 4242,
        },
      ],
    });

    expect(snapshot.count).toBe(3);
    expect(snapshot.actionRunCount).toBe(1);
    expect(snapshot.items).toEqual([
      {
        kind: "turn",
        backend: "codex",
        threadId: "thread-turn",
        threadKey: "codex:thread-turn",
      },
      {
        // The ACP backend kind survives the round trip through the key.
        kind: "terminal",
        backend: "acp:grok",
        threadId: "thread-term",
        threadKey: "acp%3Agrok:thread-term",
      },
      {
        kind: "action",
        backend: "codex",
        threadId: "thread-action",
        threadKey: "codex:thread-action",
        // Named up front: an auto-started action can briefly outrun its own
        // thread's creation, and a row labelled with an empty thread id is
        // worse than useless.
        title: "Dev server",
        detail: "pnpm dev · pid 4242",
      },
    ]);
  });
});

describe("resolveQuitCountdownSeconds", () => {
  it("leaves the countdown alone when there is nothing to read", async () => {
    const { resolveQuitCountdownSeconds } = await import(
      "../quit-confirmation-dialog"
    );

    expect(resolveQuitCountdownSeconds(10, 0)).toBe(10);
  });

  it("buys time to read the list instead of quitting out from under you", async () => {
    const { resolveQuitCountdownSeconds } = await import(
      "../quit-confirmation-dialog"
    );

    // Ten terminals is not a ten-second read.
    expect(resolveQuitCountdownSeconds(10, 10)).toBe(40);
    // ...but an unattended machine still finishes shutting down.
    expect(resolveQuitCountdownSeconds(10, 100)).toBe(60);
  });
});
