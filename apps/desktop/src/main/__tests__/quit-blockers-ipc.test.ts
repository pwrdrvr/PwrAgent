import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../quit-manager", () => ({
  getCurrentQuitBlockers: vi.fn(),
  readQuitBlockerQueueSnapshot: vi.fn(),
}));

vi.mock("../ipc/integrated-terminal", () => ({
  revealIntegratedTerminal: vi.fn(),
}));

vi.mock("../window-show-thread", () => ({
  requestShowThread: vi.fn(),
}));

import type { WebContents } from "electron";
import { getCurrentQuitBlockers } from "../quit-manager";
import { revealIntegratedTerminal } from "../ipc/integrated-terminal";
import { requestShowThread } from "../window-show-thread";
import { revealCurrentQuitBlocker } from "../ipc/quit-blockers";

describe("quit blocker IPC", () => {
  const sender = { id: 10 } as unknown as WebContents;
  const owner = { id: 11 } as unknown as WebContents;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reveals the authoritative remote item and keeps its mounted viewer route", () => {
    vi.mocked(getCurrentQuitBlockers).mockReturnValue({
      count: 2,
      terminalSessionCount: 2,
      terminalThreadKeys: ["codex:shared", "codex:shared"],
      threadIds: [],
      actionRunCount: 0,
      automationRunCount: 0,
      items: [
        {
          kind: "terminal",
          backend: "codex",
          threadId: "shared",
          threadKey: "codex:shared",
        },
        {
          kind: "terminal",
          backend: "codex",
          threadId: "shared",
          threadKey: "codex:shared",
          target: { scope: "remote", instanceId: "peer-a" },
        },
      ],
    });
    vi.mocked(revealIntegratedTerminal).mockReturnValue({
      revealed: true,
      owner,
    });

    expect(
      revealCurrentQuitBlocker(
        {
          kind: "terminal",
          threadKey: "codex:shared",
          target: { scope: "remote", instanceId: "peer-a" },
        },
        sender,
      ),
    ).toEqual({ revealed: true });
    expect(revealIntegratedTerminal).toHaveBeenCalledWith("codex:shared", {
      instanceId: "peer-a",
    });
    expect(requestShowThread).toHaveBeenCalledWith(
      { backend: "codex", threadId: "shared" },
      { preferWebContents: owner },
    );
  });

  it("does not navigate after the requested blocker has resolved", () => {
    vi.mocked(getCurrentQuitBlockers).mockReturnValue({
      count: 0,
      terminalSessionCount: 0,
      terminalThreadKeys: [],
      threadIds: [],
      actionRunCount: 0,
      automationRunCount: 0,
      items: [],
    });

    expect(
      revealCurrentQuitBlocker(
        { kind: "turn", threadKey: "codex:finished" },
        sender,
      ),
    ).toEqual({ revealed: false });
    expect(revealIntegratedTerminal).not.toHaveBeenCalled();
    expect(requestShowThread).not.toHaveBeenCalled();
  });
});
