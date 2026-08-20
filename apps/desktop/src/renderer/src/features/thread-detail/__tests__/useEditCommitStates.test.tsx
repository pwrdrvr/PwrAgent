import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { EditedFileGroup } from "../edited-file-groups";
import { collectEditedFileGroups } from "../edited-file-groups";
import { useEditCommitStates } from "../useEditCommitStates";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function editedGroup(params: {
  key: string;
  paths: string[];
  /** Bumped per delta to model a group whose diff text keeps growing. */
  revision?: number;
}): EditedFileGroup {
  const revision = params.revision ?? 0;
  return {
    key: params.key,
    turn: { id: params.key },
    details: params.paths.map((path, index) => ({
      id: `${params.key}-${index + 1}`,
      kind: "write",
      label: `Update ${path}`,
      path,
      fileDiff: {
        kind: "update",
        diff: `diff for ${path} @${revision}`,
        additions: revision + 1,
        removals: 0,
      },
    })),
    summary: `Edited ${params.paths.length} files`,
    additions: params.paths.length,
    removals: 0,
    live: false,
  };
}

function renderCommitStates(initialGroups: EditedFileGroup[]) {
  const resolveEditCommitStates = vi
    .fn()
    .mockResolvedValue({ states: {} });
  const view = renderHook(
    (groups: EditedFileGroup[]) =>
      useEditCommitStates({
        desktopApi: { resolveEditCommitStates },
        worktreePath: "/repo",
        groups,
      }),
    { initialProps: initialGroups },
  );
  return { ...view, resolveEditCommitStates };
}

/** Run past the hook's resolve debounce. */
async function flushDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe("useEditCommitStates", () => {
  it("does not re-probe git when a delta rebuilds equivalent groups", async () => {
    vi.useFakeTimers();
    const { rerender, resolveEditCommitStates } = renderCommitStates([
      editedGroup({ key: "turn-1", paths: ["/repo/a.ts"] }),
    ]);
    await flushDebounce();
    expect(resolveEditCommitStates).toHaveBeenCalledTimes(1);

    // Same files, fresh objects — what every streamed delta hands the hook.
    for (let revision = 1; revision <= 5; revision += 1) {
      rerender([editedGroup({ key: "turn-1", paths: ["/repo/a.ts"], revision })]);
      await flushDebounce();
    }
    expect(resolveEditCommitStates).toHaveBeenCalledTimes(1);
  });

  it("re-probes git when the edited file set changes", async () => {
    vi.useFakeTimers();
    const { rerender, resolveEditCommitStates } = renderCommitStates([
      editedGroup({ key: "turn-1", paths: ["/repo/a.ts"] }),
    ]);
    await flushDebounce();

    rerender([
      editedGroup({ key: "turn-1", paths: ["/repo/a.ts", "/repo/b.ts"] }),
    ]);
    await flushDebounce();
    expect(resolveEditCommitStates).toHaveBeenCalledTimes(2);
    expect(resolveEditCommitStates.mock.calls[1][0]).toEqual({
      worktreePath: "/repo",
      groups: [{ key: "turn-1", paths: ["/repo/a.ts", "/repo/b.ts"] }],
    });

    // A new turn's group is a change too, even with the same files.
    rerender([
      editedGroup({ key: "turn-2", paths: ["/repo/a.ts", "/repo/b.ts"] }),
    ]);
    await flushDebounce();
    expect(resolveEditCommitStates).toHaveBeenCalledTimes(3);
  });

  it("does not serialize the groups on a streamed delta", () => {
    // The signature used to be `JSON.stringify` over every group's paths,
    // which ran on each delta because a live turn hands over a new array.
    const stringify = vi.spyOn(JSON, "stringify");
    const groups = collectEditedFileGroups({
      entries: [
        {
          type: "activity",
          id: "entry-1",
          createdAt: 1_000,
          summary: "activity",
          turn: { id: "turn-1" },
          details: [
            {
              id: "detail-1",
              kind: "write",
              label: "Update a.ts",
              path: "/repo/a.ts",
              fileDiff: {
                kind: "update",
                diff: "diff",
                additions: 1,
                removals: 0,
              },
            },
          ],
        },
      ],
    });
    const { rerender } = renderCommitStates(groups);
    stringify.mockClear();

    rerender([...groups]);
    expect(stringify).not.toHaveBeenCalled();
  });
});
