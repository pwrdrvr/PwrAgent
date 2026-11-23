import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { listThreadTodoDispatchEnvironments } from "../thread-todos/thread-todo-dispatch";
import { ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

it("dispatches handoffs by the operator's explicit destination for every proposal and message target", async () => {
  const temp = createTempStateDb("pwragent-todo-dispatch-");
  const db = StateDb.open(temp.dbPath);
  const source = { backend: "codex" as const, threadId: "source" };
  const ownThread = source;
  const otherThread = { backend: "codex" as const, threadId: "other" };
  const prompt = "Add retry limits to the delivery worker.";
  const items = ["Bound the retry queue", "Test the limit"];
  const startThread = vi.fn(async () => ({ backend: "codex" as const, threadId: "new" }));
  const sendMessage = vi.fn(async () => ({ summary: "Sent" }));
  const service = new ThreadTodoService({
    store: new ThreadTodoStore(db), runners: { startThread, sendMessage, mergePullRequest: vi.fn() },
  });
  try {
    for (const [action, defaultRun] of [
      [{ type: "start_thread", prompt }, "start"],
      [{ type: "send_message", target: ownThread, prompt }, "do_here"],
      [{ type: "send_message", target: otherThread, prompt }, "send"],
    ] as const) {
      for (const [options, expected] of [
        [{}, defaultRun],
        [{ startNewThread: true, seenExecutionMode: "inherit" }, "start"],
        [{ messageTarget: otherThread }, "send"],
        [{ messageTarget: ownThread }, "do_here"],
      ] as const) {
        startThread.mockClear();
        sendMessage.mockClear();
        const { todo } = service.add({ ...source, input: { title: "Bound retries", items, action } });
        const result = await service.runAction(todo.id, options);
        expect({ action, options, status: result.status }).toEqual({
          action, options, status: expected === "do_here" ? "open" : "done",
        });
        expect(result.action).toEqual(todo.action);
        expect(startThread).toHaveBeenCalledTimes(expected === "start" ? 1 : 0);
        expect(sendMessage).toHaveBeenCalledTimes(expected === "send" ? 1 : 0);
        if (expected === "start") {
          expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
            action: { type: "start_thread", prompt },
            plan: { title: todo.title, items },
            sourceThreadId: source.threadId,
          }));
        }
      }
    }
  } finally {
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});

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
