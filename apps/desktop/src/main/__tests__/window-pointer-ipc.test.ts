import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const getContentBoundsMock = vi.fn();
const isFocusedMock = vi.fn();
const getCursorScreenPointMock = vi.fn();
const fromWebContentsMock = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  screen: {
    getCursorScreenPoint: getCursorScreenPointMock,
  },
}));

describe("window pointer ipc", () => {
  beforeEach(() => {
    handlers.clear();
    getContentBoundsMock.mockReset();
    getCursorScreenPointMock.mockReset();
    isFocusedMock.mockReset();
    fromWebContentsMock.mockReset();
  });

  it("returns cursor position and sender content bounds", async () => {
    const { registerWindowPointerIpcHandlers, disposeWindowPointerIpcHandlers } =
      await import("../ipc/window-pointer");
    const { WINDOW_POINTER_SNAPSHOT_CHANNEL } = await import("../../shared/ipc");

    getContentBoundsMock.mockReturnValue({
      height: 800,
      width: 1200,
      x: 100,
      y: 80,
    });
    getCursorScreenPointMock.mockReturnValue({
      x: 1180,
      y: 220,
    });
    isFocusedMock.mockReturnValue(false);
    fromWebContentsMock.mockReturnValue({
      getContentBounds: getContentBoundsMock,
      isFocused: isFocusedMock,
    });

    registerWindowPointerIpcHandlers();

    await expect(
      handlers.get(WINDOW_POINTER_SNAPSHOT_CHANNEL)?.({
        sender: { id: 1 },
      }),
    ).resolves.toEqual({
      contentBounds: {
        height: 800,
        width: 1200,
        x: 100,
        y: 80,
      },
      cursor: {
        x: 1180,
        y: 220,
      },
      windowFocused: false,
    });

    disposeWindowPointerIpcHandlers();
    expect(handlers.has(WINDOW_POINTER_SNAPSHOT_CHANNEL)).toBe(false);
  });
});
