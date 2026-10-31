import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HandoffSourceSettings } from "../app-server/backend-registry";
import type { CreateInstanceThreadResult, ListInstanceProjectsResult, ThreadTodo, ThreadTodoProject } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_PAGE_ROWS } from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import {
  createThreadTodoRunners,
  raiseThreadTodoPlan,
  setThreadTodoProject,
  type ThreadTodoRunnerRegistry,
} from "../thread-todos/thread-todo-runtime";
import { withThreadTodoPlanNote } from "../thread-todos/thread-todo-plan";
import type { ThreadTodoProjectCandidate } from "../thread-todos/thread-todo-projects";

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
    listBackends: vi.fn(async () => ({ fetchedAt: 0, backends: ["codex", "claude", "acp:kimi"].map((kind) => ({
      kind, label: kind, executionModes: [
        { mode: "default", available: true }, { mode: "full-access", available: true },
        ...(kind.startsWith("acp:") ? [] : [{ mode: "auto", available: true }]),
      ],
    })) })),
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
      // The card's cwd is the raising thread's worktree. Its branch holds
      // that thread's own work, not a base for a standalone follow-up.
      worktreeBase: "default_branch",
      requiredWorkMode: "worktree",
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
    // A local card shares the source directory; it names no worktree base.
    expect(registry.startThread.mock.calls[0]![0]).not.toHaveProperty("worktreeBase");
    expect(registry.startThread.mock.calls[0]![0]).not.toHaveProperty("requiredWorkMode");
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

describe("thread to-do Start thread on a peer that names the project differently", () => {
  const ORIGIN = "github.com/pwrdrvr/pwragent";
  const card = { key: "directory:/Users/fixture/src/PwrAgnt", label: "PwrAgnt", path: "/Users/fixture/src/PwrAgnt" };
  const local = [{ ...card, kind: "directory" as const, repositoryKey: ORIGIN }];
  const peerProjects = [
    { key: "directory:C:/scratch/PwrAgnt", label: "PwrAgnt", path: "C:\\scratch\\PwrAgnt", kind: "directory" as const,
      hasLaunchpad: false, repositoryKey: "github.com/fixture-user/pwragnt-notes" },
    { key: "directory:C:/src/PwrAgent", label: "PwrAgent", path: "C:\\src\\PwrAgent", kind: "directory" as const,
      hasLaunchpad: true, repositoryKey: ORIGIN },
  ];

  function setup(params: {
    listProjects?: () => Promise<ThreadTodoProjectCandidate[]>;
    peer?: ListInstanceProjectsResult["projects"];
  }) {
    const { registry } = fakeRegistry(FULL_ACCESS_SOL);
    const federation = vi.fn<PwrAgentFederationHandler>(async (request) => {
      if (request.operation === "list_instance_projects") {
        return { ok: true, data: {
          instanceId: "win", instanceLabel: "DESKTOP-FIXTURE / dev", isLocal: false,
          projects: params.peer ?? peerProjects, complete: true,
        } as ListInstanceProjectsResult };
      }
      return { ok: true, data: {
        backend: "codex", threadId: "peer-thread", isLocal: false, instanceId: "win", instanceLabel: "DESKTOP-FIXTURE / dev",
      } as CreateInstanceThreadResult };
    });
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
      federation,
      ...(params.listProjects ? { listProjects: params.listProjects } : {}),
    });
    const run = () => runners.startThreadOnInstance!({
      instanceId: "win", sourceBackend: "codex", sourceThreadId: "source-thread", project: card,
      crossProject: false, action: { type: "start_thread", prompt: "Go" },
    });
    const created = () => federation.mock.calls
      .map(([request]) => request)
      .find((request) => request.operation === "create_instance_thread");
    return { run, created };
  }

  it("starts in the peer's checkout of the same origin, not its same-named folder", async () => {
    const { run, created } = setup({ listProjects: async () => local });
    await expect(run()).resolves.toMatchObject({ threadId: "peer-thread" });
    expect(created()?.args).toMatchObject({ projectKey: "directory:C:/src/PwrAgent" });
  });

  it("names the repository when the peer has no checkout of it", async () => {
    const { run, created } = setup({ listProjects: async () => local, peer: [peerProjects[0]!] });
    await expect(run()).rejects.toThrow(
      "DESKTOP-FIXTURE / dev has no checkout of github.com/pwrdrvr/pwragent (PwrAgnt here).",
    );
    expect(created()).toBeUndefined();
  });

  it("names a fetch remote when the checkout has no origin", async () => {
    const remoteOnly = [{ ...card, kind: "directory" as const, repositoryKeys: [ORIGIN] }];
    const { run } = setup({ listProjects: async () => remoteOnly, peer: [peerProjects[0]!] });
    await expect(run()).rejects.toThrow(`has no checkout of ${ORIGIN} (PwrAgnt here).`);
  });

  it("falls back to the name when this machine's projects cannot be listed", async () => {
    const { run, created } = setup({ listProjects: async () => { throw new Error("index unavailable"); } });
    await expect(run()).resolves.toMatchObject({ threadId: "peer-thread" });
    expect(created()?.args).toMatchObject({ projectKey: "directory:C:/scratch/PwrAgnt" });
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

describe("dispatch access mode compatibility", () => {
  it.each(["codex", "claude"] as const)("starts on ACP Default Access when inheriting %s Auto", async (sourceBackend) => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, executionMode: "auto" });
    await runners.startThread({ sourceBackend, sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" }, modelSettings: { backend: "acp:kimi" } });
    expect(registry.listBackends).toHaveBeenCalledWith({ includeUnavailable: true });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "acp:kimi", executionMode: "default" }));
    expect(registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "default" }));
  });

  it("keeps Auto when the destination advertises it", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, executionMode: "auto" });
    await runners.startThread({ sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" }, modelSettings: { backend: "claude" } });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "auto" }));
    expect(registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "auto" }));
  });

  it("does not substitute Full Access when the inherited mode and Default Access are unavailable", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, executionMode: "auto" });
    registry.listBackends.mockResolvedValue({ fetchedAt: 0, backends: [{ kind: "acp:kimi", label: "Kimi", executionModes: [
      { mode: "default", available: false }, { mode: "full-access", available: true },
    ] }] });
    await expect(runners.startThread({ sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" }, modelSettings: { backend: "acp:kimi" } })).rejects.toThrow("Default Access");
    expect(registry.startThread).not.toHaveBeenCalled();
  });

  it("preserves explicit card access and same-backend inheritance", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, executionMode: "auto" });
    await runners.startThread({ sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it", executionMode: "full-access" }, modelSettings: { backend: "acp:kimi" } });
    expect(registry.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ executionMode: "full-access" }));
    await runners.startThread({ sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" } });
    expect(registry.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ executionMode: "auto" }));
    expect(registry.listBackends).not.toHaveBeenCalled();
  });
});

