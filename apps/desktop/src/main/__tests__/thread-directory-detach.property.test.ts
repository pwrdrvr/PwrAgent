import {
  findPrimaryThreadLinkedDirectory,
  materializeNavigationThreads,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
  type ThreadOverlayState,
} from "@pwragent/shared";
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
  const publishLocalEvent = vi.fn(async () => undefined);
  const thread: AppServerThreadSummary = {
    id: identity.threadId, source: identity.backend, title: "Worktree thread", titleSource: "explicit",
    projectKey, linkedDirectories: [providerDirectory],
  };
  const deps = {
    overlayStore: { getThreadOverlayState: async () => overlay, removeLinkedDirectory },
    registry: { listThreads: async () => [thread], publishLocalEvent },
  };
  return {
    detach: (directory: LinkedDirectorySummary) => detachOwnedThreadDirectory({ ...identity, directory }, deps),
    removeLinkedDirectory,
    publishLocalEvent,
  };
}

async function checkCheckoutAlias(subdirectory: string) {
  const checkout = worktree("parent");
  const primary = { ...checkout, id: `${checkout.worktreePath}/${subdirectory}` };
  const attached = worktree("child");
  const providerDirectory = { ...primary, path: primary.id, worktreePath: primary.id };
  const thread: AppServerThreadSummary = {
    id: "thread", source: "codex", title: "Worktree thread", titleSource: "explicit",
    projectKey: providerDirectory.path, linkedDirectories: [providerDirectory],
  };
  const overlay: ThreadOverlayState = {
    backend: "codex", threadId: thread.id, executionMode: "default", extraLinkedDirectories: [primary, attached],
  };
  const [navigationThread] = materializeNavigationThreads({
    threads: [thread], overlayByThreadKey: { "codex:thread": overlay },
    firstSnapshot: true, previousKnownThreadKeys: [],
  });
  const protectedDirectory = findPrimaryThreadLinkedDirectory(
    navigationThread!.linkedDirectories,
    navigationThread!.projectKey,
  );
  expect(protectedDirectory).toEqual(primary);

  const { detach, removeLinkedDirectory } = setup(thread.projectKey!, providerDirectory, overlay.extraLinkedDirectories);
  for (const directory of navigationThread!.linkedDirectories) {
    expect((await detach(directory)).ok).toBe(directory !== protectedDirectory);
  }
  expect(removeLinkedDirectory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directory: attached }));
}

describe("thread owner detachment", () => {
  it("protects the cached worktree root when Codex reports its src subdirectory under the same ID", async () => {
    await checkCheckoutAlias("src");
  });

  it("agrees with Linked Projects about the primary checkout when provider directory enrichment lags", async () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
    await fc.assert(fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 4 }),
      async (segments) => await checkCheckoutAlias(segments.join("/"))));
  });

  it("protects a cached primary worktree while detaching a same-repository attachment", async () => {
    const primary = worktree("parent");
    const attached = { ...worktree("child"), id: primary.path };
    const { detach, removeLinkedDirectory, publishLocalEvent } = setup(primary.id, primary, [primary, attached]);

    expect(await detach(primary)).toMatchObject({ ok: false, reason: "primary-directory" });
    expect(removeLinkedDirectory).not.toHaveBeenCalled();
    expect(publishLocalEvent).not.toHaveBeenCalled();
    expect(await detach(attached)).toMatchObject({ ok: true, directories: [primary] });
    expect(publishLocalEvent).toHaveBeenCalledExactlyOnceWith({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: ["thread"] },
      },
    });
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
