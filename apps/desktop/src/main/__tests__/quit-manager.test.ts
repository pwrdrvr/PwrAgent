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
      }),
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "menu" })).resolves.toBe(true);

    expect(confirm).not.toHaveBeenCalled();
    expect(performQuit).toHaveBeenCalledTimes(1);
  });
});