describe("operator dispatch choices", () => {
  it("applies the operator's Where, environment and speed to a local start", async () => {
    const { registry, runners } = fakeRegistry({
      ...FULL_ACCESS_SOL,
      codexEnvironmentRuntime: { environmentId: "dev", environmentName: "Dev", executionTarget: "local" },
    });
    registry.listBackends.mockResolvedValue({ fetchedAt: 0, backends: [{
      kind: "codex", label: "Codex", codexFastAllowed: true,
      executionModes: [{ mode: "full-access", available: true }],
    }] } as never);
    await runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", cwd: "/repo", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" },
      workMode: "worktree",
      speed: "fast",
      // The checkout has no environments, so a named one is refused before anything starts.
      environment: "none",
    });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({
      workMode: "worktree", worktreeBase: "default_branch", requiredWorkMode: "worktree", fastMode: true,
    }));
    expect(registry.startThread.mock.calls[0]![0]).not.toHaveProperty("codexEnvironmentRuntime");
    expect(registry.startTurn).toHaveBeenCalledWith(expect.objectContaining({ fastMode: true }));
  });

  it("runs a picked environment's setup in the new thread, and reuses the thread's own", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "todo-dispatch-env-"));
    try {
      await mkdir(path.join(repo, ".codex", "environments"), { recursive: true });
      await writeFile(path.join(repo, ".codex", "environments", "ci.toml"), 'name = "CI"\n');
      await writeFile(path.join(repo, ".codex", "environments", "dev.toml"), 'name = "Dev"\n');
      const own = { environmentId: "dev", environmentName: "Dev", executionTarget: "local" as const };
      const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, codexEnvironmentRuntime: own });
      const start = (environment: string, crossProject = false) => runners.startThread({
        sourceBackend: "codex", sourceThreadId: "source", cwd: repo, crossProject,
        action: { type: "start_thread", prompt: "Build it" }, environment,
      });
      await start("ci");
      expect(registry.startThread).toHaveBeenLastCalledWith(expect.objectContaining({
        workMode: "local",
        codexEnvironmentRuntime: { environmentId: "ci", environmentName: "CI", executionTarget: "local" },
        rerunCodexEnvironmentSetup: true,
      }));
      await start("dev");
      expect(registry.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ codexEnvironmentRuntime: own }));
      expect(registry.startThread.mock.lastCall![0]).not.toHaveProperty("rerunCodexEnvironmentSetup");
      // Another project's card does not reuse this thread's setup.
      await start("dev", true);
      expect(registry.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ rerunCodexEnvironmentSetup: true }));
      await expect(start("missing")).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses Fast when this machine's Settings turned it off, and starts nothing", async () => {
    const { registry, runners } = fakeRegistry(FULL_ACCESS_SOL);
    registry.listBackends.mockResolvedValue({ fetchedAt: 0, backends: [{
      kind: "codex", label: "Codex", codexFastAllowed: false,
      executionModes: [{ mode: "full-access", available: true }],
    }] } as never);
    await expect(runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" }, speed: "fast",
    })).rejects.toThrow("Fast mode is turned off");
    expect(registry.startThread).not.toHaveBeenCalled();
  });

  it("starts an inherited Fast thread at Standard once Settings turned Fast off", async () => {
    const { registry, runners } = fakeRegistry({ ...FULL_ACCESS_SOL, fastMode: true });
    registry.listBackends.mockResolvedValue({ fetchedAt: 0, backends: [{
      kind: "codex", label: "Codex", codexFastAllowed: false,
      executionModes: [{ mode: "full-access", available: true }],
    }] } as never);
    await runners.startThread({
      sourceBackend: "codex", sourceThreadId: "source", crossProject: false,
      action: { type: "start_thread", prompt: "Build it" },
    });
    expect(registry.startThread).toHaveBeenCalledWith(expect.objectContaining({ fastMode: false }));
  });

  it("sends a peer the operator's model, speed, Where and environment", async () => {
    const registry = {
      readThreadHandoffSettings: vi.fn(async () => FULL_ACCESS_SOL),
      startThread: vi.fn(), renameThread: vi.fn(), startTurn: vi.fn(),
    };
    const federation = vi.fn(async (request: { operation: string }) =>
      request.operation === "list_instance_projects"
        ? { ok: true as const, data: {
            instanceLabel: "win-lab", complete: true,
            projects: [{ key: "peer-repo", label: "repo", path: "C:\\repo", kind: "directory" }],
          } }
        : { ok: true as const, data: {
            backend: "codex", threadId: "peer-thread", isLocal: false, instanceId: "win", instanceLabel: "win-lab",
          } });
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry, federation: federation as never,
    });
    await runners.startThreadOnInstance!({
      instanceId: "win", sourceBackend: "claude", sourceThreadId: "source",
      project: { key: "local-repo", label: "repo", path: "/repo" }, crossProject: false,
      action: { type: "start_thread", prompt: "Reproduce it", workMode: "worktree" },
      modelSettings: { backend: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
      speed: "fast", workMode: "local", environment: "windows-ci",
    });
    const created = federation.mock.calls
      .map(([request]) => request as { operation: string; args: Record<string, unknown> })
      .find((request) => request.operation === "create_instance_thread");
    expect(created?.args).toMatchObject({
      instanceId: "win", projectKey: "peer-repo", backend: "codex", model: "gpt-6.1-sol", reasoningEffort: "high",
      fastMode: true, workMode: "local", environment: "windows-ci", executionMode: "full-access",
    });
    // A card that shares the peer's checkout names no worktree base.
    expect(created?.args).not.toHaveProperty("worktreeBase");
  });

  it("starts a peer's new worktree from its default branch", async () => {
    const registry = {
      readThreadHandoffSettings: vi.fn(async () => FULL_ACCESS_SOL),
      startThread: vi.fn(), renameThread: vi.fn(), startTurn: vi.fn(),
    };
    const federation = vi.fn(async (request: { operation: string }) =>
      request.operation === "list_instance_projects"
        ? { ok: true as const, data: {
            instanceLabel: "win-lab", complete: true,
            projects: [{ key: "peer-repo", label: "repo", path: "C:\\repo", kind: "directory" }],
          } }
        : { ok: true as const, data: {
            backend: "codex", threadId: "peer-thread", isLocal: false, instanceId: "win", instanceLabel: "win-lab",
          } });
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry, federation: federation as never,
    });
    await runners.startThreadOnInstance!({
      instanceId: "win", sourceBackend: "codex", sourceThreadId: "source",
      project: { key: "local-repo", label: "repo", path: "/repo" }, crossProject: false,
      action: { type: "start_thread", prompt: "Rewrite the CLI", workMode: "worktree" },
    });
    const created = federation.mock.calls
      .map(([request]) => request as { operation: string; args: Record<string, unknown> })
      .find((request) => request.operation === "create_instance_thread");
    // The peer's checkout can sit on a branch with another thread's
    // unpublished work, as the raising thread's can here.
    expect(created?.args).toMatchObject({ workMode: "worktree", worktreeBase: "default_branch" });
  });

  it("refuses Ultrafast on a peer, which create_instance_thread cannot carry", async () => {
    const federation = vi.fn();
    const runners = createThreadTodoRunners({
      registry: { readThreadHandoffSettings: vi.fn(async () => FULL_ACCESS_SOL) } as unknown as ThreadTodoRunnerRegistry,
      federation: federation as never,
    });
    await expect(runners.startThreadOnInstance!({
      instanceId: "win", sourceBackend: "codex", sourceThreadId: "source",
      project: { key: "k", label: "repo", path: "/repo" }, crossProject: false,
      action: { type: "start_thread", prompt: "Go" }, speed: "ultrafast",
    })).rejects.toThrow("Ultrafast");
    expect(federation).not.toHaveBeenCalled();
  });
});

