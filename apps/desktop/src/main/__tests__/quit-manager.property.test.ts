import { createQuitManager } from "../shell/quit-manager";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const backendRegistryMock = vi.hoisted(() => ({
  getArchiveCleanupCountForQuit: vi.fn(() => 0),
  getThreadInfo: vi.fn(),
  getInProgressThreadSnapshotForQuit: vi.fn(() => ({
    count: 0,
    threadIds: [] as string[],
  })),
  listThreads: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("electron", () => ({
  app: {
    quit: vi.fn(),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: vi.fn(() => backendRegistryMock),
}));

vi.mock("../shell/ipc/integrated-terminal", () => ({
  getIntegratedTerminalQuitSnapshot: vi.fn(() => ({
    count: 0,
    sessionIds: [],
    threads: [],
  })),
  revealIntegratedTerminal: vi.fn(() => ({ revealed: false })),
}));

vi.mock("../shell/window-show-thread", () => ({ requestShowThread: vi.fn() }));

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

beforeEach(() => {
  backendRegistryMock.getThreadInfo.mockReset();
  backendRegistryMock.getInProgressThreadSnapshotForQuit.mockReset();
  backendRegistryMock.getInProgressThreadSnapshotForQuit.mockReturnValue({
    count: 0,
    threadIds: [],
  });
  backendRegistryMock.listThreads.mockReset();
  backendRegistryMock.listThreads.mockResolvedValue([]);
});

describe("quit operation ownership", () => {
  it("only hands a messaging update to the native installer while authorized and idle under the admission hold", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      authorized: fc.boolean(),
      canHoldAdmission: fc.boolean(),
      blockers: fc.nat({ max: 3 }),
      nativeReady: fc.boolean(),
    }), async ({ authorized, canHoldAdmission, blockers, nativeReady }) => {
      let admissionHeld = false;
      const release = vi.fn(() => { admissionHeld = false; });
      const holdIdleUpdateAdmission = vi.fn(() => {
        if (!canHoldAdmission) return undefined;
        admissionHeld = true;
        return release;
      });
      const beforeQuit = vi.fn(() => {
        expect(admissionHeld).toBe(true);
        return nativeReady;
      });
      const performQuit = vi.fn(() => expect(admissionHeld).toBe(true));
      const manager = createQuitManager({
        getConfirmationEnabled: () => false,
        getQuitBlockers: () => {
          expect(admissionHeld).toBe(true);
          return { count: blockers, threadIds: [], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] };
        },
        performQuit: vi.fn(), log: {},
      });
      const canCallNative = authorized && canHoldAdmission && blockers === 0;
      const accepted = canCallNative && nativeReady;
      expect(await manager.requestQuit({
        source: "update-install", authorizeAgent: async () => authorized,
        holdIdleUpdateAdmission, beforeQuit, performQuit,
      })).toBe(accepted);
      expect(beforeQuit).toHaveBeenCalledTimes(Number(canCallNative));
      expect(performQuit).toHaveBeenCalledTimes(Number(accepted));
      expect(release).toHaveBeenCalledTimes(Number(authorized && canHoldAdmission && !accepted));
    }));
  });

  it("uses an authorized chat request without a desktop decision and rechecks before shutdown", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 4 }), async (revoke, peers) => {
      let allowed = true;
      const confirm = vi.fn(async () => "manual-cancel" as const);
      const performQuit = vi.fn();
      const resumeCheckpoint = vi.fn();
      const manager = createQuitManager({
        getConfirmationEnabled: () => true, getFederationPeerCount: () => peers,
        getQuitBlockers: () => ({ count: 1, threadIds: ["working"], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] }),
        confirm, quietForRestart: async () => { if (revoke) allowed = false; },
        resumeAfterCancelledQuietRestart: resumeCheckpoint,
        performQuit, log: {},
      });
      expect(await manager.requestQuit({ source: "agent-tool", quietRestart: true, authorizeAgent: async () => allowed })).toBe(!revoke);
      expect(confirm).not.toHaveBeenCalled();
      expect(performQuit).toHaveBeenCalledTimes(revoke ? 0 : 1);
      expect(resumeCheckpoint).toHaveBeenCalledTimes(revoke ? 1 : 0);
    }), { numRuns: 15 });
  });

  it("a pending quit cannot be bypassed by a later idle snapshot or replaced by another callback", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (idle) => {
      let finish!: (value: "manual-confirm") => void;
      let count = 1;
      const first = vi.fn();
      const competing = vi.fn();
      const manager = createQuitManager({
        getConfirmationEnabled: () => true,
        getQuitBlockers: () => ({ count, threadIds: count ? ["codex:active"] : [], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] }),
        performQuit: vi.fn(), log: {},
        confirm: () => new Promise((resolve) => { finish = resolve; }),
      });
      const pending = manager.requestQuit({ source: "agent-tool", performQuit: first });
      const joined: Promise<boolean>[] = [];
      for (const nowIdle of idle) {
        count = nowIdle ? 0 : 1;
        joined.push(manager.requestQuit({ source: "menu" }));
        expect(await manager.requestQuit({ source: "update-install", performQuit: competing })).toBe(false);
        expect(first).not.toHaveBeenCalled();
        expect(competing).not.toHaveBeenCalled();
      }
      finish("manual-confirm");
      await Promise.all([pending, ...joined]);
      await manager.requestQuit({ source: "menu", performQuit: competing });
      expect(first).toHaveBeenCalledOnce();
      expect(competing).not.toHaveBeenCalled();
    }), { numRuns: 20 });
  });

  it.each([0, 1])("quiet restart is used after acceptance even without a prompt (%s blockers)", async (count) => {
    const order: string[] = [];
    const manager = createQuitManager({
      getConfirmationEnabled: () => false,
      getQuitBlockers: () => ({ count, threadIds: [], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] }),
      quietForRestart: async () => { order.push("quiet"); },
      performQuit: () => { order.push("quit"); }, log: {},
    });
    await manager.requestQuit({ source: "agent-tool", quietRestart: true } as Parameters<typeof manager.requestQuit>[0]);
    expect(order).toEqual(["quiet", "quit"]);
  });
});

