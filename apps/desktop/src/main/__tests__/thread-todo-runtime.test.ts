import { describe, expect, it, vi } from "vitest";
import type { HandoffSourceSettings } from "../app-server/backend-registry";
import type { CreateInstanceThreadResult, ListInstanceProjectsResult, ThreadTodo, ThreadTodoProject } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_PAGE_ROWS } from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import {
  createThreadTodoRunners,
  setThreadTodoProject,
  type ThreadTodoRunnerRegistry,
} from "../thread-todos/thread-todo-runtime";

const FULL_ACCESS_SOL: HandoffSourceSettings = {
  executionMode: "full-access",
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
  fastMode: false,
};

function fakeRegistry(source: HandoffSourceSettings) {
  const registry = {
    readThreadHandoffSettings: vi.fn(async () => source),
    readBackendModelOptions: vi.fn(async (_backend: string) => undefined),
    startThread: vi.fn(async (params: { backend: "codex" }) => ({
      backend: params.backend,
      threadId: "child-thread",
    })),
    renameThread: vi.fn(async () => undefined),
    startTurn: vi.fn(async (_params: Record<string, unknown>) => ({ turnId: "child-turn" })),
  };
  return {
    registry,
    runners: createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
    }),
  };
}

describe("thread to-do Start thread", () => {
  it("starts the new thread with the source thread's access, model, and effort", async () => {
    // A card that names none of them ran from a Full Access GPT-6.1-Sol
    // thread and started a Default Access thread on the catalog's default
    // model, GPT-5.6-Terra.
    const { registry, runners } = fakeRegistry(FULL_ACCESS_SOL);

    await runners.startThread({
      sourceBackend: "codex",
      sourceThreadId: "source-thread",
      cwd: "/repo",
      crossProject: false,
      action: { type: "start_thread", prompt: "Rewrite the CLI", workMode: "worktree" },
    });

    expect(registry.readThreadHandoffSettings).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "source-thread",
    });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      cwd: "/repo",
      workMode: "worktree",
      executionMode: "full-access",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      fastMode: false,
      parentThreadId: "source-thread",
    }));
    expect(registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "child-thread",
      executionMode: "full-access",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    }));
  });

  it("lets the card's own settings win over the source thread's", async () => {
    const { registry, runners } = fakeRegistry(FULL_ACCESS_SOL);

    await runners.startThread({
      sourceBackend: "codex",
      sourceThreadId: "source-thread",
      crossProject: false,
      action: {
        type: "start_thread",
        prompt: "Review it",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        executionMode: "default",
      },
    });

    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "default",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    }));
    expect(registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "default",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    }));
  });

  it("keeps the source's effort when the card names only a model", async () => {
    const { registry, runners } = fakeRegistry(FULL_ACCESS_SOL);

    await runners.startThread({
      sourceBackend: "codex",
      sourceThreadId: "source-thread",
      crossProject: false,
      action: { type: "start_thread", prompt: "Go", model: "gpt-6.1-sol" },
    });

    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "full-access",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    }));
  });

  it("sends a peer the source thread's access and leaves model selection to its defaults", async () => {
    // The peer's catalog is its own: a model id from this machine may not
    // exist there, so even an agent suggestion stays on this machine.
    const source = FULL_ACCESS_SOL;
    const registry = {
      readThreadHandoffSettings: vi.fn(async () => source),
      startThread: vi.fn(),
      renameThread: vi.fn(),
      startTurn: vi.fn(),
    };
    const federation = vi.fn(async (request: { operation: string }) =>
      request.operation === "list_instance_projects"
        ? {
            ok: true as const,
            data: {
              instanceLabel: "Studio",
              complete: true,
              projects: [{ key: "peer-repo", label: "repo", path: "/peer/repo", kind: "directory" }],
            },
          }
        : {
            ok: true as const,
            data: {
              backend: "codex",
              threadId: "peer-thread",
              isLocal: false,
              instanceId: "peer",
              instanceLabel: "Studio",
            },
          });
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
      federation: federation as never,
    });

    await runners.startThreadOnInstance!({
      instanceId: "peer",
      sourceBackend: "codex",
      sourceThreadId: "source-thread",
      project: { key: "local-repo", label: "repo", path: "/local/repo" },
      crossProject: false,
      action: { type: "start_thread", prompt: "Go", model: "gpt-6.1-sol", reasoningEffort: "high" },
    });

    const created = federation.mock.calls
      .map(([request]) => request as { operation: string; args: Record<string, unknown> })
      .find((request) => request.operation === "create_instance_thread");
    expect(created?.args).toMatchObject({ executionMode: "full-access" });
    expect(created?.args).not.toHaveProperty("model");
    expect(created?.args).not.toHaveProperty("reasoningEffort");
  });
});

