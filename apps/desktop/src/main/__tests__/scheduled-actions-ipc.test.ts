import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const serviceMock = vi.hoisted(() => ({
  list: vi.fn(() => ({ actions: [] })),
  create: vi.fn(async (request: unknown) => ({ action: request })),
  update: vi.fn(async (request: unknown) => ({ action: request })),
  cancel: vi.fn(async (request: unknown) => ({ action: request })),
  sendNow: vi.fn(async (request: unknown) => ({ action: request })),
}));
const remoteBackendMock = vi.hoisted(() => ({
  listScheduledThreadActions: vi.fn(async () => ({ actions: [] })),
  createScheduledThreadAction: vi.fn(async (request: unknown) => ({ action: request })),
  updateScheduledThreadAction: vi.fn(async (request: unknown) => ({ action: request })),
  cancelScheduledThreadAction: vi.fn(async (request: unknown) => ({ action: request })),
  sendScheduledThreadActionNow: vi.fn(async (request: unknown) => ({ action: request })),
}));
const remoteBackend = vi.hoisted(() => vi.fn(() => remoteBackendMock));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../scheduled-actions/scheduled-thread-action-service", () => ({
  getScheduledThreadActionService: vi.fn(() => serviceMock),
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: vi.fn(() => ({ remoteBackend })),
}));

describe("scheduled action IPC", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("routes every scheduled action operation through the main-process service", async () => {
    const {
      disposeScheduledActionIpcHandlers,
      registerScheduledActionIpcHandlers,
    } = await import("../ipc/scheduled-actions-ipc");
    const {
      SCHEDULED_ACTIONS_CANCEL_CHANNEL,
      SCHEDULED_ACTIONS_CREATE_CHANNEL,
      SCHEDULED_ACTIONS_LIST_CHANNEL,
      SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
      SCHEDULED_ACTIONS_UPDATE_CHANNEL,
    } = await import("../../shared/ipc");
    const listRequest = { backend: "codex" as const, threadId: "thread-1" };
    const mutationRequest = { id: "scheduled-1" };

    registerScheduledActionIpcHandlers();

    await handlers.get(SCHEDULED_ACTIONS_LIST_CHANNEL)?.({}, listRequest);
    await handlers.get(SCHEDULED_ACTIONS_CREATE_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_UPDATE_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_CANCEL_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL)?.({}, mutationRequest);

    expect(serviceMock.list).toHaveBeenCalledWith(listRequest);
    expect(serviceMock.create).toHaveBeenCalledWith(mutationRequest);
    expect(serviceMock.update).toHaveBeenCalledWith(mutationRequest);
    expect(serviceMock.cancel).toHaveBeenCalledWith(mutationRequest);
    expect(serviceMock.sendNow).toHaveBeenCalledWith(mutationRequest);

    disposeScheduledActionIpcHandlers();
    expect(handlers.size).toBe(0);
  });

  it("routes remote operations to the owning federation peer", async () => {
    const { registerScheduledActionIpcHandlers } = await import(
      "../ipc/scheduled-actions-ipc"
    );
    const {
      SCHEDULED_ACTIONS_CANCEL_CHANNEL,
      SCHEDULED_ACTIONS_CREATE_CHANNEL,
      SCHEDULED_ACTIONS_LIST_CHANNEL,
      SCHEDULED_ACTIONS_SEND_NOW_CHANNEL,
      SCHEDULED_ACTIONS_UPDATE_CHANNEL,
    } = await import("../../shared/ipc");
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "client_one",
    };
    const listRequest = {
      backend: "codex" as const,
      federationTarget,
      threadId: "thread-1",
    };
    const mutationRequest = { federationTarget, id: "scheduled-1" };

    registerScheduledActionIpcHandlers();
    await handlers.get(SCHEDULED_ACTIONS_LIST_CHANNEL)?.({}, listRequest);
    await handlers.get(SCHEDULED_ACTIONS_CREATE_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_UPDATE_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_CANCEL_CHANNEL)?.({}, mutationRequest);
    await handlers.get(SCHEDULED_ACTIONS_SEND_NOW_CHANNEL)?.({}, mutationRequest);

    expect(remoteBackend).toHaveBeenCalledWith(federationTarget);
    expect(remoteBackendMock.listScheduledThreadActions).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(remoteBackendMock.createScheduledThreadAction).toHaveBeenCalledWith({
      id: "scheduled-1",
    });
    expect(remoteBackendMock.updateScheduledThreadAction).toHaveBeenCalledWith({
      id: "scheduled-1",
    });
    expect(remoteBackendMock.cancelScheduledThreadAction).toHaveBeenCalledWith({
      id: "scheduled-1",
    });
    expect(remoteBackendMock.sendScheduledThreadActionNow).toHaveBeenCalledWith({
      id: "scheduled-1",
    });
    expect(serviceMock.create).not.toHaveBeenCalled();
  });
});
