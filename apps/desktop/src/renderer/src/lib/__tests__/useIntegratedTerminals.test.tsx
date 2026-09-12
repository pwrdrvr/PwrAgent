import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IntegratedTerminalSessionSummary } from "../../../../shared/integrated-terminal";
import type { DesktopApi } from "../desktop-api";
import { useIntegratedTerminals } from "../useIntegratedTerminals";

function remoteSession(
  overrides: Partial<IntegratedTerminalSessionSummary> = {},
): IntegratedTerminalSessionSummary {
  return {
    sessionId: "remote-session",
    threadKey: "codex:remote-thread",
    cwd: "/owner/worktree",
    shell: "/bin/zsh",
    panelHidden: false,
    createdAt: 10,
    remote: {
      instanceId: "peer-a",
      instanceLabel: "Peer Mac",
      celestialIcon: "moon",
    },
    ...overrides,
  };
}

describe("useIntegratedTerminals", () => {
  it("rebuilds a rediscovered remote session's routing target from its summary", async () => {
    // The reload / remount path: main reports the live session, the pane was
    // never created in this renderer, so the target has to come back from
    // the summary — otherwise a re-attach would spawn locally.
    const desktopApi: DesktopApi = {
      listIntegratedTerminals: vi.fn(async () => [remoteSession()]),
    };
    const { result } = renderHook(() => useIntegratedTerminals(desktopApi));

    await waitFor(() => {
      expect(result.current.panes).toHaveLength(1);
    });
    const pane = result.current.panes[0]!;
    expect(pane.threadKey).toBe("codex:remote-thread");
    expect(pane.remote).toEqual({
      instanceId: "peer-a",
      instanceLabel: "Peer Mac",
      celestialIcon: "moon",
      target: { scope: "remote", instanceId: "peer-a" },
    });
  });

  it("keeps local sessions free of a remote identity", async () => {
    const desktopApi: DesktopApi = {
      listIntegratedTerminals: vi.fn(async () => [
        remoteSession({
          sessionId: "local-session",
          threadKey: "codex:local-thread",
          remote: undefined,
        }),
      ]),
    };
    const { result } = renderHook(() => useIntegratedTerminals(desktopApi));

    await waitFor(() => {
      expect(result.current.panes).toHaveLength(1);
    });
    expect(result.current.panes[0]?.remote).toBeUndefined();
  });

  // The quit dialog's row link. Main un-hides exactly the shell the operator
  // clicked, so the renderer must not reach for the thread: `openPanel`, the
  // fallback this used to run, un-hides every terminal the thread owns.
  it("converges on the revealed terminal without touching its siblings", async () => {
    let emitReveal!: (event: {
      sessionId: string;
      threadKey: string;
    }) => void;
    const setIntegratedTerminalPanelHidden = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      listIntegratedTerminals: vi.fn(async () => [
        remoteSession({
          sessionId: "term-1",
          threadKey: "codex:thread-a",
          remote: undefined,
          panelHidden: true,
          createdAt: 1,
        }),
        remoteSession({
          sessionId: "term-2",
          threadKey: "codex:thread-a",
          remote: undefined,
          panelHidden: true,
          createdAt: 2,
        }),
      ]),
      onIntegratedTerminalReveal: (callback) => {
        emitReveal = callback;
        return () => undefined;
      },
      setIntegratedTerminalPanelHidden,
    };
    const { result } = renderHook(() => useIntegratedTerminals(desktopApi));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });
    setIntegratedTerminalPanelHidden.mockClear();

    act(() => {
      emitReveal({ sessionId: "term-2", threadKey: "codex:thread-a" });
    });

    // Exactly one call, for the terminal the event named. The thread-scoped
    // fallback fired on this very path — both terminals read as collapsed
    // until React re-renders, so the "already open?" guard was always false.
    expect(setIntegratedTerminalPanelHidden.mock.calls).toEqual([
      [{ sessionId: "term-2", hidden: false }],
    ]);
  });

  it("ignores a reveal for a terminal this window has no record of", async () => {
    let emitReveal!: (event: {
      sessionId: string;
      threadKey: string;
    }) => void;
    const setIntegratedTerminalPanelHidden = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      listIntegratedTerminals: vi.fn(async () => []),
      onIntegratedTerminalReveal: (callback) => {
        emitReveal = callback;
        return () => undefined;
      },
      setIntegratedTerminalPanelHidden,
    };
    const { result } = renderHook(() => useIntegratedTerminals(desktopApi));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(0);
    });

    act(() => {
      emitReveal({ sessionId: "term-gone", threadKey: "codex:thread-a" });
    });

    // Acting here would open a panel for a thread with no session, which is
    // what spawns a brand-new shell out of trying to look at one.
    expect(setIntegratedTerminalPanelHidden).not.toHaveBeenCalled();
    expect(result.current.panes).toHaveLength(0);
  });

  it("carries the owning instance on a pane opened before its session lands", () => {
    const desktopApi: DesktopApi = {
      listIntegratedTerminals: vi.fn(async () => []),
    };
    const { result } = renderHook(() => useIntegratedTerminals(desktopApi));

    act(() => {
      result.current.openPanel("codex:remote-thread", undefined, {
        instanceId: "peer-a",
        instanceLabel: "Peer Mac",
        celestialIcon: "moon",
        target: { scope: "remote", instanceId: "peer-a" },
      });
    });

    // The local pane is what calls createIntegratedTerminal, so it must
    // carry the target that routes the create to the owner.
    expect(result.current.panes[0]?.remote?.target).toEqual({
      scope: "remote",
      instanceId: "peer-a",
    });
  });
});
