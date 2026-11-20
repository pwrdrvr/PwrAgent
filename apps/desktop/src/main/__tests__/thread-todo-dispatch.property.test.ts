import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { listThreadTodoDispatchEnvironments } from "../thread-todos/thread-todo-dispatch";

describe("handoff environment checkout selection", () => {
  // The filesystem is the oracle: an existing worktree owns its catalog,
  // including an empty one; a deleted worktree uses its linked main checkout.
  it("follows worktree removal and recreation without borrowing another project's environments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-environment-checkout-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const target = path.join(root, "other-project");
    const sourceProject = { key: `directory:${repo}`, label: "Repo", path: repo };
    const targetProject = { key: `directory:${target}`, label: "Other", path: target };
    const putEnvironment = async (cwd: string, id: string) => {
      const directory = path.join(cwd, ".codex", "environments");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${id}.toml`), `name = "${id}"\n`);
    };
    const card: ThreadTodo = {
      id: "card", backend: "codex", threadId: "source", kind: "handoff", status: "open", title: "Go",
      action: { type: "start_thread", prompt: "Go", workMode: "worktree" },
      cwd: worktree, sourceProject, createdAt: 0, updatedAt: 0,
    };
    const deps = {
      getTodo: () => card,
      listProjects: async () => [],
      readThreadEnvironmentId: async () => "main",
      readProjectPresetId: async () => "main",
    };
    try {
      await putEnvironment(repo, "main");
      await fc.assert(fc.asyncProperty(
        fc.array(fc.constantFrom("deleted", "empty", "configured"), { minLength: 1, maxLength: 6 }),
        async (states) => {
          for (const state of states) {
            await rm(worktree, { recursive: true, force: true });
            if (state === "empty") await mkdir(worktree);
            if (state === "configured") await putEnvironment(worktree, "branch");
            const expectedIds = state === "deleted" ? ["main"] : state === "configured" ? ["branch"] : [];
            const listed = await listThreadTodoDispatchEnvironments({ id: card.id }, deps);
            expect(listed.environments.map((entry) => entry.id)).toEqual(expectedIds);
            expect(listed.defaultSource).toBe(state === "deleted" ? "thread" : "none");

            const crossProject = await listThreadTodoDispatchEnvironments({ id: card.id }, {
              ...deps, getTodo: () => ({ ...card, targetProject }),
            });
            expect(crossProject.environments).toEqual([]);
          }
        },
      ), { numRuns: 25 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
