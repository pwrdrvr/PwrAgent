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
    threads: [],
  })),
  revealIntegratedTerminal: vi.fn(() => ({ revealed: false })),
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

  // A repeat quit request while the prompt is open collapses onto the same
  // pending promise, which is fine only if it still reaches the user: any
  // deliberate interaction cancels the prompt's countdown for good, so from
  // then on nothing but the dialog settles the quit — and a dialog sitting
  // behind the main window reads as an app that refuses to quit.
  it("raises the open confirmation when a quit is requested again", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const info = vi.fn();
    const focusPendingConfirmation = vi.fn(() => true);
    let resolveConfirm!: (value: "manual-confirm") => void;
    const confirm = vi.fn(
      async () =>
        await new Promise<"manual-confirm">((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const manager = createQuitManager({
      confirm,
      focusPendingConfirmation,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 1,
        terminalThreadKeys: ["codex:thread-terminal"],
        threadIds: [],
        actionRunCount: 0,
        items: [],
      }),
      log: { info },
      performQuit,
    });

    const first = manager.requestQuit({ source: "before-quit" });
    const second = manager.requestQuit({ source: "before-quit" });

    expect(focusPendingConfirmation).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "quit requested while confirmation is open",
      expect.objectContaining({ raisedConfirmation: true }),
    );

    resolveConfirm("manual-confirm");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(performQuit).toHaveBeenCalledTimes(1);
  });

  it("records a repeat request with nothing to raise", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const info = vi.fn();
    let resolveConfirm!: (value: "manual-cancel") => void;
    const confirm = vi.fn(
      async () =>
        await new Promise<"manual-cancel">((resolve) => {
          resolveConfirm = resolve;
        }),
    );
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
      log: { info },
      performQuit: vi.fn(),
    });

    const first = manager.requestQuit({ source: "menu" });
    const second = manager.requestQuit({ source: "menu" });

    expect(info).toHaveBeenCalledWith(
      "quit requested while confirmation is open",
      expect.objectContaining({ raisedConfirmation: false }),
    );

    resolveConfirm("manual-cancel");
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
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
          terminalSessions: {
            count: 1,
            threads: [{ threadKey: "codex:thread-1" }],
          },
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

  it("titles a remote terminal row from its owning peer, not the local list", async () => {
    const { buildQuitBlockerSnapshot, createQuitManager, quitBlockerTitleKey } =
      await import("../quit-manager");
    const confirm = vi.fn(async () => "manual-cancel" as const);
    const target = { scope: "remote" as const, instanceId: "peer-a" };
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () =>
        buildQuitBlockerSnapshot({
          inProgressThreads: { count: 0, threadIds: [] },
          terminalSessions: {
            count: 1,
            threads: [
              {
                threadKey: "codex:0f9c2b7a-remote",
                target,
                instanceLabel: "Studio Mac",
              },
            ],
          },
        }),
      resolveThreadTitles: async (items) =>
        new Map(
          items.map((item) => [
            quitBlockerTitleKey(item),
            item.target ? "Reap Windows Worktrees" : "wrong thread",
          ]),
        ),
      log: {},
      performQuit: vi.fn(),
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            kind: "terminal",
            title: "Reap Windows Worktrees",
            threadKey: "codex:0f9c2b7a-remote",
            target,
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
          terminalSessions: {
            count: 1,
            threads: [{ threadKey: "codex:thread-1" }],
          },
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

  it("resumes automation dispatch when the operator stays open", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const resumeDispatch = vi.fn(async () => undefined);
    const quiesceAutomationDispatch = vi.fn(() => resumeDispatch);
    const manager = createQuitManager({
      confirm: vi.fn(async () => "manual-cancel" as const),
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: [],
        automationRunCount: 1,
        actionRunCount: 0,
        items: [],
      }),
      quiesceAutomationDispatch,
      log: {},
      performQuit: vi.fn(),
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(false);

    expect(quiesceAutomationDispatch).toHaveBeenCalledTimes(1);
    expect(resumeDispatch).toHaveBeenCalledTimes(1);
  });

  it("allows a new quit prompt while queued automation dispatch is still resuming", async () => {
    const { createQuitManager } = await import("../quit-manager");
    let finishResume!: () => void;
    const resumePending = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    const resumeDispatch = vi.fn(() => resumePending);
    const confirm = vi
      .fn()
      .mockResolvedValueOnce("manual-cancel" as const)
      .mockResolvedValueOnce("manual-confirm" as const);
    const performQuit = vi.fn();
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getQuitBlockers: () => ({
        count: 1,
        terminalSessionCount: 0,
        terminalThreadKeys: [],
        threadIds: [],
        automationRunCount: 1,
        actionRunCount: 0,
        items: [],
      }),
      quiesceAutomationDispatch: () => resumeDispatch,
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(false);
    expect(resumeDispatch).toHaveBeenCalledTimes(1);

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(true);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(performQuit).toHaveBeenCalledTimes(1);
    finishResume();
    await resumePending;
  });
});

