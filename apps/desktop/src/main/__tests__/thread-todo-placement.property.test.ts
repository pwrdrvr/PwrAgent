import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, LinkedDirectorySummary, ThreadOverlayState } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { readThreadTodoPlacement } from "../thread-todos/thread-todo-runtime";

function movedThread(params: { backend: "codex" | "claude"; pending: boolean; stale: boolean; local: boolean }) {
  const old: LinkedDirectorySummary = {
    id: "/projects/PwrRoute", label: "PwrRoute", kind: "worktree",
    path: "/projects/PwrRoute", worktreePath: "/worktrees/old/PwrRoute",
  };
  const selected: LinkedDirectorySummary = {
    id: `pwragent-handoff:${params.backend}:source`, label: "PwrApps",
    path: "/projects/PwrApps", kind: params.local ? "local" : "worktree",
    ...(params.local ? {} : { worktreePath: "/projects/PwrApps-console-polish" }),
  };
  const thread: AppServerThreadSummary = {
    id: "source", source: params.backend, title: "Console app", titleSource: "explicit",
    projectKey: params.stale ? old.worktreePath : selected.worktreePath ?? selected.path,
    linkedDirectories: params.stale ? [old] : [selected, old],
  };
  const overlay: ThreadOverlayState = {
    backend: params.backend, threadId: "source", extraLinkedDirectories: [old, selected],
  };
  // Exercise the production registry methods without starting provider processes.
  const registry = Object.create(DesktopBackendRegistry.prototype) as DesktopBackendRegistry;
  Object.assign(registry, {
    overlayStore: { getThreadOverlayState: vi.fn(async () => overlay) },
    pendingStartedThreads: new Map(params.pending ? [[`${params.backend}:source`, thread]] : []),
    findThreadForWorkspaceHandoff: vi.fn(async () => thread),
  });
  return { registry, selected, identity: { backend: params.backend, threadId: "source" } };
}

describe("to-do placement after a workspace handoff", () => {
  it("captures the selected PwrApps workspace instead of the retained PwrRoute link", async () => {
    const { registry, selected, identity } = movedThread({ backend: "claude", pending: false, stale: true, local: false });
    expect(await readThreadTodoPlacement(registry, identity)).toEqual({
      cwd: selected.worktreePath,
      sourceProject: { key: "directory:/projects/PwrApps", label: "PwrApps", path: selected.path },
    });
  });

  it("uses the committed handoff as the oracle regardless of provider snapshot or pending state", async () => {
    // A committed workspace selection owns both where a card runs and its project.
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("codex" as const, "claude" as const), fc.boolean(), fc.boolean(), fc.boolean(),
      async (backend, pending, stale, local) => {
        const { registry, selected, identity } = movedThread({ backend, pending, stale, local });
        const placement = await readThreadTodoPlacement(registry, identity);
        expect(placement.cwd).toBe(selected.worktreePath ?? selected.path);
        expect(placement.sourceProject?.path).toBe(selected.path);
        expect(await registry.resolveThreadPrimaryDirectory(backend, identity.threadId)).toEqual(selected);
      },
    ));
  });
});
