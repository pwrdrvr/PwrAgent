import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const serviceMock = vi.hoisted(() => ({
  list: vi.fn(() => ({ actions: [] })),
  create: vi.fn(async (request: unknown) => ({ action: request })),
  update: vi.fn(async (request: unknown) => ({ action: request })),
  cancel: vi.fn(async (request: unknown) => ({ action: request })),
  sendNow: vi.fn(async (request: unknown) => ({ action: request })),
}));
const disposeServiceMock = vi.hoisted(() => vi.fn());

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
  disposeScheduledThreadActionService: disposeServiceMock,
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
    expect(disposeServiceMock).toHaveBeenCalledTimes(1);
  });
});
