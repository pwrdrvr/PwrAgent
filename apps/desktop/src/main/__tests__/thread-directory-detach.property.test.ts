import type { LinkedDirectorySummary, ThreadOverlayState } from "@pwragent/shared";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { detachOwnedThreadDirectory } from "../app-server/thread-directory-detach";

function worktree(name: string): LinkedDirectorySummary {
  return {
    id: `/fixture/worktrees/${name}/Project`,
    kind: "worktree",
    label: "Project",
    path: "/fixture/repos/Project",
    worktreePath: `/fixture/worktrees/${name}/Project`,
  };
}

function setup(
  projectKey: string,
  providerDirectory: LinkedDirectorySummary,
  extraLinkedDirectories: LinkedDirectorySummary[],
) {
  const identity = { backend: "codex", threadId: "thread" } as const;
  let overlay: ThreadOverlayState = {
    ...identity,
    executionMode: "default",
    extraLinkedDirectories,
  };
  const removeLinkedDirectory = vi.fn(async ({ directory }: { directory: LinkedDirectorySummary }) => {
    overlay = {
      ...overlay,
      extraLinkedDirectories: overlay.extraLinkedDirectories.filter(({ id }) => id !== directory.id),
    };
    return overlay;
  });
  const publishUpdate = vi.fn(async () => undefined);
  const deps = {
    overlayStore: { getThreadOverlayState: async () => overlay, removeLinkedDirectory },
    readThread: async () => ({ projectKey, linkedDirectories: [providerDirectory] }),
    publishUpdate,
  };
  return {
    detach: (directory: LinkedDirectorySummary) => detachOwnedThreadDirectory({ ...identity, directory }, deps),
    removeLinkedDirectory,
    publishUpdate,
  };
}

describe("thread owner detachment", () => {
  it("protects a cached primary worktree while detaching a same-repository attachment", async () => {
    const primary = worktree("parent");
    const attached = { ...worktree("child"), id: primary.path };
    const { detach, removeLinkedDirectory, publishUpdate } = setup(primary.id, primary, [primary, attached]);

    expect(await detach(primary)).toMatchObject({ ok: false, reason: "primary-directory" });
    expect(removeLinkedDirectory).not.toHaveBeenCalled();
    expect(publishUpdate).not.toHaveBeenCalled();
    expect(await detach(attached)).toMatchObject({ ok: true, directories: [primary] });
    expect(publishUpdate).toHaveBeenCalledExactlyOnceWith("codex", "thread");
  });

  it("protects the current workspace regardless of overlay order and stale pre-handoff provider metadata", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { minLength: 2, maxLength: 2 }),
      fc.boolean(),
      fc.boolean(),
      async ([originalName, siblingName], moved, reverse) => {
        const original = worktree(originalName!);
        const sibling = worktree(siblingName!);
        const primary = moved ? { ...sibling, id: `pwragent-handoff:${sibling.id}` } : original;
        const overlay = moved ? [primary] : reverse ? [sibling, primary] : [primary, sibling];
        const { detach, removeLinkedDirectory } = setup(
          original.id,
          original,
          overlay,
        );
        expect(await detach(primary)).toMatchObject({ ok: false, reason: "primary-directory" });
        expect(removeLinkedDirectory).not.toHaveBeenCalled();
      },
    ));
  });
});
