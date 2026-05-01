import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appEventHandlers = new Map<string, (...args: unknown[]) => void>();
const createMainWindowMock = vi.fn();
const registerAppServerIpcHandlersMock = vi.fn();
const disposeAppServerIpcHandlersMock = vi.fn();
const registerAgentIpcHandlersMock = vi.fn();
const disposeAgentIpcHandlersMock = vi.fn();
const registerApplicationIpcHandlersMock = vi.fn();
const disposeApplicationIpcHandlersMock = vi.fn();
const registerImageNormalizationIpcHandlersMock = vi.fn();
const disposeImageNormalizationIpcHandlersMock = vi.fn();
const registerPreloadLogIpcHandlersMock = vi.fn();
const disposePreloadLogIpcHandlersMock = vi.fn();
const registerRendererErrorIpcHandlersMock = vi.fn();
const registerRuntimeIdentityIpcHandlersMock = vi.fn();
const disposeRuntimeIdentityIpcHandlersMock = vi.fn();
const registerSettingsIpcHandlersMock = vi.fn();
const disposeSettingsIpcHandlersMock = vi.fn();
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

vi.mock("../ipc/applications", () => ({
  registerApplicationIpcHandlers: registerApplicationIpcHandlersMock,
  disposeApplicationIpcHandlers: disposeApplicationIpcHandlersMock,
}));

vi.mock("../ipc/image-normalization", () => ({
  registerImageNormalizationIpcHandlers: registerImageNormalizationIpcHandlersMock,
  disposeImageNormalizationIpcHandlers: disposeImageNormalizationIpcHandlersMock,
}));

vi.mock("../ipc/preload-log", () => ({
  registerPreloadLogIpcHandlers: registerPreloadLogIpcHandlersMock,
  disposePreloadLogIpcHandlers: disposePreloadLogIpcHandlersMock,
}));

vi.mock("../ipc/renderer-error", () => ({
  registerRendererErrorIpcHandlers: registerRendererErrorIpcHandlersMock,
}));

vi.mock("../ipc/runtime-identity", () => ({
  registerRuntimeIdentityIpcHandlers: registerRuntimeIdentityIpcHandlersMock,
  disposeRuntimeIdentityIpcHandlers: disposeRuntimeIdentityIpcHandlersMock,
}));

vi.mock("../ipc/settings", () => ({
  registerSettingsIpcHandlers: registerSettingsIpcHandlersMock,
  disposeSettingsIpcHandlers: disposeSettingsIpcHandlersMock,
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
    registerApplicationIpcHandlersMock.mockReset();
    disposeApplicationIpcHandlersMock.mockReset();
    registerImageNormalizationIpcHandlersMock.mockReset();
    disposeImageNormalizationIpcHandlersMock.mockReset();
    registerPreloadLogIpcHandlersMock.mockReset();
    disposePreloadLogIpcHandlersMock.mockReset();
    registerRendererErrorIpcHandlersMock.mockReset();
    registerRuntimeIdentityIpcHandlersMock.mockReset();
    disposeRuntimeIdentityIpcHandlersMock.mockReset();
    registerSettingsIpcHandlersMock.mockReset();
    disposeSettingsIpcHandlersMock.mockReset();
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
    vi.unstubAllEnvs();
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
    expect(registerApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerImageNormalizationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerPreloadLogIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRendererErrorIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(registerRuntimeIdentityIpcHandlersMock).toHaveBeenCalledTimes(1);
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

  it("does not register runtime identity IPC in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    startupProfilerInstance.start.mockResolvedValue();

    await import("../index");
    await flushMicrotasks();

    expect(registerRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();

    appEventHandlers.get("before-quit")?.();
    expect(disposeApplicationIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeSettingsIpcHandlersMock).toHaveBeenCalledTimes(1);
    expect(disposeRuntimeIdentityIpcHandlersMock).not.toHaveBeenCalled();
  });
});
