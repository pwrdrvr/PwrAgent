import { act, cleanup, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadSkills } from "../useThreadSkills";

function launchpad(project: number, remote: boolean): NavigationLaunchpadDraft {
  return {
    backend: "codex",
    directoryKey: `directory:/project-${project}`,
    directoryKind: "directory",
    directoryLabel: `project-${project}`,
    directoryPath: `/project-${project}`,
    executionMode: "default",
    prompt: "",
    workMode: "local",
    createdAt: 1,
    updatedAt: 1,
    ...(remote ? { federationTarget: { scope: "remote", instanceId: "peer" } as const } : {}),
  };
}

describe("skill picker catalog freshness", () => {
  it("refreshes warmed launchpads and existing main threads after a remote merge is pulled locally", async () => {
    const main = "/fixture/main";
    const authoring = "/fixture/authoring-worktree";
    const newWorktree = "/fixture/new-main-worktree";
    const skill = "paper-rewriter-pwragent";
    // Model the separate on-disk checkouts: a remote merge cannot change
    // local main until pull, or an already-created worktree at its old HEAD.
    const catalogs = new Map([
      [main, new Set(["rate-math-paper"])],
      [authoring, new Set(["rate-math-paper", skill])],
    ]);
    const listSkills = vi.fn<NonNullable<DesktopApi["listSkills"]>>(async (request) => ({
      backend: "codex",
      fetchedAt: Date.now(),
      data: (request?.cwds ?? []).map((cwd) => ({
        cwd,
        skills: [...(catalogs.get(cwd) ?? [])].map((name) => ({
          name, description: name, path: `${cwd}/.agents/skills/${name}/SKILL.md`,
        })),
      })),
    }));
    const desktopApi: DesktopApi = { listSkills };
    const draft: NavigationLaunchpadDraft = {
      ...launchpad(0, false),
      directoryKey: `directory:${main}`,
      directoryLabel: "Project",
      directoryPath: main,
    };
    const thread = (id: string, worktreePath?: string): NavigationThreadSummary => ({
      id,
      title: id,
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [{
        id: main,
        kind: "local",
        path: main,
        label: "Project",
        ...(worktreePath ? { worktreePath } : {}),
      }],
      inbox: { inInbox: false },
    });
    type Target = { launchpad?: NavigationLaunchpadDraft; thread?: NavigationThreadSummary };
    const { result, rerender, unmount } = renderHook(
      (target: Target) => useThreadSkills({ desktopApi, ...target }),
      { initialProps: { launchpad: draft } as Target },
    );
    const open = async (target: Target, present: boolean) => {
      rerender(target);
      await act(async () => { await result.current.ensureLoaded(); });
      expect(result.current.skills.some((entry) => entry.name === skill)).toBe(present);
    };
    try {
      await open({ thread: thread("authoring", authoring) }, true);
      // The remote merge has happened, but local main is still behind.
      await open({ launchpad: draft }, false);
      await open({ launchpad: { ...draft, workMode: "worktree" } }, false);
      await open({ thread: thread("existing-main") }, false);
      await open({ thread: thread("created-before-pull") }, false);

      // External pull: no skills/changed event, and the same cached keys.
      catalogs.set(main, new Set(catalogs.get(authoring)));
      await open({ launchpad: draft }, true);
      await open({ launchpad: { ...draft, workMode: "worktree" } }, true);
      await open({ thread: thread("existing-main") }, true);
      await open({ thread: thread("created-before-pull") }, true);
      await open({ thread: thread("new-local-main") }, true);
      catalogs.set(newWorktree, new Set(catalogs.get(main)));
      await open({ thread: thread("new-worktree-from-main", newWorktree) }, true);
    } finally {
      unmount();
    }
  });

  it("matches the authoritative owner catalog after external edits and reopening, without notifications", async () => {
    // Model: each owner/project has its own catalog. External edits emit no
    // event (an unborn launchpad need not have a provider watcher).
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        target: fc.integer({ min: 0, max: 3 }),
        name: fc.constantFrom("paper-rewriter-pwragent", "rate-math-paper", "review"),
        present: fc.boolean(),
      }), { minLength: 2, maxLength: 12 }),
      async (edits) => {
        const targets = [launchpad(0, false), launchpad(1, false), launchpad(0, true), launchpad(1, true)];
        const catalogs = targets.map(() => new Set(["rate-math-paper"]));
        const listSkills = vi.fn<NonNullable<DesktopApi["listSkills"]>>(async (request) => {
          const index = targets.findIndex((target) =>
            target.directoryPath === request?.cwd
            && target.federationTarget?.scope === request?.federationTarget?.scope);
          expect(index).toBeGreaterThanOrEqual(0);
          return {
            backend: "codex",
            fetchedAt: Date.now(),
            data: [{ cwd: request?.cwd, skills: [...catalogs[index]].map((name) => ({
              name,
              description: name,
              path: `${request?.cwd}/.agents/skills/${name}/SKILL.md`,
            })) }],
          };
        });
        const desktopApi: DesktopApi = { listSkills };
        const { result, rerender } = renderHook(
          ({ target }) => useThreadSkills({ desktopApi, launchpad: target }),
          { initialProps: { target: targets[0] } },
        );
        try {
          for (const target of targets) {
            rerender({ target });
            await act(async () => { await result.current.ensureLoaded(); });
          }
          for (const edit of [
            { target: 0, name: "paper-rewriter-pwragent", present: true },
            { target: 0, name: "rate-math-paper", present: false },
            ...edits,
          ]) {
            rerender({ target: targets[edit.target] });
            await act(async () => { await result.current.ensureLoaded(); });
            if (edit.present) catalogs[edit.target].add(edit.name);
            else catalogs[edit.target].delete(edit.name);

            // Reopen for the SAME cache key. Concurrent opens share a request.
            const requests = listSkills.mock.calls.length;
            await act(async () => {
              await Promise.all([result.current.ensureLoaded(), result.current.ensureLoaded()]);
            });
            expect(result.current.skills.map((skill) => skill.name)).toEqual([...catalogs[edit.target]].sort());
            expect(listSkills.mock.calls.length - requests).toBe(1);
            // Navigating among warm caches must not leak the edited project's
            // catalog into another project or another owner of the same path.
            for (const [index, target] of targets.entries()) {
              rerender({ target });
              expect(result.current.skills.map((skill) => skill.name)).toEqual([...catalogs[index]].sort());
            }
          }
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });
});