describe("buildQuitBlockerSnapshot", () => {
  it("collapses an ephemeral automation execution onto its named Agent run", async () => {
    const { buildQuitBlockerSnapshot } = await import("../quit-manager");

    const snapshot = buildQuitBlockerSnapshot({
      inProgressThreads: {
        count: 1,
        threadIds: [],
        automationRuns: [
          {
            agentThreadId: "agent-thread-1",
            automationName: "Search Bots",
            automationRunId: "automation-run:1",
            backend: "codex",
            startedAt: new Date("2026-08-12T20:29:31-04:00").getTime(),
          },
        ],
      },
      terminalSessions: { count: 0, threads: [] },
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.threadIds).toEqual([]);
    expect(snapshot.automationRunCount).toBe(1);
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "automation",
        backend: "codex",
        threadId: "agent-thread-1",
        threadKey: "codex:agent-thread-1",
        title: "Search Bots",
        detail: expect.stringMatching(/^Started /),
      }),
    ]);
  });

  it("turns every kind of running work into a linkable item", async () => {
    const { buildQuitBlockerSnapshot } = await import("../quit-manager");

    const snapshot = buildQuitBlockerSnapshot({
      inProgressThreads: { count: 1, threadIds: ["codex:thread-turn"] },
      terminalSessions: {
        count: 1,
        threads: [{ threadKey: "acp:grok:thread-term" }],
      },
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
        threadKey: "acp:grok:thread-term",
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

  it("carries a remote terminal's owning peer onto its row", async () => {
    const { buildQuitBlockerSnapshot } = await import("../quit-manager");

    const snapshot = buildQuitBlockerSnapshot({
      inProgressThreads: { count: 0, threadIds: [] },
      terminalSessions: {
        count: 2,
        threads: [
          { threadKey: "codex:local-thread" },
          {
            threadKey: "codex:remote-thread",
            target: { scope: "remote", instanceId: "peer-a" },
            instanceLabel: "Studio Mac",
          },
        ],
      },
    });

    // Without the target the title resolver has no way to know the thread
    // lives on another machine, and the row reads as a raw uuid.
    expect(snapshot.items).toEqual([
      {
        kind: "terminal",
        backend: "codex",
        threadId: "local-thread",
        threadKey: "codex:local-thread",
      },
      {
        kind: "terminal",
        backend: "codex",
        threadId: "remote-thread",
        threadKey: "codex:remote-thread",
        target: { scope: "remote", instanceId: "peer-a" },
        // The peer's name is the only thing distinguishing this row from a
        // local shell on a thread with the same key.
        detail: "Studio Mac",
      },
    ]);
    expect(snapshot.terminalThreadKeys).toEqual([
      "codex:local-thread",
      "codex:remote-thread",
    ]);
  });
});

describe("resolveQuitBlockerThreadTitles", () => {
  const localItem = {
    kind: "terminal" as const,
    backend: "codex" as const,
    threadId: "local-thread",
    threadKey: "codex:local-thread",
  };
  const remoteItem = {
    kind: "terminal" as const,
    backend: "codex" as const,
    threadId: "0f9c2b7a-remote",
    threadKey: "codex:0f9c2b7a-remote",
    target: { scope: "remote" as const, instanceId: "peer-a" },
  };

  it("names a remote thread from the peer's cached navigation summary", async () => {
    const { resolveQuitBlockerThreadTitles, quitBlockerTitleKey } = await import(
      "../quit-manager"
    );
    const listLocalThreads = vi.fn(async () => [
      { source: "codex" as const, id: "local-thread", title: "Local Work" },
    ]);
    const cachedRemoteThreadName = vi.fn(() => ({
      title: "Reap Windows Worktrees",
      titleSource: "derived" as const,
    }));
    const listRemoteThreadPins = vi.fn(async () => []);

    const titles = await resolveQuitBlockerThreadTitles([localItem, remoteItem], {
      listLocalThreads,
      cachedRemoteThreadName,
      listRemoteThreadPins,
    });

    expect(titles.get(quitBlockerTitleKey(remoteItem))).toBe(
      "Reap Windows Worktrees",
    );
    expect(titles.get(quitBlockerTitleKey(localItem))).toBe("Local Work");
    expect(cachedRemoteThreadName).toHaveBeenCalledWith({
      target: { scope: "remote", instanceId: "peer-a" },
      backend: "codex",
      threadId: "0f9c2b7a-remote",
    });
    // The local list is a peer-blind lookup; asking it about a remote thread
    // is what produced the uuid in the first place.
    expect(listLocalThreads).toHaveBeenCalledTimes(1);
    // The memory cache answered, so the store is never read.
    expect(listRemoteThreadPins).not.toHaveBeenCalled();
  });

  it("falls back to the pinned row's cached title when nothing is cached in memory", async () => {
    const { resolveQuitBlockerThreadTitles, quitBlockerTitleKey } = await import(
      "../quit-manager"
    );

    const titles = await resolveQuitBlockerThreadTitles([remoteItem], {
      listLocalThreads: async () => [],
      cachedRemoteThreadName: () => undefined,
      listRemoteThreadPins: async () => [
        {
          ref: {
            backend: "codex" as const,
            threadId: "0f9c2b7a-remote",
            target: { scope: "remote" as const, instanceId: "peer-a" },
          },
          addedAt: 1,
          instanceLabel: "Studio Mac",
          summary: {
            source: "codex" as const,
            id: "0f9c2b7a-remote",
            title: "Reap Windows Worktrees",
            titleSource: "derived" as const,
            linkedDirectories: [],
            inbox: { inInbox: false },
          },
        },
      ],
    });

    expect(titles.get(quitBlockerTitleKey(remoteItem))).toBe(
      "Reap Windows Worktrees",
    );
  });

  // A thread can only be a quit blocker because it is mounted in a window on
  // this machine, so its name is already cached. Reaching for the peer here
  // could only re-answer a question we can answer, while making shutdown wait
  // on a machine that may be asleep.
  it("never waits on a peer", async () => {
    const { resolveQuitBlockerThreadTitles, quitBlockerTitleKey } = await import(
      "../quit-manager"
    );
    let settled = false;

    const pending = resolveQuitBlockerThreadTitles([remoteItem], {
      listLocalThreads: async () => [],
      cachedRemoteThreadName: () => ({
        title: "Reap Windows Worktrees",
        titleSource: "derived" as const,
      }),
      // A peer round trip would park here forever. Nothing may await it.
      listRemoteThreadPins: () => new Promise(() => undefined),
    }).then((titles) => {
      settled = true;
      return titles;
    });

    const titles = await pending;
    expect(settled).toBe(true);
    expect(titles.get(quitBlockerTitleKey(remoteItem))).toBe(
      "Reap Windows Worktrees",
    );
  });

  it("ignores a fallback title, which is just the thread id again", async () => {
    const { resolveQuitBlockerThreadTitles } = await import("../quit-manager");

    const titles = await resolveQuitBlockerThreadTitles([remoteItem], {
      listLocalThreads: async () => [],
      cachedRemoteThreadName: () => ({
        title: "0f9c2b7a-remote",
        titleSource: "fallback" as const,
      }),
      listRemoteThreadPins: async () => [],
    });

    expect(titles.size).toBe(0);
  });

  it("keeps a remote thread's title off a local thread that shares its key", async () => {
    const { resolveQuitBlockerThreadTitles, quitBlockerTitleKey } = await import(
      "../quit-manager"
    );
    const collidingLocal = {
      kind: "turn" as const,
      backend: "codex" as const,
      threadId: "0f9c2b7a-remote",
      threadKey: "codex:0f9c2b7a-remote",
    };

    const titles = await resolveQuitBlockerThreadTitles(
      [collidingLocal, remoteItem],
      {
        listLocalThreads: async () => [],
        cachedRemoteThreadName: () => ({
          title: "Reap Windows Worktrees",
          titleSource: "derived" as const,
        }),
        listRemoteThreadPins: async () => [],
      },
    );

    expect(titles.get(quitBlockerTitleKey(remoteItem))).toBe(
      "Reap Windows Worktrees",
    );
    expect(titles.get(quitBlockerTitleKey(collidingLocal))).toBeUndefined();
  });

  it("still names local rows when the remote lookups throw", async () => {
    const { resolveQuitBlockerThreadTitles, quitBlockerTitleKey } = await import(
      "../quit-manager"
    );

    const titles = await resolveQuitBlockerThreadTitles([localItem, remoteItem], {
      listLocalThreads: async () => [
        { source: "codex" as const, id: "local-thread", title: "Local Work" },
      ],
      cachedRemoteThreadName: () => {
        throw new Error("federation runtime unavailable");
      },
      listRemoteThreadPins: async () => {
        throw new Error("overlay store unavailable");
      },
    });

    expect(titles.get(quitBlockerTitleKey(localItem))).toBe("Local Work");
    expect(titles.get(quitBlockerTitleKey(remoteItem))).toBeUndefined();
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
