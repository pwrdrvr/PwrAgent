import { act, renderHook, waitFor } from "@testing-library/react";
import {
  STAR_MAP_WORKSPACE_VERSION,
  type ReadStarMapWorkspaceResponse,
  type WriteStarMapWorkspaceRequest,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useStarMapChatCards } from "../useStarMapChatCards";

function savedWorkspace(): ReadStarMapWorkspaceResponse {
  return {
    workspace: {
      version: STAR_MAP_WORKSPACE_VERSION,
      revision: 4,
      updatedAt: 100,
      cards: [
        {
          key: "pwr_remote::codex:t-remote",
          ownerInstanceId: "pwr_remote",
          thread: {
            id: "t-remote",
            inbox: { inInbox: true },
            linkedDirectories: [],
            source: "codex",
            title: "Offline but still open",
            titleSource: "derived",
            federation: {
              ref: {
                backend: "codex",
                threadId: "t-remote",
                target: { scope: "remote", instanceId: "pwr_remote" },
              },
              instanceLabel: "Remote Mac",
              peerStatus: "disconnected",
            },
          },
          geometry: {
            anchor: {
              kind: "thread",
              instanceId: "pwr_remote",
              threadKey: "codex:t-remote",
            },
            dx: 40,
            dy: 30,
            fallbackRect: {
              left: 700,
              top: 300,
              width: 420,
              height: 520,
            },
          },
          contextOpen: true,
          terminalOpen: true,
          terminalHeight: 320,
        },
      ],
      views: { orbit: { x: -200, y: 90, scale: 0.75 } },
    },
  };
}

describe("useStarMapChatCards", () => {
  it("restores disconnected chats and their complete compound-card state", async () => {
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0]).toMatchObject({
      key: "pwr_remote::codex:t-remote",
      ownerInstanceId: "pwr_remote",
      contextOpen: true,
      terminalOpen: true,
      terminalHeight: 320,
      rect: { left: 700, top: 300, width: 420, height: 520 },
      thread: { title: "Offline but still open" },
    });
    expect(result.current.viewFor("orbit")).toEqual({
      x: -200,
      y: 90,
      scale: 0.75,
    });
  });

  it("resolves a saved relative anchor once without jumping later", async () => {
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.resolveRestoredAnchors(() => ({ x: 100, y: 200 }));
    });
    expect(result.current.cards[0].rect).toMatchObject({ left: 140, top: 230 });

    act(() => {
      result.current.resolveRestoredAnchors(() => ({ x: 900, y: 900 }));
    });
    expect(result.current.cards[0].rect).toMatchObject({ left: 140, top: 230 });
  });

  it("keeps pointer frames memory-only and writes once at commit", async () => {
    const writeStarMapWorkspace = vi.fn(
      async ({ workspace }: WriteStarMapWorkspaceRequest) => ({
        workspace: { ...workspace, revision: 5, updatedAt: 200 },
      }),
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    const nextRect = { left: 800, top: 400, width: 500, height: 600 };
    act(() => {
      result.current.setRect("pwr_remote::codex:t-remote", nextRect);
      result.current.setRect("pwr_remote::codex:t-remote", {
        ...nextRect,
        left: 801,
      });
    });
    expect(writeStarMapWorkspace).not.toHaveBeenCalled();

    act(() => {
      result.current.commitRect(
        "pwr_remote::codex:t-remote",
        nextRect,
        {
          anchor: {
            kind: "instance",
            instanceId: "pwr_remote",
          },
          point: { x: 200, y: 100 },
        },
      );
    });

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(1));
    expect(writeStarMapWorkspace).toHaveBeenCalledWith({
      workspace: expect.objectContaining({
        cards: [
          expect.objectContaining({
            geometry: expect.objectContaining({ dx: 600, dy: 300 }),
          }),
        ],
      }),
    });
  });

  it("merges operator changes made while the saved workspace is loading", async () => {
    let resolveRead: (value: ReadStarMapWorkspaceResponse) => void = () => {};
    const read = new Promise<ReadStarMapWorkspaceResponse>((resolve) => {
      resolveRead = resolve;
    });
    const writeStarMapWorkspace = vi.fn(
      async ({ workspace }: WriteStarMapWorkspaceRequest) => ({
        workspace: { ...workspace, revision: 5, updatedAt: 200 },
      }),
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(() => read),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    const thread = {
      ...savedWorkspace().workspace.cards[0].thread,
      id: "t-local",
      title: "Opened during launch",
      federation: undefined,
    };

    act(() => result.current.open("pwr_local", thread));
    expect(writeStarMapWorkspace).not.toHaveBeenCalled();

    await act(async () => resolveRead(savedWorkspace()));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(1));
    expect(result.current.cards.map((card) => card.key)).toEqual([
      "pwr_remote::codex:t-remote",
      "pwr_local::codex:t-local",
    ]);
  });
});
