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