describe("thread to-do Start thread with a plan", () => {
  const PLAN = { title: "Windows smoke test", items: ["Run lint", "Capture screenshots"] };
  const promptOf = (call: Record<string, unknown> | undefined) =>
    ((call?.input as Array<{ text: string }> | undefined) ?? [])[0]?.text;

  function localRunners(raiseHere: (thread: unknown, plan: unknown) => Promise<unknown>) {
    const { registry } = fakeRegistry(FULL_ACCESS_SOL);
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
      plans: { raiseHere: vi.fn(raiseHere) },
    });
    return { registry, runners };
  }

  const start = (runners: ReturnType<typeof createThreadTodoRunners>, plan?: typeof PLAN) => runners.startThread({
    sourceBackend: "codex",
    sourceThreadId: "source-thread",
    crossProject: false,
    action: { type: "start_thread", prompt: "Finish the Windows smoke test." },
    ...(plan ? { plan } : {}),
  });

  it("raises the plan on the new thread before its first turn, and names it in the prompt", async () => {
    const order: string[] = [];
    const raiseHere = vi.fn(async (_thread: unknown, _plan: unknown) => { order.push("plan"); });
    const { registry } = fakeRegistry(FULL_ACCESS_SOL);
    registry.startTurn.mockImplementation(async () => { order.push("turn"); return { turnId: "child-turn" }; });
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
      plans: { raiseHere },
    });
    await start(runners, PLAN);
    expect(raiseHere).toHaveBeenCalledWith({ backend: "codex", threadId: "child-thread" }, PLAN);
    expect(order).toEqual(["plan", "turn"]);
    expect(promptOf(registry.startTurn.mock.calls[0]?.[0])).toBe(withThreadTodoPlanNote("Finish the Windows smoke test."));
    expect(promptOf(registry.startTurn.mock.calls[0]?.[0])).toContain('update_todo (key "plan"');
  });

  it("sends the prompt alone when the plan card cannot be raised", async () => {
    const { registry, runners } = localRunners(async () => { throw new Error("limit reached"); });
    await start(runners, PLAN);
    expect(promptOf(registry.startTurn.mock.calls[0]?.[0])).toBe("Finish the Windows smoke test.");
  });

  it("raises nothing and sends the prompt alone without plain steps", async () => {
    const raiseHere = vi.fn(async () => undefined);
    const { registry, runners } = localRunners(raiseHere);
    await start(runners);
    expect(raiseHere).not.toHaveBeenCalled();
    expect(promptOf(registry.startTurn.mock.calls[0]?.[0])).toBe("Finish the Windows smoke test.");
  });

  function peerRunners(options: { supports: boolean; isLocal?: boolean; raiseFails?: boolean }) {
    const registry = {
      readThreadHandoffSettings: vi.fn(async () => FULL_ACCESS_SOL),
      startThread: vi.fn(),
      renameThread: vi.fn(),
      startTurn: vi.fn(),
    };
    const federation = vi.fn(async (request: { operation: string }) =>
      request.operation === "list_instance_projects"
        ? { ok: true as const, data: { instanceLabel: "win-lab", complete: true,
            projects: [{ key: "peer-atlas", label: "atlas", path: "/peer/atlas", kind: "directory" }] } }
        : { ok: true as const, data: { backend: "codex", threadId: "peer-thread", isLocal: options.isLocal ?? false,
            instanceId: "win-lab", instanceLabel: "win-lab" } });
    const raiseHere = vi.fn(async () => undefined);
    const peer = {
      supports: vi.fn((_instanceId: string) => options.supports),
      raise: vi.fn(async (_instanceId: string, _request: unknown) => {
        if (options.raiseFails) throw new Error("win-lab is disconnected.");
      }),
    };
    const runners = createThreadTodoRunners({
      registry: registry as unknown as ThreadTodoRunnerRegistry,
      federation: federation as never,
      plans: { raiseHere, peer },
    });
    const run = (plan?: typeof PLAN) => runners.startThreadOnInstance!({
      instanceId: "win-lab",
      sourceBackend: "codex",
      sourceThreadId: "source-thread",
      project: { key: "local-atlas", label: "atlas", path: "/local/atlas" },
      crossProject: false,
      action: { type: "start_thread", prompt: "Finish the Windows smoke test." },
      ...(plan ? { plan } : {}),
    });
    const createdInput = () => (federation.mock.calls
      .map(([request]) => request as { operation: string; args: Record<string, unknown> })
      .find((request) => request.operation === "create_instance_thread"))?.args.input;
    return { run, peer, raiseHere, createdInput };
  }

  it("raises the plan on a peer that answers raisePlan, after naming it in the prompt", async () => {
    const { run, peer, raiseHere, createdInput } = peerRunners({ supports: true });
    await run(PLAN);
    expect(peer.supports).toHaveBeenCalledWith("win-lab");
    expect(createdInput()).toBe(withThreadTodoPlanNote("Finish the Windows smoke test."));
    expect(peer.raise).toHaveBeenCalledWith("win-lab", {
      backend: "codex", threadId: "peer-thread", title: PLAN.title, items: PLAN.items,
    });
    expect(raiseHere).not.toHaveBeenCalled();
  });

  it("sends an older peer the prompt alone and raises nothing", async () => {
    const { run, peer, createdInput } = peerRunners({ supports: false });
    await run(PLAN);
    expect(createdInput()).toBe("Finish the Windows smoke test.");
    expect(peer.raise).not.toHaveBeenCalled();
  });

  it("raises the plan here when the picked instance is this one", async () => {
    const { run, peer, raiseHere } = peerRunners({ supports: true, isLocal: true });
    await run(PLAN);
    expect(raiseHere).toHaveBeenCalledWith({ backend: "codex", threadId: "peer-thread" }, PLAN);
    expect(peer.raise).not.toHaveBeenCalled();
  });

  it("still reports the started thread when the peer's plan card fails", async () => {
    const { run } = peerRunners({ supports: true, raiseFails: true });
    await expect(run(PLAN)).resolves.toMatchObject({ threadId: "peer-thread", instanceId: "win-lab" });
  });

  it("files the plan card where add_todo would file one the thread raised", async () => {
    const raisePlan = vi.fn((params: Record<string, unknown>) => params as unknown as ThreadTodo);
    const registry = {
      resolveThreadWorkspaceCwd: vi.fn(async () => "/worktrees/atlas"),
      resolveThreadPrimaryDirectory: vi.fn(async () => { throw new Error("not indexed yet"); }),
    };
    await raiseThreadTodoPlan(registry as never, { backend: "codex", threadId: "child" }, PLAN, { raisePlan });
    expect(raisePlan).toHaveBeenCalledWith({ backend: "codex", threadId: "child", cwd: "/worktrees/atlas", plan: PLAN });
  });
});
