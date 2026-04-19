import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appEventHandlers = new Map<string, (...args: unknown[]) => void>();
const createMainWindowMock = vi.fn();
const registerAppServerIpcHandlersMock = vi.fn();
const disposeAppServerIpcHandlersMock = vi.fn();
const registerAgentIpcHandlersMock = vi.fn();
const disposeAgentIpcHandlersMock = vi.fn();
const initializeMainLoggerMock = vi.fn();
const setApplicationMenuMock = vi.fn();
const buildFromTemplateMock = vi.fn(() => ({ kind: "menu" }));
const setNameMock = vi.fn();
const whenReadyMock = vi.fn(() => Promise.resolve());
const getAllWindowsMock = vi.fn(() => []);
const startupProfilerInstance = {
  start: vi.fn<() => Promise<void>>(),
  attachWindow: vi.fn(),
};
const StartupCpuProfilerMock = vi.fn(function StartupCpuProfiler() {
  return startupProfilerInstance;
});

vi.mock("electron", () => ({
  app: {
    setName: setNameMock,
    whenReady: whenReadyMock,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appEventHandlers.set(event, handler);
    }),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  Menu: {
    setApplicationMenu: setApplicationMenuMock,
    buildFromTemplate: buildFromTemplateMock,
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock("../window", () => ({
  createMainWindow: createMainWindowMock,
}));

vi.mock("../ipc/app-server", () => ({
  registerAppServerIpcHandlers: registerAppServerIpcHandlersMock,
  disposeAppServerIpcHandlers: disposeAppServerIpcHandlersMock,
}));

vi.mock("../ipc/agent-ipc", () => ({
  registerAgentIpcHandlers: registerAgentIpcHandlersMock,
  disposeAgentIpcHandlers: disposeAgentIpcHandlersMock,
}));

vi.mock("../log", () => ({
  initializeMainLogger: initializeMainLoggerMock,
}));

vi.mock("../diagnostics/startup-cpu-profiler", () => ({
  StartupCpuProfiler: StartupCpuProfilerMock,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("bootstrapApp", () => {
  beforeEach(() => {
    appEventHandlers.clear();
    createMainWindowMock.mockReset();
    registerAppServerIpcHandlersMock.mockReset();
    disposeAppServerIpcHandlersMock.mockReset();
    registerAgentIpcHandlersMock.mockReset();
    disposeAgentIpcHandlersMock.mockReset();
    initializeMainLoggerMock.mockReset();
    setApplicationMenuMock.mockReset();
    buildFromTemplateMock.mockClear();
    setNameMock.mockReset();
    whenReadyMock.mockReset();
    whenReadyMock.mockReturnValue(Promise.resolve());
    getAllWindowsMock.mockReset();
    getAllWindowsMock.mockReturnValue([]);
    startupProfilerInstance.start.mockReset();
    startupProfilerInstance.attachWindow.mockReset();
    StartupCpuProfilerMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("awaits startup CPU profiling before creating the first window", async () => {
    let resolveStart!: () => void;
    startupProfilerInstance.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    await import("../index");
    await flushMicrotasks();

    expect(StartupCpuProfilerMock).toHaveBeenCalledTimes(1);
    expect(startupProfilerInstance.start).toHaveBeenCalledTimes(1);
    expect(createMainWindowMock).not.toHaveBeenCalled();

    resolveStart();
    await flushMicrotasks();

    expect(createMainWindowMock).toHaveBeenCalledWith({
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(registerAppServerIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerAgentIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(setApplicationMenuMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the same startup CPU profiler on app activate", async () => {
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    const activateHandler = appEventHandlers.get("activate");
    expect(activateHandler).toBeTypeOf("function");
    if (!activateHandler) {
      return;
    }

    activateHandler();

    expect(createMainWindowMock).toHaveBeenNthCalledWith(1, {
      startupCpuProfiler: startupProfilerInstance,
    });
    expect(createMainWindowMock).toHaveBeenNthCalledWith(2, {
      startupCpuProfiler: startupProfilerInstance,
    });
  });
});
