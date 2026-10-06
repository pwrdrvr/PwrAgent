import { describe, expect, it, vi } from "vitest";
import type { HandoffSourceSettings } from "../app-server/backend-registry";
import {
  createThreadTodoRunners,
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
    startThread: vi.fn(async (params: { backend: "codex" }) => ({
      backend: params.backend,
      threadId: "child-thread",
    })),
    renameThread: vi.fn(async () => undefined),
    startTurn: vi.fn(async () => ({ turnId: "child-turn" })),
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

  it("sends a peer the source thread's access but only the card's own model", async () => {
    // The peer's catalog is its own: a model id from this machine may not
    // exist there, so the peer applies its defaults unless the card names one.
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
      action: { type: "start_thread", prompt: "Go" },
    });

    const created = federation.mock.calls
      .map(([request]) => request as { operation: string; args: Record<string, unknown> })
      .find((request) => request.operation === "create_instance_thread");
    expect(created?.args).toMatchObject({ executionMode: "full-access" });
    expect(created?.args).not.toHaveProperty("model");
    expect(created?.args).not.toHaveProperty("reasoningEffort");
  });
});
