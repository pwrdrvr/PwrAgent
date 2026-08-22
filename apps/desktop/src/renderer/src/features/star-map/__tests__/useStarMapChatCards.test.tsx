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
            instanceDx: -100,
            instanceDy: -50,
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
      result.current.resolveRestoredAnchors(() => ({
        point: { x: 100, y: 200 },
        basis: "anchor",
      }));
    });
    expect(result.current.cards[0].rect).toMatchObject({ left: 140, top: 230 });

    act(() => {
      result.current.resolveRestoredAnchors(() => ({
        point: { x: 900, y: 900 },
        basis: "anchor",
      }));
    });
    expect(result.current.cards[0].rect).toMatchObject({ left: 140, top: 230 });
  });

  it("uses the separately persisted instance basis when a thread is absent", async () => {
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.resolveRestoredAnchors(() => ({
        point: { x: 500, y: 400 },
        basis: "instance",
      }));
    });

    expect(result.current.cards[0].rect).toMatchObject({ left: 400, top: 350 });
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
      baseRevision: 4,
      workspace: expect.objectContaining({
        cards: [
          expect.objectContaining({
            geometry: expect.objectContaining({ dx: 600, dy: 300 }),
          }),
        ],
      }),
    });
  });

  it("coalesces raising a non-top card and dragging it into one write", async () => {
    const writeStarMapWorkspace = vi.fn(
      async ({ baseRevision, workspace }: WriteStarMapWorkspaceRequest) => ({
        workspace: {
          ...workspace,
          revision: baseRevision + 1,
          updatedAt: 200,
        },
      }),
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const secondThread = {
      ...savedWorkspace().workspace.cards[0].thread,
      id: "t-second",
      title: "Second card",
    };
    act(() => {
      result.current.open(
        "pwr_remote",
        secondThread,
        undefined,
        { persist: false },
      );
    });

    const nextRect = { left: 760, top: 360, width: 460, height: 560 };
    act(() => {
      expect(
        result.current.raise("pwr_remote::codex:t-remote", false),
      ).toBe(true);
      result.current.setRect("pwr_remote::codex:t-remote", nextRect);
      result.current.commitRect("pwr_remote::codex:t-remote", nextRect);
    });

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(1));
    expect(writeStarMapWorkspace).toHaveBeenCalledWith({
      baseRevision: 4,
      workspace: expect.objectContaining({
        cards: expect.arrayContaining([
          expect.objectContaining({
            key: "pwr_remote::codex:t-remote",
            geometry: expect.objectContaining({ fallbackRect: nextRect }),
          }),
        ]),
      }),
    });
  });

  it("keeps placeholder local cards memory-only until remapping the owner", async () => {
    const writeStarMapWorkspace = vi.fn(
      async ({ baseRevision, workspace }: WriteStarMapWorkspaceRequest) => ({
        workspace: {
          ...workspace,
          revision: baseRevision + 1,
          updatedAt: 200,
        },
      }),
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const localThread = {
      ...savedWorkspace().workspace.cards[0].thread,
      id: "t-local",
      title: "Local before health",
      federation: undefined,
    };

    act(() => {
      result.current.open("local", localThread, undefined, { persist: false });
    });
    expect(writeStarMapWorkspace).not.toHaveBeenCalled();

    act(() => result.current.remapOwner("local", "pwr_local"));

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(1));
    expect(result.current.cards.at(-1)).toMatchObject({
      key: "pwr_local::codex:t-local",
      ownerInstanceId: "pwr_local",
    });
    expect(writeStarMapWorkspace).toHaveBeenCalledWith({
      baseRevision: 4,
      workspace: expect.objectContaining({
        cards: expect.arrayContaining([
          expect.objectContaining({ key: "pwr_local::codex:t-local" }),
        ]),
      }),
    });
  });

  it("advances the optimistic base revision after each queued write", async () => {
    const writeStarMapWorkspace = vi.fn(
      async ({ baseRevision, workspace }: WriteStarMapWorkspaceRequest) => ({
        workspace: {
          ...workspace,
          revision: baseRevision + 1,
          updatedAt: 200,
        },
      }),
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.toggleContext("pwr_remote::codex:t-remote");
      result.current.toggleTerminal("pwr_remote::codex:t-remote");
    });

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(2));
    expect(writeStarMapWorkspace.mock.calls[0][0].baseRevision).toBe(4);
    expect(writeStarMapWorkspace.mock.calls[1][0].baseRevision).toBe(5);
  });

  it("carries a failed workspace change into the next boundary", async () => {
    let failNextWrite = true;
    const writeStarMapWorkspace = vi.fn(
      async ({ baseRevision, workspace }: WriteStarMapWorkspaceRequest) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("temporary database failure");
        }
        return {
          workspace: {
            ...workspace,
            revision: baseRevision + 1,
            updatedAt: 200,
          },
        };
      },
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace: vi.fn(async () => savedWorkspace()),
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.toggleContext("pwr_remote::codex:t-remote"));
    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(1));
    act(() => result.current.toggleTerminal("pwr_remote::codex:t-remote"));

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(2));
    expect(writeStarMapWorkspace.mock.calls[1][0]).toMatchObject({
      baseRevision: 4,
      workspace: {
        cards: [
          expect.objectContaining({
            contextOpen: false,
            terminalOpen: false,
          }),
        ],
      },
    });
  });

  it("rebases queued semantic changes after a revision conflict", async () => {
    const initial = savedWorkspace();
    const concurrentCard = {
      ...initial.workspace.cards[0],
      key: "pwr_remote::codex:t-concurrent",
      thread: {
        ...initial.workspace.cards[0].thread,
        id: "t-concurrent",
        title: "Opened in another window",
      },
    };
    const concurrent: ReadStarMapWorkspaceResponse = {
      workspace: {
        ...initial.workspace,
        revision: 5,
        updatedAt: 150,
        cards: [
          {
            ...initial.workspace.cards[0],
            geometry: {
              ...initial.workspace.cards[0].geometry,
              fallbackRect: {
                ...initial.workspace.cards[0].geometry.fallbackRect,
                left: 920,
              },
            },
          },
          concurrentCard,
        ],
      },
    };
    const readStarMapWorkspace = vi
      .fn<NonNullable<DesktopApi["readStarMapWorkspace"]>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(concurrent);
    let rejectForConflict = true;
    const writeStarMapWorkspace = vi.fn(
      async ({ baseRevision, workspace }: WriteStarMapWorkspaceRequest) => {
        if (rejectForConflict) {
          rejectForConflict = false;
          throw new Error(
            "Star Map workspace revision conflict: expected 4, found 5",
          );
        }
        return {
          workspace: {
            ...workspace,
            revision: baseRevision + 1,
            updatedAt: 200,
          },
        };
      },
    );
    const desktopApi: DesktopApi = {
      readStarMapWorkspace,
      writeStarMapWorkspace,
    };
    const { result } = renderHook(() => useStarMapChatCards({ desktopApi }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.toggleContext("pwr_remote::codex:t-remote");
      result.current.toggleTerminal("pwr_remote::codex:t-remote");
    });

    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(3));
    expect(readStarMapWorkspace).toHaveBeenCalledTimes(2);
    expect(writeStarMapWorkspace.mock.calls[1][0]).toMatchObject({
      baseRevision: 5,
      workspace: {
        cards: [
          expect.objectContaining({
            key: "pwr_remote::codex:t-remote",
            contextOpen: false,
            terminalOpen: true,
            geometry: expect.objectContaining({
              fallbackRect: expect.objectContaining({ left: 920 }),
            }),
          }),
          expect.objectContaining({
            key: "pwr_remote::codex:t-concurrent",
          }),
        ],
      },
    });
    expect(writeStarMapWorkspace.mock.calls[2][0]).toMatchObject({
      baseRevision: 6,
      workspace: {
        cards: [
          expect.objectContaining({
            key: "pwr_remote::codex:t-remote",
            contextOpen: false,
            terminalOpen: false,
            geometry: expect.objectContaining({
              fallbackRect: expect.objectContaining({ left: 920 }),
            }),
          }),
          expect.objectContaining({
            key: "pwr_remote::codex:t-concurrent",
          }),
        ],
      },
    });

    act(() => result.current.toggleContext("pwr_remote::codex:t-remote"));
    await waitFor(() => expect(writeStarMapWorkspace).toHaveBeenCalledTimes(4));
    expect(writeStarMapWorkspace.mock.calls[3][0].baseRevision).toBe(7);
    expect(
      writeStarMapWorkspace.mock.calls[3][0].workspace.cards,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "pwr_remote::codex:t-concurrent" }),
      ]),
    );
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
