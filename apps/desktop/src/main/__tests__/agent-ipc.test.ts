import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  InterruptTurnRequest,
  ListBackendsRequest,
  MaterializeDirectoryLaunchpadRequest,
  StartThreadRequest,
  StartTurnRequest,
} from "@pwragnt/shared";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const send = vi.fn();
let registryListener: ((event: AgentEvent) => void | Promise<void>) | undefined;

const registry = {
  listBackends: vi.fn(async (_request?: ListBackendsRequest) => ({
    fetchedAt: 1,
    backends: [],
  })),
  onEvent: vi.fn((listener: (event: AgentEvent) => void | Promise<void>) => {
    registryListener = listener;
    return () => {
      registryListener = undefined;
    };
  }),
  startThread: vi.fn(async (request: StartThreadRequest) => ({
    backend: request.backend,
    threadId: "thread-1",
  })),
  startTurn: vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    runId: "turn-1",
  })),
  interruptTurn: vi.fn(async (request: InterruptTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    runId: request.runId,
  })),
  materializeDirectoryLaunchpad: vi.fn(
    async (request: MaterializeDirectoryLaunchpadRequest) => ({
      backend: "codex" as const,
      threadId: `materialized:${request.directoryKey}`,
      executionMode: "default" as const,
      workMode: "local" as const,
      runId: "turn-2",
    }),
  ),
};

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send },
      },
    ],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => registry,
}));

describe("agent ipc", () => {
  beforeEach(() => {
    handlers.clear();
    send.mockReset();
    registry.listBackends.mockClear();
    registry.onEvent.mockClear();
    registry.startThread.mockClear();
    registry.startTurn.mockClear();
    registry.interruptTurn.mockClear();
    registry.materializeDirectoryLaunchpad.mockClear();
    registryListener = undefined;
  });

  it("registers backend and agent handlers and broadcasts backend-tagged events", async () => {
    const {
      registerAgentIpcHandlers,
      disposeAgentIpcHandlers,
    } = await import("../ipc/agent-ipc");
    const {
      AGENT_EVENT_CHANNEL,
      AGENT_INTERRUPT_TURN_CHANNEL,
      AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL,
      AGENT_START_THREAD_CHANNEL,
      AGENT_START_TURN_CHANNEL,
      BACKEND_LIST_CHANNEL,
    } = await import("../../shared/ipc");

    registerAgentIpcHandlers();

    expect(await handlers.get(BACKEND_LIST_CHANNEL)?.({}, {})).toEqual({
      fetchedAt: 1,
      backends: [],
    });
    expect(
      await handlers.get(AGENT_START_THREAD_CHANNEL)?.({}, { backend: "grok" }),
    ).toEqual({
      backend: "grok",
      threadId: "thread-1",
    });
    expect(
      await handlers.get(AGENT_START_TURN_CHANNEL)?.({}, {
        backend: "grok",
        threadId: "thread-1",
        input: [{ type: "text", text: "Ship it" }],
      }),
    ).toEqual({
      backend: "grok",
      threadId: "thread-1",
      runId: "turn-1",
    });
    expect(
      await handlers.get(AGENT_INTERRUPT_TURN_CHANNEL)?.({}, {
        backend: "grok",
        threadId: "thread-1",
        runId: "turn-1",
      }),
    ).toEqual({
      backend: "grok",
      threadId: "thread-1",
      runId: "turn-1",
    });
    expect(
      await handlers.get(AGENT_MATERIALIZE_DIRECTORY_LAUNCHPAD_CHANNEL)?.({}, {
        directoryKey: "directory:/repo/app",
      }),
    ).toEqual({
      backend: "codex",
      threadId: "materialized:directory:/repo/app",
      executionMode: "default",
      workMode: "local",
      runId: "turn-2",
    });

    await registryListener?.({
      backend: "grok",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Done." }],
          },
        },
      },
    });

    expect(send).toHaveBeenCalledWith(AGENT_EVENT_CHANNEL, {
      backend: "grok",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Done." }],
          },
        },
      },
    });

    disposeAgentIpcHandlers();
  });
});
