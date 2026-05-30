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
      getInProgressThreads: () => ({ count: 0, threadIds: [] }),
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
      getInProgressThreads: () => ({
        count: 2,
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
      }),
    );
    expect(performQuit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "quit requested with in-progress threads",
      expect.objectContaining({ count: 2 }),
    );
  });

  it("cancels quit when the operator stays open", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const confirm = vi.fn(async () => "manual-cancel" as const);
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => true,
      getInProgressThreads: () => ({
        count: 1,
        threadIds: ["codex:thread-1"],
      }),
      log: {},
      performQuit,
    });

    await expect(manager.requestQuit({ source: "ipc" })).resolves.toBe(false);

    expect(performQuit).not.toHaveBeenCalled();
  });

  it("quits without prompting when confirmation is disabled", async () => {
    const { createQuitManager } = await import("../quit-manager");
    const performQuit = vi.fn();
    const confirm = vi.fn();
    const manager = createQuitManager({
      confirm,
      getConfirmationEnabled: () => false,
      getInProgressThreads: () => ({
        count: 1,
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