describe("thread to-do Start thread on project pagination", () => {
  const project = { key: "local-repo", label: "repo", path: "/local/repo" };
  const peerProject = { key: "peer-repo", label: "repo", path: "/peer/repo", kind: "directory" as const, hasLaunchpad: true };

  function setup(readPage: (cursor?: string) => Partial<ListInstanceProjectsResult>) {
    const { registry } = fakeRegistry(FULL_ACCESS_SOL);
    const federation = vi.fn<PwrAgentFederationHandler>(async (request) => {
      if (request.operation === "list_instance_projects") {
        // Enforce the owner's contract; the former permissive mock hid limit: 500.
        expect(request.args.limit).toBeGreaterThan(0);
        expect(request.args.limit).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_PAGE_ROWS);
        return { ok: true, data: {
          instanceId: "peer", instanceLabel: "Studio", isLocal: false,
          projects: [], complete: true, ...readPage(request.args.cursor),
        } as ListInstanceProjectsResult };
      }
      if (request.operation !== "create_instance_thread") throw new Error("Unexpected operation");
      return { ok: true, data: {
        backend: "codex", threadId: "peer-thread", isLocal: false, instanceId: "peer", instanceLabel: "Studio",
      } as CreateInstanceThreadResult };
    });
    const runners = createThreadTodoRunners({ registry: registry as unknown as ThreadTodoRunnerRegistry, federation });
    const run = () => runners.startThreadOnInstance!({
      instanceId: "peer", sourceBackend: "codex", sourceThreadId: "source-thread", project,
      crossProject: false, action: { type: "start_thread", prompt: "Go" },
    });
    return { run, federation };
  }

  it("finds the destination beyond 500 projects using bounded cursor pages", async () => {
    const projects = [
      ...Array.from({ length: 600 }, (_, index) => ({ ...peerProject, key: `other-${index}`, label: `other-${index}`, path: `/peer/other-${index}` })),
      peerProject,
    ];
    const { run, federation } = setup((cursor) => {
      const offset = Number(cursor ?? 0);
      const end = offset + NAVIGATION_QUERY_MAX_PAGE_ROWS;
      return { projects: projects.slice(offset, end), complete: end >= projects.length,
        ...(end < projects.length ? { nextCursor: String(end) } : {}) };
    });
    await expect(run()).resolves.toMatchObject({ threadId: "peer-thread" });
    expect(federation.mock.calls.filter(([request]) => request.operation === "list_instance_projects")).toHaveLength(7);
    expect(federation).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "create_instance_thread", args: expect.objectContaining({ projectKey: peerProject.key }),
    }));
  });

  it("reads empty filtered pages and preserves label priority across pages", async () => {
    const { run, federation } = setup((cursor) => cursor === "last"
      ? { projects: [peerProject] }
      : cursor === "empty"
        ? { projects: [], complete: false, nextCursor: "last" }
        : { projects: [{ ...peerProject, key: "fallback", label: "Other label" }], complete: false, nextCursor: "empty" });
    await run();
    expect(federation).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "create_instance_thread", args: expect.objectContaining({ projectKey: peerProject.key }),
    }));
  });

  it.each([
    { complete: false },
    { complete: false, nextCursor: "stuck" },
    { complete: true, nextCursor: "contradiction" },
  ])("refuses an incomplete or non-advancing listing: %j", async (page) => {
    const { run, federation } = setup(() => ({ projects: [peerProject], ...page }));
    await expect(run()).rejects.toThrow(/project.*(complete|advance)/i);
    expect(federation.mock.calls.some(([request]) => request.operation === "create_instance_thread")).toBe(false);
  });

  it("propagates a later page failure without starting from partial results", async () => {
    const { run, federation } = setup((cursor) => {
      if (cursor) throw new Error("peer disconnected");
      return { projects: [peerProject], complete: false, nextCursor: "next" };
    });
    await expect(run()).rejects.toThrow("peer disconnected");
    expect(federation.mock.calls.some(([request]) => request.operation === "create_instance_thread")).toBe(false);
  });
});

