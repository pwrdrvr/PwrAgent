import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FACTORY_OPEN_THREAD_CHANNEL, FACTORY_OPEN_WINDOW_CHANNEL, FACTORY_PROJECT_READ_CHANNEL, FACTORY_PROJECTS_CHANNEL,
} from "../../shared/ipc";
import { disposeFactoryIpcHandlers, registerFactoryIpcHandlers } from "../shell/ipc/factory-ipc";
import { registerWindowChannels, WINDOW_KIND_FACTORY, WINDOW_KIND_MAIN } from "../shell/window-channels";

type Invoke = { sender: { mainFrame: object }; senderFrame: object | undefined };

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: Invoke, request?: unknown) => unknown>(),
  showFactoryWindow: vi.fn(),
  primary: vi.fn(),
  route: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (name: string, handler: (event: Invoke, request?: unknown) => unknown) => mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
}));
vi.mock("../shell/factory-window", () => ({ showFactoryWindow: mocks.showFactoryWindow }));
vi.mock("../shell/primary-main-window", () => ({ primaryMainWindowWebContents: mocks.primary }));
vi.mock("../shell/window-show-thread", () => ({ requestShowThread: mocks.route }));

const windows: EventEmitter[] = [];
function windowFrame(kind: typeof WINDOW_KIND_MAIN | typeof WINDOW_KIND_FACTORY, remote = false) {
  const window = Object.assign(new EventEmitter(), { webContents: { mainFrame: {} } });
  windows.push(window);
  registerWindowChannels(window as unknown as BrowserWindow, kind, [], remote
    ? { scope: "remote", instanceId: "pwr_00000000-0000-4000-a000-000000000042" }
    : undefined);
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function invoke(channel: string, event: Invoke, data?: unknown) {
  return mocks.handlers.get(channel)!(event, data);
}

const read = vi.fn();
const list = vi.fn();
const reference = "pwragent://thread/fixture-review?backend=codex&messageId=review-proof";

beforeEach(() => {
  registerFactoryIpcHandlers({ readFactoryProject: read, listFactoryProjects: list });
});

afterEach(() => {
  for (const window of windows.splice(0)) window.emit("closed");
  disposeFactoryIpcHandlers();
  vi.resetAllMocks();
});

it("limits reads, enumeration and window creation to their authorized top-level senders", () => {
  const local = windowFrame(WINDOW_KIND_MAIN);
  const remote = windowFrame(WINDOW_KIND_MAIN, true);
  const factory = windowFrame(WINDOW_KIND_FACTORY);
  const subframe = { ...factory, senderFrame: {} };
  const mainSubframe = { ...local, senderFrame: {} };

  invoke(FACTORY_PROJECT_READ_CHANNEL, local, { repository: "Aster" });
  invoke(FACTORY_PROJECT_READ_CHANNEL, factory, { repository: "Aster" });
  expect(read).toHaveBeenCalledTimes(2);
  for (const denied of [remote, subframe, mainSubframe, { ...factory, senderFrame: undefined }]) {
    expect(() => invoke(FACTORY_PROJECT_READ_CHANNEL, denied)).toThrow("local operator");
  }
  expect(read).toHaveBeenCalledTimes(2);

  invoke(FACTORY_PROJECTS_CHANNEL, factory);
  for (const denied of [local, remote, subframe]) {
    expect(() => invoke(FACTORY_PROJECTS_CHANNEL, denied)).toThrow("Factory window");
  }
  expect(list).toHaveBeenCalledOnce();

  invoke(FACTORY_OPEN_WINDOW_CHANNEL, local);
  for (const denied of [factory, remote, mainSubframe]) {
    expect(() => invoke(FACTORY_OPEN_WINDOW_CHANNEL, denied)).toThrow("local main window");
  }
  expect(mocks.showFactoryWindow).toHaveBeenCalledOnce();
});

it("routes only local anchored evidence from the Factory top frame, without a fallback window", () => {
  const main = windowFrame(WINDOW_KIND_MAIN);
  const factory = windowFrame(WINDOW_KIND_FACTORY);
  mocks.primary.mockReturnValue(main.sender);
  mocks.route.mockReturnValue(main.sender);
  invoke(FACTORY_OPEN_THREAD_CHANNEL, factory, reference);
  expect(mocks.route).toHaveBeenLastCalledWith(
    { backend: "codex", threadId: "fixture-review", messageId: "review-proof" },
    { preferWebContents: main.sender, requirePreferred: true },
  );
  for (const invalid of [null, "https://github.com/", "pwragent://thread/thread", reference + "&profile=other",
    reference + "&instanceId=pwr_00000000-0000-4000-a000-000000000042"]) {
    expect(() => invoke(FACTORY_OPEN_THREAD_CHANNEL, factory, invalid)).toThrow("local thread link");
  }
  expect(() => invoke(FACTORY_OPEN_THREAD_CHANNEL, { ...factory, senderFrame: {} }, reference)).toThrow("Factory window");
  expect(() => invoke(FACTORY_OPEN_THREAD_CHANNEL, main, reference)).toThrow("Factory window");
  expect(mocks.route).toHaveBeenCalledOnce();

  mocks.route.mockReturnValue(undefined);
  expect(() => invoke(FACTORY_OPEN_THREAD_CHANNEL, factory, reference)).toThrow("Open the main PwrAgent window");
});