it("reserves an immediate quit before authorization can re-enter it", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (authorized) => {
    let competing!: Promise<boolean>;
    const performQuit = vi.fn();
    const otherQuit = vi.fn();
    const manager = createQuitManager({
      getConfirmationEnabled: () => false,
      getQuitBlockers: () => ({ count: 0, threadIds: [], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] }),
      performQuit, log: {},
    });
    expect(await manager.requestQuit({ source: "update-install", beforeQuit: () => {
      competing = manager.requestQuit({ source: "agent-tool", performQuit: otherQuit });
      return authorized;
    } })).toBe(authorized);
    expect(await competing).toBe(false);
    expect(otherQuit).not.toHaveBeenCalled();
    expect(performQuit).toHaveBeenCalledTimes(authorized ? 1 : 0);
  }));
});

it.each(["manual-confirm", "countdown-expired"] as const)("preserves the operator's Quit Now override: %s", async (resolution) => {
  const quiet = vi.fn(async () => undefined);
  const performQuit = vi.fn();
  const manager = createQuitManager({
    getConfirmationEnabled: () => true,
    getQuitBlockers: () => ({ count: 1, threadIds: ["codex:busy"], terminalSessionCount: 0, terminalThreadKeys: [], actionRunCount: 0, items: [] }),
    quietForRestart: quiet, performQuit, log: {}, confirm: async () => resolution,
  });
  expect(await manager.requestQuit({ source: "agent-tool", quietRestart: true })).toBe(true);
  expect(quiet).toHaveBeenCalledTimes(resolution === "manual-confirm" ? 0 : 1);
  expect(performQuit).toHaveBeenCalledOnce();
});