describe("thread to-do project menu", () => {
  const SNAP: ThreadTodoProject = { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" };
  const card = { id: "todo-1" } as ThreadTodo;
  const deps = () => ({
    todos: { update: vi.fn(() => card) },
    listProjects: vi.fn(async () => [SNAP]),
  });

  it("files the card under the picked project, as the sidebar lists it", async () => {
    const fake = deps();
    await setThreadTodoProject({ id: "todo-1", projectKey: SNAP.key }, fake);
    expect(fake.todos.update).toHaveBeenCalledWith({ id: "todo-1", targetProject: SNAP });
  });

  it("returns the card to its thread's project for null, without listing", async () => {
    const fake = deps();
    await setThreadTodoProject({ id: "todo-1", projectKey: null }, fake);
    expect(fake.todos.update).toHaveBeenCalledWith({ id: "todo-1", targetProject: null });
    expect(fake.listProjects).not.toHaveBeenCalled();
  });

  it("refuses a key the sidebar no longer lists", async () => {
    const fake = deps();
    await expect(setThreadTodoProject({ id: "todo-1", projectKey: "directory:/gone" }, fake))
      .rejects.toThrow("That project is no longer in the sidebar.");
    expect(fake.todos.update).not.toHaveBeenCalled();
  });

  it("lets a failed listing reject rather than read as a missing project", async () => {
    const fake = deps();
    fake.listProjects.mockRejectedValueOnce(new Error("navigation unavailable"));
    await expect(setThreadTodoProject({ id: "todo-1", projectKey: SNAP.key }, fake))
      .rejects.toThrow("navigation unavailable");
  });
});

describe("chosen dispatch backend", () => {
  it("validates against the chosen catalog and drops tier and fast mode across backends", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, serviceTier: "fast", fastMode: true });
    registry.readBackendModelOptions.mockResolvedValue({ models: [{ id: "opus", label: "Opus 5.5", reasoningEfforts: ["high"] }] } as never);
    await runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", cwd: "/repo", crossProject: false,
      action: { type: "start_thread", prompt: "Build it", workMode: "worktree" },
      modelSettings: { backend: "claude", model: "Opus 5.5", reasoningEffort: "high" },
    });
    expect(registry.readBackendModelOptions).toHaveBeenCalledWith("claude");
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "claude", model: "opus", reasoningEffort: "high", executionMode: "full-access", workMode: "worktree",
    }));
    for (const args of [registry.startThread.mock.calls[0]![0], registry.startTurn.mock.calls[0]![0]]) {
      expect(args).not.toHaveProperty("serviceTier");
      expect(args).not.toHaveProperty("fastMode");
    }
  });

  it("refuses an invalid model before starting anything", async () => {
    const { registry, runners } = fakeRegistry(FULL_ACCESS_SOL);
    registry.readBackendModelOptions.mockResolvedValue({ models: [{ id: "opus", reasoningEfforts: ["high"] }] } as never);
    await expect(runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" },
      modelSettings: { backend: "claude", model: "gpt-6.1-sol" },
    })).rejects.toThrow('No model named "gpt-6.1-sol"');
    expect(registry.startThread).not.toHaveBeenCalled();
  });

  it("keeps tier and fast mode for a same-backend pick", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, serviceTier: "fast", fastMode: true });
    await runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" },
      modelSettings: { backend: "codex", model: "other", reasoningEffort: "medium" },
    });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: "fast", fastMode: true }));
  });
});
