import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusStarMapWindow } from "../../../e2e/fixtures/star-map-window";

const { poll } = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: { poll } }));

const MAP_URL = "file:///fixture/index.html#star-map";
function nativeWindow(url: string) {
  return { webContents: { getURL: () => url }, show: vi.fn(), focus: vi.fn() };
}

function fixture(windows: ReturnType<typeof nativeWindow>[]) {
  const browserWindow = vi.fn(async () => {
    throw new Error("electronApplication.browserWindow: Resulting promise was garbage collected.");
  });
  const evaluate = vi.fn(async (
    callback: (electron: { BrowserWindow: { getAllWindows: () => typeof windows } }, url: string) => unknown,
    url: string,
  ) => callback({ BrowserWindow: { getAllWindows: () => windows } }, url));
  const map = {
    url: () => MAP_URL,
    evaluate: vi.fn(async () => windows.some((win) => win.webContents.getURL() === MAP_URL && win.focus.mock.calls.length > 0)
      ? "visible/true" : "hidden/false"),
  };
  return {
    app: { electronApp: { browserWindow, evaluate } }, map, browserWindow, evaluate,
  };
}

async function focus(state: ReturnType<typeof fixture>): Promise<void> {
  await focusStarMapWindow(
    state.app as unknown as Parameters<typeof focusStarMapWindow>[0],
    state.map as unknown as Parameters<typeof focusStarMapWindow>[1],
  );
}

describe("Star Map E2E native focus", () => {
  beforeEach(() => {
    poll.mockReset();
    poll.mockImplementation((read: () => Promise<unknown>) => ({
      toBe: async (value: unknown) => expect(await read()).toBe(value),
    }));
  });

  it("focuses only the map in one main-process call without obtaining a remote native handle", async () => {
    const main = nativeWindow("file:///fixture/index.html");
    const map = nativeWindow(MAP_URL);
    const state = fixture([main, map]);
    await focus(state);
    expect(state.browserWindow).not.toHaveBeenCalled();
    expect(state.evaluate).toHaveBeenCalledOnce();
    expect(await state.evaluate.mock.results[0].value).toBeUndefined();
    expect(map.show).toHaveBeenCalledOnce();
    expect(map.focus).toHaveBeenCalledOnce();
    expect(main.show).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
    expect(state.map.evaluate).toHaveBeenCalledOnce();
  });

  it("still requires the map renderer to confirm foreground focus", async () => {
    const state = fixture([nativeWindow(MAP_URL)]);
    state.map.evaluate.mockResolvedValue("hidden/false");
    await expect(focus(state)).rejects.toThrow("visible/true");
    expect(state.map.evaluate).toHaveBeenCalledOnce();
  });

  it.each([0, 2])("refuses to focus a different window when %i windows match the map", async (count) => {
    const main = nativeWindow("file:///fixture/index.html");
    const windows = [main, ...Array.from({ length: count }, () => nativeWindow(MAP_URL))];
    await expect(focus(fixture(windows))).rejects.toThrow(`Expected one native Star Map window, found ${count}`);
    for (const win of windows) expect(win.focus).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });
});
